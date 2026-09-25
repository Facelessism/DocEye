import { promises as fs } from "node:fs";
import path from "node:path";
import { minVersion, satisfies, validRange } from "semver";
import { parse as parseYaml } from "yaml";
import type { PackageManager } from "./types";

/**
 * Repository inspection. Everything here reads file metadata and contents;
 * nothing is executed, and every path is confined to the repository root.
 */

export type PathKind = "file" | "directory" | "missing" | "outside";

export type NodeDeclaration = {
  /** Where the declaration came from, e.g. "package.json engines.node". */
  source: string;
  value: string;
  /** Lowest Node major the declaration allows, when it can be determined. */
  minMajor?: number;
};

export type PackageJsonFacts = {
  name?: string;
  scripts: Record<string, string>;
  /** dependencies, devDependencies, optionalDependencies and peerDependencies names. */
  dependencies: Set<string>;
  hasWorkspaces: boolean;
};

export type RepoFacts = {
  /** Real (symlink-resolved) absolute path of the repository root. */
  root: string;
  /** "owner/name" when known. */
  slug?: string;
  rootEntries: Set<string>;
  packageJson?: PackageJsonFacts;
  /** Workspace packages declared by package.json `workspaces` or pnpm-workspace.yaml (root excluded). */
  workspaces: Array<{ dir: string; name?: string }>;
  packageManagers: Array<{ name: PackageManager; source: string }>;
  node: NodeDeclaration[];
  /** Base names of files in .github/workflows. */
  workflows: string[];
  dockerfiles: string[];
  composeFiles: string[];
  licenseFiles: string[];
  licenses: Array<{ id: string; source: string }>;
  /** Non-fatal problems found while reading facts (e.g. unparsable package.json). */
  problems: string[];
};

const MAX_TEXT_BYTES = 5 * 1024 * 1024;
const SKIPPED_DIRS = new Set(["node_modules", ".git"]);

// ---------------------------------------------------------------------------
// Safe filesystem access
// ---------------------------------------------------------------------------

/** Normalize a repo-relative POSIX path. Returns undefined if absolute or escaping the root. */
export function toRepoPath(input: string): string | undefined {
  if (input.includes("\0") || input.startsWith("/")) return undefined;
  const normalized = path.posix.normalize(input.replace(/\/+$/, "") || ".");
  if (normalized === ".." || normalized.startsWith("../")) return undefined;
  return normalized;
}

export function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

function isMissingError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP" || code === "ENAMETOOLONG";
}

export async function pathKind(root: string, rel: string): Promise<PathKind> {
  const normalized = toRepoPath(rel);
  if (normalized === undefined) return "outside";
  try {
    const real = await fs.realpath(path.join(root, normalized));
    if (!isInside(root, real)) return "outside";
    return (await fs.stat(real)).isDirectory() ? "directory" : "file";
  } catch (error) {
    if (isMissingError(error)) return "missing";
    throw error;
  }
}

/** Read a regular file inside the repository. Undefined when missing or outside the root. */
export async function readTextInside(root: string, rel: string, maxBytes = MAX_TEXT_BYTES): Promise<string | undefined> {
  if ((await pathKind(root, rel)) !== "file") return undefined;
  const real = await fs.realpath(path.join(root, rel));
  const stat = await fs.stat(real);
  if (stat.size > maxBytes) throw new Error(`${rel} is larger than ${maxBytes} bytes`);
  return fs.readFile(real, "utf8");
}

async function listDir(root: string, rel: string): Promise<string[]> {
  if ((await pathKind(root, rel)) !== "directory") return [];
  const real = await fs.realpath(path.join(root, rel));
  return (await fs.readdir(real)).sort();
}

/**
 * Markdown files under `entry` (a file or directory), in sorted order.
 * Symlinks are not followed, `node_modules` and `.git` are skipped, and the
 * walk is bounded.
 */
export async function listMarkdownFiles(root: string, entry: string, limit = 200): Promise<string[]> {
  const start = toRepoPath(entry);
  if (start === undefined) return [];
  const kind = await pathKind(root, start);
  if (kind === "file") return isMarkdown(start) ? [start] : [];
  if (kind !== "directory") return [];

  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    const real = await fs.realpath(path.join(root, dir));
    const entries = (await fs.readdir(real, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const item of entries) {
      if (found.length >= limit) return;
      const child = path.posix.join(dir, item.name);
      if (item.isDirectory() && depth < 6 && !SKIPPED_DIRS.has(item.name)) await walk(child, depth + 1);
      else if (item.isFile() && isMarkdown(item.name)) found.push(child);
    }
  };
  await walk(start, 0);
  return found;
}

function isMarkdown(name: string): boolean {
  return /\.(md|markdown)$/i.test(name);
}

// ---------------------------------------------------------------------------
// Version and license parsing
// ---------------------------------------------------------------------------

/**
 * Lowest major version an npm-style range allows, or undefined if the range
 * is invalid or has no lower bound ("<22", "*", "lts/*").
 */
export function minMajorOfRange(range: string): number | undefined {
  const trimmed = range.trim();
  if (trimmed === "") return undefined;
  const valid = validRange(trimmed, { loose: true });
  if (valid === null || satisfies("0.0.0", valid, { loose: true })) return undefined;
  return minVersion(valid, { loose: true })?.major;
}

function majorOfVersionFile(text: string): number | undefined {
  const line = text.split(/\r?\n/).find((l) => l.trim() !== "" && !l.trim().startsWith("#"));
  const m = line ? /^v?(\d+)/.exec(line.trim()) : null;
  return m ? Number(m[1]) : undefined;
}

/** Normalize an SPDX-ish id: drop -only / -or-later / + suffixes. */
export function normalizeLicenseId(id: string): string {
  return id.trim().replace(/(-only|-or-later|\+)$/i, "");
}

export function licenseIdsFromExpression(expression: string): string[] {
  return expression
    .split(/\s+(?:OR|AND|WITH)\s+|[()]/i)
    .map((part) => normalizeLicenseId(part))
    .filter((part) => part !== "");
}

/** Identify a license from the text of a license file. Undefined if not recognized. */
export function detectLicense(text: string): string | undefined {
  const t = text.slice(0, 20000);
  if (/GNU AFFERO GENERAL PUBLIC LICENSE/i.test(t)) return "AGPL-3.0";
  if (/GNU LESSER GENERAL PUBLIC LICENSE/i.test(t)) return /Version 2\.1/i.test(t) ? "LGPL-2.1" : "LGPL-3.0";
  if (/GNU GENERAL PUBLIC LICENSE/i.test(t)) return /Version 2,/i.test(t) ? "GPL-2.0" : "GPL-3.0";
  if (/Apache License/i.test(t) && /Version 2\.0/i.test(t)) return "Apache-2.0";
  if (/Mozilla Public License,? (?:Version|v\.?) ?2\.0/i.test(t)) return "MPL-2.0";
  if (/free and unencumbered software released into the public domain/i.test(t)) return "Unlicense";
  if (/Permission is hereby granted, free of charge, to any person obtaining a copy/i.test(t)) return "MIT";
  if (/Redistribution and use in source and binary forms/i.test(t)) {
    return /Neither the name of|endorse or promote/i.test(t) ? "BSD-3-Clause" : "BSD-2-Clause";
  }
  if (/Permission to use, copy, modify, and\/or distribute this software for any purpose/i.test(t)) return "ISC";
  return undefined;
}

function slugFromRepositoryField(value: unknown): string | undefined {
  const url = typeof value === "string" ? value : (value as { url?: unknown } | null)?.url;
  if (typeof url !== "string") return undefined;
  const m =
    /github\.com[/:]([^/\s]+)\/([^/\s#]+?)(?:\.git)?(?:[#/].*)?$/i.exec(url) ?? /^(?:github:)?([\w.-]+)\/([\w.-]+)$/.exec(url);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

// ---------------------------------------------------------------------------
// Fact collection
// ---------------------------------------------------------------------------

const LOCKFILES: Record<string, PackageManager> = {
  "pnpm-lock.yaml": "pnpm",
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
  "yarn.lock": "yarn",
  "bun.lock": "bun",
  "bun.lockb": "bun",
  "pnpm-workspace.yaml": "pnpm",
  ".yarnrc.yml": "yarn",
  ".yarnrc": "yarn",
  "bunfig.toml": "bun",
};
const PM_NAMES = new Set<string>(["npm", "pnpm", "yarn", "bun"]);

const isDockerfile = (name: string): boolean => {
  const n = name.toLowerCase();
  return n === "dockerfile" || n.startsWith("dockerfile.") || n.endsWith(".dockerfile");
};
const isComposeFile = (name: string): boolean => /^(?:docker-)?compose(?:\.[\w-]+)?\.ya?ml$/i.test(name);

export async function readRepository(rootInput: string, slug?: string): Promise<RepoFacts> {
  const root = await fs.realpath(rootInput);
  const problems: string[] = [];
  const rootList = await listDir(root, ".");
  const rootEntries = new Set(rootList);

  const read = async (rel: string, maxBytes?: number): Promise<string | undefined> => {
    try {
      return await readTextInside(root, rel, maxBytes);
    } catch (error) {
      problems.push(`${rel} could not be read: ${(error as Error).message}`);
      return undefined;
    }
  };

  const facts: RepoFacts = {
    root,
    rootEntries,
    workspaces: [],
    packageManagers: [],
    node: [],
    workflows: [],
    dockerfiles: [],
    composeFiles: [],
    licenseFiles: [],
    licenses: [],
    problems,
  };
  if (slug !== undefined) facts.slug = slug;

  // package.json
  let pkg: Record<string, unknown> | undefined;
  const pkgText = await read("package.json");
  if (pkgText !== undefined) {
    try {
      const parsed: unknown = JSON.parse(pkgText);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) pkg = parsed as Record<string, unknown>;
      else problems.push("package.json does not contain a JSON object");
    } catch (error) {
      problems.push(`package.json is not valid JSON: ${(error as Error).message}`);
    }
  }
  if (pkg) {
    facts.packageJson = readPackageJson(pkg);
    if (facts.slug === undefined) {
      const fromPkg = slugFromRepositoryField(pkg["repository"]);
      if (fromPkg !== undefined) facts.slug = fromPkg;
    }
  }

  collectPackageManagers(facts, pkg);
  facts.workspaces = await discoverWorkspaces(root, workspacePatterns(pkg, await read("pnpm-workspace.yaml", 65536), problems));
  await collectNodeDeclarations(facts, pkg, read);

  facts.workflows = (await listDir(root, ".github/workflows")).filter((n) => /\.ya?ml$/i.test(n));

  for (const name of rootList) {
    if (isDockerfile(name)) facts.dockerfiles.push(name);
    if (isComposeFile(name)) facts.composeFiles.push(name);
  }
  for (const name of await listDir(root, "docker")) {
    if (isDockerfile(name)) facts.dockerfiles.push(`docker/${name}`);
    if (isComposeFile(name)) facts.composeFiles.push(`docker/${name}`);
  }

  await collectLicenses(facts, pkg, read);
  return facts;
}

function readPackageJson(pkg: Record<string, unknown>): PackageJsonFacts {
  const name = typeof pkg["name"] === "string" ? pkg["name"] : undefined;
  const scripts: Record<string, string> = {};
  const rawScripts = pkg["scripts"];
  if (rawScripts && typeof rawScripts === "object") {
    for (const [name, value] of Object.entries(rawScripts)) if (typeof value === "string") scripts[name] = value;
  }
  const dependencies = new Set<string>();
  for (const key of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const group = pkg[key];
    if (group && typeof group === "object") for (const name of Object.keys(group)) dependencies.add(name);
  }
  return { ...(name !== undefined ? { name } : {}), scripts, dependencies, hasWorkspaces: pkg["workspaces"] !== undefined };
}

/** Read and parse `<dir>/package.json`. Undefined when missing, oversized, outside the repository or not an object. */
export async function loadPackage(root: string, dir: string): Promise<PackageJsonFacts | undefined> {
  try {
    const text = await readTextInside(root, path.posix.join(dir, "package.json"), 1024 * 1024);
    if (text === undefined) return undefined;
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? readPackageJson(parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Workspaces (monorepos)
// ---------------------------------------------------------------------------

const MAX_WORKSPACES = 200;

function workspacePatterns(pkg: Record<string, unknown> | undefined, pnpmYaml: string | undefined, problems: string[]): string[] {
  const patterns: string[] = [];
  const declared = pkg?.["workspaces"];
  const fromPackage = Array.isArray(declared) ? declared : (declared as { packages?: unknown } | undefined)?.packages;
  if (Array.isArray(fromPackage)) patterns.push(...fromPackage.filter((p): p is string => typeof p === "string"));

  if (pnpmYaml !== undefined) {
    try {
      const parsed = parseYaml(pnpmYaml, { maxAliasCount: 10 }) as { packages?: unknown } | null;
      if (Array.isArray(parsed?.packages)) patterns.push(...parsed.packages.filter((p): p is string => typeof p === "string"));
    } catch (error) {
      problems.push(`pnpm-workspace.yaml is not valid YAML: ${(error as Error).message}`);
    }
  }
  return patterns;
}

async function subdirectories(root: string, dir: string): Promise<string[]> {
  if ((await pathKind(root, dir)) !== "directory") return [];
  const real = await fs.realpath(path.join(root, dir));
  const entries = await fs.readdir(real, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !SKIPPED_DIRS.has(e.name))
    .map((e) => e.name)
    .sort();
}

const segmentPattern = (segment: string): RegExp =>
  new RegExp(`^${segment.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`);

async function expandPattern(root: string, pattern: string): Promise<string[]> {
  let current = ["."];
  for (const segment of pattern.replace(/^\.\//, "").split("/").filter(Boolean)) {
    const next: string[] = [];
    for (const base of current) {
      if (segment === "**") {
        const queue = [base];
        for (let depth = 0; depth < 4 && queue.length > 0 && next.length < 500; depth++) {
          const layer = queue.splice(0);
          for (const dir of layer) {
            next.push(dir);
            for (const name of await subdirectories(root, dir)) queue.push(path.posix.join(dir, name));
          }
        }
      } else if (segment.includes("*")) {
        const re = segmentPattern(segment);
        for (const name of await subdirectories(root, base)) if (re.test(name)) next.push(path.posix.join(base, name));
      } else {
        next.push(path.posix.join(base, segment));
      }
    }
    current = [...new Set(next)].slice(0, 500);
  }
  return current;
}

/** Resolve workspace globs (`packages/*`, `apps/**`, `!excluded`) to directories that contain a package.json. */
export async function discoverWorkspaces(root: string, patterns: string[]): Promise<Array<{ dir: string; name?: string }>> {
  const include = patterns.filter((p) => !p.startsWith("!"));
  const exclude = patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1).replace(/^\.\//, "").replace(/\/+$/, ""));
  const excluded = (dir: string): boolean =>
    exclude.some((e) => new RegExp(`^${e.split("**").map((part) => part.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*")}$`).test(dir));

  const dirs = new Set<string>();
  for (const pattern of include) {
    for (const dir of await expandPattern(root, pattern)) {
      if (dir !== "." && !dir.startsWith("..") && !excluded(dir)) dirs.add(dir);
    }
  }

  const found: Array<{ dir: string; name?: string }> = [];
  for (const dir of [...dirs].sort()) {
    if (found.length >= MAX_WORKSPACES) break;
    const pkg = await loadPackage(root, dir);
    if (pkg) found.push({ dir, ...(pkg.name !== undefined ? { name: pkg.name } : {}) });
  }
  return found;
}

/** A bounded, sorted list of files in the repository (no dependency or build directories), for suggestions. */
export async function listFiles(root: string, limit = 5000): Promise<string[]> {
  const skipped = new Set([...SKIPPED_DIRS, "dist", "dist-cli", "build", "out", "coverage", "target", ".next", ".nuxt", ".output"]);
  const files: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    const real = await fs.realpath(path.join(root, dir));
    const entries = (await fs.readdir(real, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= limit) return;
      const child = path.posix.join(dir, entry.name);
      if (entry.isDirectory() && depth < 8 && !skipped.has(entry.name)) await walk(child, depth + 1);
      else if (entry.isFile()) files.push(child);
    }
  };
  await walk(".", 0);
  return files;
}

/**
 * Write a text file inside the repository: the parent directory is created,
 * its real path must stay inside the root (no symlink escapes), and the write
 * is atomic (temporary file, then rename).
 */
export async function writeTextInside(root: string, rel: string, content: string): Promise<void> {
  const normalized = toRepoPath(rel);
  if (normalized === undefined || normalized === ".") throw new Error(`refusing to write outside the repository: ${rel}`);
  const target = path.join(root, normalized);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const parent = await fs.realpath(path.dirname(target));
  if (!isInside(root, parent)) throw new Error(`refusing to write outside the repository: ${rel}`);
  const finalPath = path.join(parent, path.basename(target));
  const temp = `${finalPath}.${process.pid}.tmp`;
  await fs.writeFile(temp, content, { flag: "wx" });
  try {
    await fs.rename(temp, finalPath);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

function collectPackageManagers(facts: RepoFacts, pkg: Record<string, unknown> | undefined): void {
  const add = (name: string, source: string): void => {
    if (PM_NAMES.has(name)) facts.packageManagers.push({ name: name as PackageManager, source });
  };

  const declared = pkg?.["packageManager"];
  if (typeof declared === "string") add(declared.split("@")[0] ?? "", `package.json packageManager "${declared}"`);

  const dev = (pkg?.["devEngines"] as { packageManager?: unknown } | undefined)?.packageManager;
  for (const entry of Array.isArray(dev) ? dev : dev ? [dev] : []) {
    const name = (entry as { name?: unknown }).name;
    if (typeof name === "string") add(name, `package.json devEngines.packageManager "${name}"`);
  }

  const engines = pkg?.["engines"];
  if (engines && typeof engines === "object") {
    for (const name of Object.keys(engines)) if (name !== "node") add(name, `package.json engines.${name}`);
  }

  for (const [file, manager] of Object.entries(LOCKFILES)) {
    if (facts.rootEntries.has(file)) add(manager, file);
  }
  if (facts.rootEntries.has(".yarn")) add("yarn", ".yarn/");
}

async function collectNodeDeclarations(
  facts: RepoFacts,
  pkg: Record<string, unknown> | undefined,
  read: (rel: string, maxBytes?: number) => Promise<string | undefined>,
): Promise<void> {
  const push = (source: string, value: string, minMajor: number | undefined): void => {
    facts.node.push({ source, value, ...(minMajor !== undefined ? { minMajor } : {}) });
  };

  const engines = (pkg?.["engines"] as { node?: unknown } | undefined)?.node;
  if (typeof engines === "string") push("package.json engines.node", engines, minMajorOfRange(engines));

  const volta = (pkg?.["volta"] as { node?: unknown } | undefined)?.node;
  if (typeof volta === "string") push("package.json volta.node", volta, majorOfVersionFile(volta));

  for (const file of [".nvmrc", ".node-version"]) {
    const text = await read(file, 4096);
    if (text !== undefined) push(file, text.trim(), majorOfVersionFile(text));
  }

  const tools = await read(".tool-versions", 65536);
  const line = tools?.split(/\r?\n/).find((l) => /^\s*(?:nodejs|node)\s+/.test(l));
  if (line !== undefined) {
    const version = line.trim().split(/\s+/)[1] ?? "";
    push(".tool-versions", version, majorOfVersionFile(version));
  }
}

async function collectLicenses(
  facts: RepoFacts,
  pkg: Record<string, unknown> | undefined,
  read: (rel: string, maxBytes?: number) => Promise<string | undefined>,
): Promise<void> {
  const licenseName = /^(?:LICEN[CS]E|COPYING|UNLICENSE)(?:[.-][\w.-]*)?$/i;
  for (const name of [...facts.rootEntries].sort()) {
    if (!licenseName.test(name) || (await pathKind(facts.root, name)) !== "file") continue;
    facts.licenseFiles.push(name);
    const text = await read(name, 200_000);
    const id = text === undefined ? undefined : detectLicense(text);
    if (id !== undefined) facts.licenses.push({ id, source: name });
  }

  const declared = pkg?.["license"];
  const expression = typeof declared === "string" ? declared : (declared as { type?: unknown } | undefined)?.type;
  if (typeof expression === "string" && expression.toUpperCase() !== "SEE LICENSE IN LICENSE") {
    for (const id of licenseIdsFromExpression(expression)) {
      facts.licenses.push({ id, source: `package.json license "${expression}"` });
    }
  }
}
