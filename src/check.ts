import { promises as fs } from "node:fs";
import { loadLinkCache, saveLinkCache, type LinkCache } from "./cache";
import { checkNodeCommands } from "./checks/commands";
import { checkDocker } from "./checks/docker";
import { checkLicense } from "./checks/license";
import { checkExternalLinks, checkLocalLinks } from "./checks/links";
import { checkPackageManager, checkPackageScripts } from "./checks/packages";
import { checkConfigFiles, checkPathReferences } from "./checks/paths";
import { checkRuntime } from "./checks/runtime";
import { memoizeAsync, type CheckContext } from "./checks/shared";
import { checkWorkflows } from "./checks/workflows";
import { cachePath, ConfigError, isIgnored, loadConfig, type Config } from "./config";
import type { Transport } from "./http";
import { parseMarkdown } from "./markdown";
import { shouldFail } from "./report";
import { listFiles, listMarkdownFiles, loadPackage, pathKind, readRepository, readTextInside, toRepoPath } from "./repository";
import { SEVERITY_RANK, type DocModel, type FailOn, type Finding } from "./types";

export type RunOptions = {
  /** Repository root (the checked-out workspace). */
  root: string;
  /** Overrides discovery of .doceye.yml / doceye.yml. */
  configPath?: string;
  /** Overrides `readme` from the config file. */
  readme?: string;
  /** `false` disables external link checking even if the config enables it. */
  externalLinks?: boolean;
  /** Overrides `fail-on` from the config file. */
  failOn?: FailOn;
  /** "owner/name" of the repository; used to recognize workflow badge URLs that belong to it. */
  slug?: string;
  /** Overrides `external-links.cache-file`: where successful link results are remembered between runs. */
  cacheFile?: string;
  /** Test seam for network access. */
  transport?: Transport;
  backoffMs?: number;
  /** Test seam for the clock used by the link cache. */
  now?: () => number;
};

export type Report = {
  /** Real path of the repository root that was analyzed. */
  root: string;
  findings: Finding[];
  config: Config;
  configPath?: string;
  docsChecked: string[];
  failOn: FailOn;
  failed: boolean;
};

const meta = (severity: Finding["severity"], message: string, file?: string): Finding => ({
  rule: "doceye",
  severity,
  message,
  ...(file !== undefined ? { file } : {}),
});

async function collectDocs(root: string, config: Config, findings: Finding[]): Promise<DocModel[]> {
  const readmePath = toRepoPath(config.readme);
  if (readmePath === undefined) throw new ConfigError(`readme path must stay inside the repository: ${config.readme}`);

  const files: string[] = [];
  if ((await pathKind(root, readmePath)) === "file") files.push(readmePath);
  else findings.push(meta("warning", `README file not found: ${readmePath}. Only other documentation was checked.`));

  for (const entry of config.docs) {
    for (const file of await listMarkdownFiles(root, entry)) if (!files.includes(file)) files.push(file);
  }

  const docs: DocModel[] = [];
  for (const file of files) {
    if (isIgnored(config, file, undefined)) continue;
    try {
      const text = await readTextInside(root, file);
      if (text !== undefined) docs.push(parseMarkdown(file, text));
    } catch (error) {
      findings.push(meta("notice", `Skipped ${file}: ${(error as Error).message}`, file));
    }
  }
  return docs;
}

function orderFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const unique = findings.filter((f) => {
    const key = JSON.stringify([f.rule, f.file, f.line, f.column, f.message]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.sort(
    (a, b) =>
      (a.file ?? "\uffff").localeCompare(b.file ?? "\uffff") ||
      (a.line ?? 0) - (b.line ?? 0) ||
      (a.column ?? 0) - (b.column ?? 0) ||
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      a.rule.localeCompare(b.rule) ||
      a.message.localeCompare(b.message),
  );
}

/** Run every enabled check against the repository at `options.root`. No GitHub required. */
export async function runDocEye(options: RunOptions): Promise<Report> {
  const root = await fs.realpath(options.root);
  const { config, path: configPath } = await loadConfig(root, options.configPath);
  if (options.readme !== undefined) config.readme = options.readme;
  if (options.externalLinks === false) config.externalLinks.enabled = false;
  const failOn = options.failOn ?? config.failOn;

  const repo = await readRepository(root, options.slug);
  const findings: Finding[] = repo.problems.map((problem) => meta("notice", problem));
  const docs = await collectDocs(root, config, findings);
  const readmeFile = toRepoPath(config.readme);
  const readme = docs.find((d) => d.file === readmeFile);

  let filesPromise: Promise<string[]> | undefined;
  const ctx: CheckContext = {
    repo,
    docs,
    config,
    kindOf: memoizeAsync((rel: string) => pathKind(root, rel)),
    packageAt: memoizeAsync((dir: string) => loadPackage(root, dir)),
    files: () => (filesPromise ??= listFiles(root)),
    ...(readme ? { readme } : {}),
    ...(options.transport ? { transport: options.transport } : {}),
    ...(options.backoffMs !== undefined ? { backoffMs: options.backoffMs } : {}),
  };

  // Remember successful external link results between runs, if a cache file is configured.
  const settings = config.externalLinks;
  const cacheRel = options.cacheFile !== undefined ? cachePath(options.cacheFile) : settings.cacheFile;
  let linkCache: LinkCache | undefined;
  if (cacheRel !== undefined && settings.enabled && config.rules["external-links"] !== "off" && settings.cacheHours > 0) {
    const loaded = await loadLinkCache(root, cacheRel, settings.cacheHours, options.now);
    linkCache = loaded.cache;
    ctx.linkCache = linkCache;
    if (loaded.problem) findings.push(meta("notice", loaded.problem));
  }

  findings.push(
    ...(await checkLocalLinks(ctx)),
    ...checkPackageManager(ctx),
    ...(await checkPackageScripts(ctx)),
    ...(await checkNodeCommands(ctx)),
    ...(await checkPathReferences(ctx)),
    ...(await checkConfigFiles(ctx)),
    ...checkRuntime(ctx),
    ...checkWorkflows(ctx),
    ...(await checkDocker(ctx)),
    ...checkLicense(ctx),
    ...(await checkExternalLinks(ctx)),
  );

  if (linkCache && cacheRel !== undefined) {
    const problem = await saveLinkCache(root, cacheRel, linkCache);
    if (problem) findings.push(meta("notice", problem));
  }

  const kept = orderFindings(findings.filter((f) => !isIgnored(config, f.file, f.subject)));
  return {
    root,
    findings: kept,
    config,
    ...(configPath !== undefined ? { configPath } : {}),
    docsChecked: docs.map((d) => d.file),
    failOn,
    failed: shouldFail(kept, failOn),
  };
}
