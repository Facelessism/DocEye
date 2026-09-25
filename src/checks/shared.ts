import type { LinkCache } from "../cache";
import type { Config } from "../config";
import type { Transport } from "../http";
import type { PackageJsonFacts, PathKind, RepoFacts } from "../repository";
import { SEVERITY_RANK, type DocModel, type Finding, type RuleName, type Severity } from "../types";

export type CheckContext = {
  repo: RepoFacts;
  /** Every scanned documentation file; the README (if any) is first. */
  docs: DocModel[];
  /** The primary README. Claims (runtime, license, ...) are only verified against this file. */
  readme?: DocModel;
  config: Config;
  /** Injected in tests; defaults to a guarded node:http(s) transport. */
  transport?: Transport;
  /** Retry backoff for external links; tests set 0. */
  backoffMs?: number;
  /** Remembers successful external link results between runs. */
  linkCache?: LinkCache;
  /** Memoized existence lookup for a repo-relative path. */
  kindOf(rel: string): Promise<PathKind>;
  /** Memoized `<dir>/package.json` facts ("." is the root). */
  packageAt(dir: string): Promise<PackageJsonFacts | undefined>;
  /** Memoized, bounded list of repository files; only used to build suggestions. */
  files(): Promise<string[]>;
};

/** Directories that are normally build output; missing ones are not documentation drift. */
export const GENERATED_DIRS = new Set([
  "node_modules",
  "dist",
  "dist-cli",
  "build",
  "out",
  "coverage",
  "target",
  ".next",
  ".nuxt",
  ".output",
  "tmp",
  "temp",
]);

/** Base names (lowercase) of Docker files handled by the docker rule. */
export const DOCKER_FILE_NAMES = new Set(["dockerfile", "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]);

export function isGeneratedPath(repoPath: string): boolean {
  return GENERATED_DIRS.has(repoPath.split("/")[0] ?? "") || repoPath.startsWith(".git/");
}

/** The configured severity for a rule, or undefined when the rule is switched off. */
export function severityOf(ctx: CheckContext, rule: RuleName): Severity | undefined {
  const level = ctx.config.rules[rule];
  return level === "off" ? undefined : level;
}

/** Lower `level` to at most `max`. Used for findings that rest on uncertain evidence. */
export function capSeverity(level: Severity, max: Severity): Severity {
  return SEVERITY_RANK[level] > SEVERITY_RANK[max] ? max : level;
}

/** Group items by key, keeping first-seen order. Each group is [first, ...others]. */
export function groupBy<T>(items: T[], key: (item: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = groups.get(k);
    if (group) group.push(item);
    else groups.set(k, [item]);
  }
  return [...groups.values()];
}

export function alsoAt(others: Array<{ line: number }>): string {
  if (others.length === 0) return "";
  const lines = others.map((o) => o.line).join(", ");
  return `Also at line${others.length > 1 ? "s" : ""} ${lines}.`;
}

/** Cache the result of an async function per key. */
export function memoizeAsync<K, V>(fn: (key: K) => Promise<V>): (key: K) => Promise<V> {
  const cache = new Map<K, Promise<V>>();
  return (key) => {
    let hit = cache.get(key);
    if (hit === undefined) {
      hit = fn(key);
      cache.set(key, hit);
    }
    return hit;
  };
}

export function quote(value: string): string {
  return `"${value}"`;
}

export function joinDetails(...parts: Array<string | undefined>): string | undefined {
  const text = parts.filter((p): p is string => p !== undefined && p !== "").join(" ");
  return text === "" ? undefined : text;
}

/**
 * True when the prose just before a path suggests the file is being created,
 * copied or used as an example rather than referenced as existing.
 */
export function looksLikeCreation(before: string): boolean {
  const tail = before.slice(-40);
  return (
    /\b(?:create[sd]?|creating|add(?:s|ing)?|write|writing|save|saving|generate[sd]?|outputs?|produces?|new|your|example|like|named|called|as)\b/i.test(
      tail,
    ) || /\b(?:copy|cp|rename|move|mv)\b.*\bto\s*$/i.test(tail)
  );
}

export function isGeneratedOrPlaceholder(value: string): boolean {
  return /[*?{}<>$%\\]/.test(value) || /(^|\/)(path|to|your|my|foo|bar|example|examples)(\/|$)/i.test(value);
}

export function locationOf(ref: { file: string; line: number; column: number }): Pick<Finding, "file" | "line" | "column"> {
  return { file: ref.file, line: ref.line, column: ref.column };
}
