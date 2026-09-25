import path from "node:path";
import type { RepoFacts } from "../repository";
import { closestMatch, closestScript } from "../suggest";
import type { DocCommand, Finding, PackageManager, Verification } from "../types";
import { alsoAt, groupBy, joinDetails, locationOf, quote, severityOf, type CheckContext } from "./shared";

/** Where a command applies when it is not simply "the package in the current directory". */
export type Scope =
  | { kind: "dir"; path: string }
  | { kind: "workspace"; selector: string }
  | { kind: "all" };

export type PackageCommand =
  | { manager: PackageManager; kind: "install"; scope?: Scope }
  | { manager: PackageManager; kind: "script"; script: string; shorthand: boolean; scope?: Scope };

const MANAGERS = new Set<string>(["npm", "pnpm", "yarn", "bun"]);

const PNPM_BUILTINS = new Set([
  "add", "install", "i", "update", "up", "upgrade", "remove", "rm", "uninstall", "un", "link", "ln", "unlink",
  "import", "rebuild", "rb", "prune", "fetch", "install-test", "it", "patch", "patch-commit", "patch-remove",
  "publish", "pack", "list", "ls", "ll", "la", "outdated", "why", "audit", "licenses", "exec", "dlx", "create",
  "env", "store", "root", "bin", "setup", "self-update", "init", "deploy", "doctor", "config", "c", "get", "set",
  "cache", "approve-builds", "dedupe", "server", "sbom", "help", "stop", "restart",
]);

const YARN_BUILTINS = new Set([
  "add", "audit", "autoclean", "bin", "cache", "check", "config", "constraints", "create", "dedupe", "dlx", "exec",
  "explain", "generate-lock-entry", "global", "help", "import", "info", "init", "install", "licenses", "link",
  "list", "login", "logout", "node", "npm", "outdated", "owner", "pack", "patch", "patch-commit", "plugin",
  "publish", "rebuild", "remove", "search", "set", "stage", "tag", "team", "unlink", "unplug", "up", "upgrade",
  "upgrade-interactive", "version", "versions", "why", "workspace", "workspaces",
]);

/** Selectors and paths containing these cannot be resolved statically (globs, `...` graphs, negations, variables). */
const UNRESOLVABLE = /[*?[\]{}!^$`<>%]|\.\.\./;

type ParsedArgs = { positional: string[]; scope?: Scope };

/** Split arguments into positionals and an optional scope. Undefined means "do not check this command". */
function parseArgs(manager: PackageManager, args: string[]): ParsedArgs | undefined {
  const positional: string[] = [];
  let scope: Scope | undefined;
  let conflict = false;
  const setScope = (next: Scope): void => {
    if (scope !== undefined) conflict = true;
    scope = next;
  };
  const dirScope = (value: string | undefined): boolean => {
    if (value === undefined || UNRESOLVABLE.test(value) || value.startsWith("/") || value.startsWith("~")) return false;
    setScope({ kind: "dir", path: path.posix.normalize(value) });
    return true;
  };
  const workspaceScope = (value: string | undefined): boolean => {
    if (value === undefined || UNRESOLVABLE.test(value)) return false;
    setScope({ kind: "workspace", selector: value });
    return true;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (!arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const value = (): string | undefined => (eq === -1 ? args[++i] : arg.slice(eq + 1));

    // Global installs are not about this project, and --if-present makes a missing script legal.
    if (flag === "-g" || flag === "--global" || flag === "--if-present") return undefined;

    let ok = true;
    if (manager === "npm") {
      if (flag === "-w" || flag === "--workspace") ok = workspaceScope(value());
      else if (flag === "--workspaces" || flag === "-ws") setScope({ kind: "all" });
      else if (flag === "--prefix") ok = dirScope(value());
    } else if (manager === "pnpm") {
      if (flag === "--filter" || flag === "-F") ok = workspaceScope(value());
      else if (flag === "-r" || flag === "--recursive") setScope({ kind: "all" });
      else if (flag === "-C" || flag === "--dir") ok = dirScope(value());
    } else if (manager === "yarn") {
      if (flag === "--cwd") ok = dirScope(value());
    } else if (flag === "--filter" || flag === "-F") ok = workspaceScope(value());
    else if (flag === "--cwd") ok = dirScope(value());

    if (!ok) return undefined;
  }
  return conflict ? undefined : { positional, ...(scope !== undefined ? { scope } : {}) };
}

/**
 * Recognize project-level install and script-running commands. Returns
 * undefined for anything else (global installs, `npm install some-package`,
 * commands whose target cannot be resolved statically, ...), which is
 * deliberate: unrecognized means unchecked.
 */
export function classifyPackageCommand(tokens: string[]): PackageCommand | undefined {
  const manager = tokens[0];
  if (manager === undefined || !MANAGERS.has(manager)) return undefined;
  const m = manager as PackageManager;

  const dashDash = tokens.indexOf("--");
  const parsed = parseArgs(m, tokens.slice(1, dashDash === -1 ? undefined : dashDash));
  if (!parsed) return undefined;
  let { positional, scope } = parsed;
  if (positional.some((a) => /[$*{}<>%`]/.test(a))) return undefined;

  // `yarn workspace <name> <command>` scopes the command that follows.
  let yarnWorkspace = false;
  if (m === "yarn" && positional[0] === "workspace") {
    const name = positional[1];
    if (name === undefined || UNRESOLVABLE.test(name) || scope !== undefined) return undefined;
    scope = { kind: "workspace", selector: name };
    positional = positional.slice(2);
    yarnWorkspace = true;
  }
  const sub = positional[0];
  const withScope = <T extends object>(command: T): T & { scope?: Scope } => (scope ? { ...command, scope } : command);

  const script = (name: string | undefined, shorthand: boolean): PackageCommand | undefined =>
    name === undefined || name.includes("/") || /\.(?:[cm]?[jt]sx?)$/.test(name)
      ? undefined
      : withScope({ manager: m, kind: "script" as const, script: name, shorthand });

  if (m === "yarn" && sub === undefined) return yarnWorkspace ? undefined : withScope({ manager: m, kind: "install" as const });
  if (sub === undefined) return undefined;

  const bareInstall = positional.length === 1;
  if (m === "npm" && ["install", "i", "ci"].includes(sub)) return bareInstall ? withScope({ manager: m, kind: "install" as const }) : undefined;
  if (m !== "npm" && ["install", "i"].includes(sub) && (m !== "yarn" || sub === "install")) {
    return bareInstall ? withScope({ manager: m, kind: "install" as const }) : undefined;
  }

  if (m === "bun") return sub === "run" ? script(positional[1], false) : undefined;

  if (["run", "run-script", ...(m === "npm" ? ["rum", "urn"] : [])].includes(sub)) return script(positional[1], false);
  if (sub === "test" || (sub === "t" && m !== "yarn")) return script("test", true);
  if (sub === "start") return script("start", true);
  if (m === "pnpm" && !PNPM_BUILTINS.has(sub)) return script(sub, true);
  if (m === "yarn" && !YARN_BUILTINS.has(sub)) return script(sub, true);
  return undefined;
}

type ClassifiedCommand = { doc: DocCommand; command: PackageCommand };

function packageCommands(ctx: CheckContext): ClassifiedCommand[] {
  const out: ClassifiedCommand[] = [];
  for (const doc of ctx.docs) {
    for (const cmd of doc.commands) {
      const command = classifyPackageCommand(cmd.tokens);
      if (command) out.push({ doc: cmd, command });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Package manager
// ---------------------------------------------------------------------------

export function verifyPackageManagerClaim(manager: PackageManager, repo: RepoFacts): Verification {
  if (repo.packageManagers.length === 0) return { verdict: "unknown" };
  const evidence = repo.packageManagers.map((e) => e.source).join("; ");
  const supports = repo.packageManagers.some((e) => e.name === manager);
  return { verdict: supports ? "supported" : "contradicted", evidence };
}

/** The same command for another package manager, e.g. `npm run build` -> `pnpm run build`. */
function translate(command: PackageCommand, manager: string): string {
  return command.kind === "install" ? `${manager} install` : `${manager} run ${command.script}`;
}

export function checkPackageManager(ctx: CheckContext): Finding[] {
  const severity = severityOf(ctx, "package-manager");
  if (!severity || ctx.repo.packageManagers.length === 0) return [];
  const findings: Finding[] = [];
  const names = [...new Set(ctx.repo.packageManagers.map((e) => e.name))];
  const indicated = names.join(" / ");
  const only = names.length === 1 ? names[0] : undefined;

  const used = packageCommands(ctx).filter(
    ({ command }) => verifyPackageManagerClaim(command.manager, ctx.repo).verdict === "contradicted",
  );
  for (const [first, ...others] of groupBy(used, (u) => `${u.doc.file}\0${u.command.manager}`)) {
    if (!first) continue;
    const { doc, command } = first;
    findings.push({
      rule: "package-manager",
      severity,
      message: `${doc.file} uses ${command.manager} ("${doc.tokens.join(" ")}"), but repository configuration indicates ${indicated}.`,
      ...locationOf(doc),
      subject: command.manager,
      details: joinDetails(
        `Repository evidence: ${verifyPackageManagerClaim(command.manager, ctx.repo).evidence}.`,
        alsoAt(others.map((o) => o.doc)),
      ),
      ...(only !== undefined && !command.scope ? { suggestion: `Use ${quote(translate(command, only))} instead.` } : {}),
    });
  }

  for (const { file, line, column, claim } of ctx.readme?.claims ?? []) {
    if (claim.kind !== "package-manager") continue;
    const result = verifyPackageManagerClaim(claim.manager, ctx.repo);
    if (result.verdict !== "contradicted") continue;
    findings.push({
      rule: "package-manager",
      severity,
      message: `${file} says the project uses ${claim.manager}, but repository configuration indicates ${indicated}.`,
      file,
      line,
      column,
      subject: claim.manager,
      details: `Repository evidence: ${result.evidence}.`,
      ...(only !== undefined ? { suggestion: `Update the documentation to say ${only}.` } : {}),
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Package scripts
// ---------------------------------------------------------------------------

type ScriptCommand = { doc: DocCommand; manager: PackageManager; script: string; scope?: Scope };

type Target =
  | { type: "package"; dir: string; scripts: Record<string, string>; dependencies: Set<string> }
  | { type: "all"; packages: Array<{ scripts: Record<string, string> }> }
  | { type: "unknown-workspace"; selector: string };

/** Work out which package.json a documented command runs against. Undefined when that cannot be known. */
async function resolveTarget(ctx: CheckContext, cmd: ScriptCommand): Promise<Target | undefined> {
  const { scope } = cmd;
  const load = async (dir: string): Promise<Target | undefined> => {
    const pkg = await ctx.packageAt(dir);
    return pkg ? { type: "package", dir, scripts: pkg.scripts, dependencies: pkg.dependencies } : undefined;
  };

  if (scope === undefined) return load(cmd.doc.cwd);

  if (scope.kind === "dir") {
    const dir = path.posix.normalize(path.posix.join(cmd.doc.cwd, scope.path));
    return dir === ".." || dir.startsWith("../") ? undefined : load(dir);
  }

  if (scope.kind === "workspace") {
    const asPath = path.posix.normalize(scope.selector.replace(/^\.\//, ""));
    const workspace = ctx.repo.workspaces.find((w) => w.name === scope.selector || w.dir === asPath);
    if (workspace) return load(workspace.dir);
    // Only claim a workspace is unknown when the repository actually defines workspaces.
    return ctx.repo.workspaces.length > 0 ? { type: "unknown-workspace", selector: scope.selector } : undefined;
  }

  const packages = [];
  for (const dir of [".", ...ctx.repo.workspaces.map((w) => w.dir)]) {
    const pkg = await ctx.packageAt(dir);
    if (pkg) packages.push(pkg);
  }
  return packages.length > 0 ? { type: "all", packages } : undefined;
}

export async function checkPackageScripts(ctx: CheckContext): Promise<Finding[]> {
  const severity = severityOf(ctx, "package-scripts");
  if (!severity) return [];

  const rootPackage = await ctx.packageAt(".");
  const findings: Finding[] = [];
  const problems: Array<{ cmd: ScriptCommand; target: Target }> = [];

  for (const { doc, command } of packageCommands(ctx)) {
    if (command.kind !== "script") continue;
    const cmd: ScriptCommand = { doc, manager: command.manager, script: command.script, ...(command.scope ? { scope: command.scope } : {}) };
    const target = await resolveTarget(ctx, cmd);
    if (!target) continue;

    if (target.type === "unknown-workspace") {
      problems.push({ cmd, target });
    } else if (target.type === "all") {
      if (!target.packages.some((p) => Object.hasOwn(p.scripts, cmd.script))) problems.push({ cmd, target });
    } else if (!Object.hasOwn(target.scripts, cmd.script)) {
      // `yarn tsc` / `pnpm eslint` run binaries from dependencies, not scripts.
      const isBinary = cmd.manager !== "npm" && (target.dependencies.has(cmd.script) || rootPackage?.dependencies.has(cmd.script) === true);
      // npm's documented default when no "start" script exists.
      const isDefaultStart =
        cmd.manager === "npm" && cmd.script === "start" && (await ctx.kindOf(path.posix.join(target.dir, "server.js"))) === "file";
      if (!isBinary && !isDefaultStart) problems.push({ cmd, target });
    }
  }

  const keyOf = ({ cmd, target }: (typeof problems)[number]): string =>
    `${cmd.doc.file}\0${target.type === "package" ? target.dir : target.type}\0${cmd.script}\0${target.type === "unknown-workspace" ? target.selector : ""}`;

  for (const [first, ...others] of groupBy(problems, keyOf)) {
    if (!first) continue;
    const { cmd, target } = first;
    const also = alsoAt(others.map((o) => o.cmd.doc));
    const base = { rule: "package-scripts", severity, ...locationOf(cmd.doc) };

    if (target.type === "unknown-workspace") {
      const known = ctx.repo.workspaces.map((w) => w.name ?? w.dir);
      const near = closestMatch(target.selector, [...known, ...ctx.repo.workspaces.map((w) => w.dir)]);
      findings.push({
        ...base,
        message: `${cmd.doc.file} references workspace "${target.selector}", but no such workspace exists.`,
        subject: target.selector,
        details: joinDetails(`Command: ${cmd.doc.tokens.join(" ")}.`, `Workspaces: ${known.join(", ")}.`, also),
        ...(near !== undefined ? { suggestion: `Did you mean the workspace "${near}"?` } : {}),
      });
      continue;
    }

    if (target.type === "all") {
      findings.push({
        ...base,
        message: `${cmd.doc.file} references package script "${cmd.script}", but no workspace package defines it.`,
        subject: cmd.script,
        details: joinDetails(`Command: ${cmd.doc.tokens.join(" ")}.`, also),
      });
      continue;
    }

    const pkgFile = target.dir === "." ? "package.json" : `${target.dir}/package.json`;
    const defined = Object.keys(target.scripts);
    const near = closestScript(cmd.script, defined);
    findings.push({
      ...base,
      message: `${cmd.doc.file} references package script "${cmd.script}", but ${pkgFile} does not define it.`,
      subject: cmd.script,
      details: joinDetails(
        `Command: ${cmd.doc.tokens.join(" ")}.`,
        defined.length > 0 ? `Scripts defined in ${pkgFile}: ${defined.join(", ")}.` : `${pkgFile} defines no scripts.`,
        also,
      ),
      ...(near !== undefined ? { suggestion: `Did you mean the script "${near}"?` } : {}),
    });
  }
  return findings;
}
