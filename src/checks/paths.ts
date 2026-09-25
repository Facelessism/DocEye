import path from "node:path";
import { pathKind, toRepoPath } from "../repository";
import { suggestPath } from "../suggest";
import type { Finding, Verification } from "../types";
import {
  alsoAt,
  DOCKER_FILE_NAMES,
  groupBy,
  isGeneratedOrPlaceholder,
  isGeneratedPath,
  joinDetails,
  locationOf,
  looksLikeCreation,
  severityOf,
  type CheckContext,
} from "./shared";

const EXTENSIONS = new Set([
  "md", "mdx", "markdown", "txt", "json", "jsonc", "yml", "yaml", "toml", "ini", "cfg", "conf", "xml",
  "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "py", "rb", "go", "rs", "java", "kt", "swift",
  "sh", "bash", "ps1", "css", "scss", "html", "sql", "png", "jpg", "jpeg", "gif", "svg",
]);

/**
 * The repository path an inline code span refers to, if it is safe to verify.
 * Deliberately narrow: needs a known file extension, no placeholders or globs,
 * no build-output directories, and either a directory component or a
 * config-looking file name (so prose like `index.js` in a tutorial is ignored).
 */
export function checkablePath(value: string): string | undefined {
  if (value.length > 200 || /\s/.test(value) || /^[/~@]/.test(value) || /:|\.\.\//.test(value)) return undefined;
  if (isGeneratedOrPlaceholder(value)) return undefined;
  const target = toRepoPath(value.replace(/^\.\//, ""));
  if (target === undefined || isGeneratedPath(target)) return undefined;
  const base = path.posix.basename(target);
  const ext = /\.([A-Za-z0-9]+)$/.exec(base)?.[1]?.toLowerCase();
  if (ext === undefined || !EXTENSIONS.has(ext)) return undefined;
  if (target.includes("/")) return target;
  const stem = base.slice(0, base.length - ext.length - 1);
  if (stem === "") return undefined; // a bare extension like ".json", not a real file name
  return /config/i.test(base) || base.startsWith(".") ? target : undefined;
}

export async function checkPathReferences(ctx: CheckContext): Promise<Finding[]> {
  const severity = severityOf(ctx, "paths");
  if (!severity) return [];

  const claimed = new Set(
    (ctx.readme?.claims ?? []).flatMap((c) => (c.claim.kind === "config-location" ? [`${c.file}:${c.line}:${c.claim.path}`] : [])),
  );

  const refs: Array<{ file: string; line: number; column: number; target: string }> = [];
  for (const doc of ctx.docs) {
    for (const code of doc.inlineCode) {
      if (code.insideLink || looksLikeCreation(code.before) || claimed.has(`${code.file}:${code.line}:${code.value}`)) continue;
      const target = checkablePath(code.value);
      if (target === undefined || target.startsWith(".github/workflows/") || DOCKER_FILE_NAMES.has(path.posix.basename(target).toLowerCase())) {
        continue;
      }
      refs.push({ file: code.file, line: code.line, column: code.column, target });
    }
  }

  const findings: Finding[] = [];
  for (const [first, ...others] of groupBy(refs, (r) => `${r.file}\0${r.target}`)) {
    if (!first || (await ctx.kindOf(first.target)) !== "missing") continue;
    const near = suggestPath(first.target, await ctx.files());
    findings.push({
      rule: "paths",
      severity,
      message: `${first.file} references ${first.target}, but it does not exist.`,
      ...locationOf(first),
      subject: first.target,
      details: joinDetails(`No file or directory exists at "${first.target}" in the repository.`, alsoAt(others)),
      ...(near !== undefined ? { suggestion: `Did you mean ${near}?` } : {}),
    });
  }
  return findings;
}

/** Verify "configuration lives in <path>" against the filesystem. */
export async function verifyConfigLocation(root: string, claimedPath: string): Promise<Verification & { path?: string }> {
  if (isGeneratedOrPlaceholder(claimedPath)) return { verdict: "unknown" };
  const target = toRepoPath(claimedPath.replace(/^\.\//, ""));
  if (target === undefined || isGeneratedPath(target)) return { verdict: "unknown" };
  const kind = await pathKind(root, target);
  if (kind === "outside") return { verdict: "unknown" };
  return {
    verdict: kind === "missing" ? "contradicted" : "supported",
    evidence: kind === "missing" ? `${target} does not exist` : `${target} exists`,
    path: target,
  };
}

export async function checkConfigFiles(ctx: CheckContext): Promise<Finding[]> {
  const severity = severityOf(ctx, "config-files");
  if (!severity) return [];
  const findings: Finding[] = [];
  for (const { file, line, column, claim } of ctx.readme?.claims ?? []) {
    if (claim.kind !== "config-location") continue;
    const result = await verifyConfigLocation(ctx.repo.root, claim.path);
    if (result.verdict !== "contradicted" || result.path === undefined) continue;
    findings.push({
      rule: "config-files",
      severity,
      message: `${file} says configuration lives in ${result.path}, but it does not exist.`,
      file,
      line,
      column,
      subject: result.path,
      details: `Repository evidence: ${result.evidence}.`,
    });
  }
  return findings;
}
