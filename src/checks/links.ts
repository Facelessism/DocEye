import path from "node:path";
import { isIgnored } from "../config";
import { checkUrl, mapWithLimit, type UrlResult } from "../http";
import { anchorsOf, parseMarkdown } from "../markdown";
import { readTextInside, toRepoPath } from "../repository";
import { closestMatch, suggestPath } from "../suggest";
import type { Finding, LinkRef } from "../types";
import { capSeverity, locationOf, severityOf, type CheckContext } from "./shared";

// ---------------------------------------------------------------------------
// Local links and anchors
// ---------------------------------------------------------------------------

/** `{ suggestion }` when a replacement was found, otherwise nothing. */
function didYouMean(candidate: string | undefined): { suggestion?: string } {
  return candidate === undefined ? {} : { suggestion: `Did you mean ${candidate}?` };
}

export type LocalTarget = { path: string; fragment: string };

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Split a link destination into path and fragment. Undefined for URLs and unverifiable placeholders. */
export function parseLocalTarget(url: string): LocalTarget | undefined {
  const trimmed = url.trim();
  if (trimmed === "" || trimmed.startsWith("//") || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return undefined;
  const hash = trimmed.indexOf("#");
  const fragment = hash >= 0 ? trimmed.slice(hash + 1) : "";
  const withoutFragment = hash >= 0 ? trimmed.slice(0, hash) : trimmed;
  const query = withoutFragment.indexOf("?");
  const rawPath = query >= 0 ? withoutFragment.slice(0, query) : withoutFragment;
  if (/[{}<>$*]/.test(rawPath)) return undefined;
  return { path: safeDecode(rawPath), fragment: safeDecode(fragment) };
}

/**
 * Resolve a link relative to the document containing it. Root-relative
 * ("/docs/a.md") links resolve against the repository root, as on GitHub.
 * Returns undefined when the result would leave the repository.
 */
export function resolveLocalPath(docFile: string, linkPath: string): string | undefined {
  if (linkPath === "") return docFile;
  if (linkPath.startsWith("/")) return toRepoPath(linkPath.replace(/^\/+/, "") || ".");
  return toRepoPath(path.posix.join(path.posix.dirname(docFile), linkPath));
}

export async function checkLocalLinks(ctx: CheckContext): Promise<Finding[]> {
  const linkSeverity = severityOf(ctx, "local-links");
  const anchorSeverity = severityOf(ctx, "anchors");
  if (!linkSeverity && !anchorSeverity) return [];

  const findings: Finding[] = [];
  const anchorCache = new Map<string, Set<string> | undefined>();

  const anchorsFor = async (repoPath: string): Promise<Set<string> | undefined> => {
    if (anchorCache.has(repoPath)) return anchorCache.get(repoPath);
    let anchors: Set<string> | undefined;
    const scanned = ctx.docs.find((d) => d.file === repoPath);
    if (scanned) anchors = anchorsOf(scanned);
    else if (/\.(md|markdown)$/i.test(repoPath)) {
      try {
        const text = await readTextInside(ctx.repo.root, repoPath);
        if (text !== undefined) anchors = anchorsOf(parseMarkdown(repoPath, text));
      } catch {
        anchors = undefined; // unreadable target: do not guess about its anchors
      }
    }
    anchorCache.set(repoPath, anchors);
    return anchors;
  };

  for (const doc of ctx.docs) {
    for (const link of doc.links) {
      const target = parseLocalTarget(link.url);
      if (!target) continue;
      const resolved = resolveLocalPath(doc.file, target.path);
      const written = target.path === "" ? `#${target.fragment}` : target.path;

      if (resolved === undefined) {
        if (linkSeverity) {
          findings.push({
            rule: "local-links",
            severity: linkSeverity,
            message: `Local link points outside the repository: ${written}`,
            ...locationOf(link),
            subject: target.path,
            details: `Resolved relative to ${doc.file}, the path leaves the repository root.`,
          });
        }
        continue;
      }
      if (isUnverifiableLocation(resolved)) continue;

      const kind = await ctx.kindOf(resolved);
      if (kind === "missing" || kind === "outside") {
        if (linkSeverity) {
          findings.push({
            rule: "local-links",
            severity: linkSeverity,
            message: `Broken local link: ${written}`,
            ...locationOf(link),
            subject: resolved,
            details: `No file or directory exists at "${resolved}" in the repository.`,
            ...didYouMean(suggestPath(resolved, await ctx.files())),
          });
        }
        continue;
      }

      if (anchorSeverity && kind === "file" && target.fragment !== "") {
        const finding = await anchorFinding(link, target, resolved, anchorSeverity, anchorsFor);
        if (finding) findings.push(finding);
      }
    }
  }
  return findings;
}

function isUnverifiableLocation(repoPath: string): boolean {
  return repoPath.startsWith("node_modules/") || repoPath.startsWith(".git/");
}

async function anchorFinding(
  link: LinkRef,
  target: { path: string; fragment: string },
  resolved: string,
  severity: NonNullable<ReturnType<typeof severityOf>>,
  anchorsFor: (repoPath: string) => Promise<Set<string> | undefined>,
): Promise<Finding | undefined> {
  const fragment = target.fragment.replace(/^user-content-/i, "").toLowerCase();
  if (fragment === "" || fragment === "top" || /^l\d+(-l?\d+)?$/.test(fragment)) return undefined; // line anchors
  const anchors = await anchorsFor(resolved);
  if (anchors === undefined || anchors.has(fragment)) return undefined;
  const known = [...anchors].slice(0, 10);
  const near = closestMatch(fragment, anchors);
  return {
    rule: "anchors",
    severity,
    message: `Anchor "#${target.fragment}" not found in ${resolved}`,
    ...locationOf(link),
    subject: `${resolved}#${target.fragment}`,
    details: known.length > 0 ? `Anchors defined there: ${known.join(", ")}.` : "That file defines no heading or HTML anchors.",
    ...(near !== undefined ? { suggestion: `Did you mean #${near}?` } : {}),
  };
}

// ---------------------------------------------------------------------------
// External links
// ---------------------------------------------------------------------------

const TOTAL_TIME_BUDGET_MS = 120_000;

export async function checkExternalLinks(ctx: CheckContext): Promise<Finding[]> {
  const level = severityOf(ctx, "external-links");
  const settings = ctx.config.externalLinks;
  if (!level || !settings.enabled) return [];

  // Group every occurrence by URL (fragment removed) so each URL is requested once.
  const occurrences = new Map<string, LinkRef[]>();
  for (const doc of ctx.docs) {
    for (const link of doc.links) {
      if (!/^https?:\/\//i.test(link.url) || isIgnored(ctx.config, link.file, link.url)) continue;
      let key: string;
      try {
        const url = new URL(link.url);
        url.hash = "";
        key = url.toString();
      } catch {
        continue;
      }
      const list = occurrences.get(key);
      if (list) list.push(link);
      else occurrences.set(key, [link]);
    }
  }

  const urls = [...occurrences.keys()];
  const resolved = new Map<string, UrlResult>();
  const pending: string[] = [];
  for (const url of urls) {
    const remembered = ctx.linkCache?.get(url);
    if (remembered) resolved.set(url, remembered);
    else pending.push(url);
  }

  // The URL cap bounds network use, so URLs answered from the cache do not count against it.
  const toCheck = pending.slice(0, settings.maxUrls);
  const deadline = Date.now() + TOTAL_TIME_BUDGET_MS;
  const results = await mapWithLimit(toCheck, settings.concurrency, (url) =>
    checkUrl(url, {
      timeoutMs: settings.timeoutMs,
      retries: settings.retries,
      deadline,
      ...(ctx.transport ? { transport: ctx.transport } : {}),
      ...(ctx.backoffMs !== undefined ? { backoffMs: ctx.backoffMs } : {}),
    }),
  );

  let outOfTime = 0;
  toCheck.forEach((url, index) => {
    const result = results[index] as UrlResult;
    if (result.kind === "skipped" && result.reason === "time budget exhausted") outOfTime++;
    ctx.linkCache?.set(url, result);
    resolved.set(url, result);
  });

  const findings: Finding[] = [];
  for (const [url, result] of resolved) {
    for (const link of occurrences.get(url) ?? []) {
      const finding = externalFinding(link, result, level);
      if (finding) findings.push(finding);
    }
  }

  const notChecked = pending.length - toCheck.length + outOfTime;
  if (notChecked > 0) {
    findings.push({
      rule: "external-links",
      severity: capSeverity(level, "notice"),
      message: `${notChecked} external URL${notChecked === 1 ? " was" : "s were"} not checked`,
      details: `At most ${settings.maxUrls} unique URLs are requested per run, within a ${TOTAL_TIME_BUDGET_MS / 1000}s budget.`,
    });
  }
  return findings;
}

function externalFinding(link: LinkRef, result: UrlResult, level: NonNullable<ReturnType<typeof severityOf>>): Finding | undefined {
  const base = { rule: "external-links", ...locationOf(link), subject: link.url };
  switch (result.kind) {
    case "broken":
      return { ...base, severity: level, message: `Broken external link: ${link.url}`, details: result.reason };
    case "unavailable":
      return {
        ...base,
        severity: capSeverity(level, "warning"),
        message: `External URL could not be verified: ${link.url}`,
        details: `${result.reason}. The server may be blocking automated requests or be temporarily unavailable.`,
      };
    case "unreachable":
      return {
        ...base,
        severity: capSeverity(level, "warning"),
        message: `External URL appears unreachable: ${link.url}`,
        details: result.reason,
      };
    case "redirect":
      return result.permanent
        ? {
            ...base,
            severity: capSeverity(level, "notice"),
            message: `External URL permanently redirects: ${link.url}`,
            details: `It now resolves to ${result.finalUrl}. Consider updating the link.`,
          }
        : undefined;
    default:
      return undefined;
  }
}
