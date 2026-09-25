import path from "node:path";
import { toRepoPath } from "../repository";
import { closestMatch, suggestPath } from "../suggest";
import type { DocCommand, Finding } from "../types";
import { capSeverity, DOCKER_FILE_NAMES, groupBy, isGeneratedOrPlaceholder, locationOf, looksLikeCreation, severityOf, type CheckContext } from "./shared";

const BUILD_VALUE_FLAGS = new Set([
  "-t", "--tag", "-f", "--file", "--build-arg", "--target", "--platform", "--label", "--cache-from", "--cache-to",
  "--secret", "--ssh", "-o", "--output", "--progress", "--network", "--add-host", "--iidfile", "--builder",
  "--build-context", "--shm-size", "--ulimit", "-m", "--memory", "--provenance", "--sbom",
]);
const COMPOSE_VALUE_FLAGS = new Set([
  "-f", "--file", "-p", "--project-name", "--profile", "--env-file", "--ansi", "--progress", "--parallel", "--context",
]);
const COMPOSE_SUBCOMMANDS = new Set([
  "up", "down", "build", "run", "start", "stop", "restart", "logs", "ps", "exec", "pull", "push", "config", "watch", "kill", "rm", "top",
]);

export type DockerBuild = { dockerfile: string };
export type ComposeUse = { files: string[] };

function flagValue(args: string[], i: number, names: string[]): { value: string; consumed: number } | undefined {
  const arg = args[i] as string;
  for (const name of names) {
    if (arg === name) return args[i + 1] === undefined ? undefined : { value: args[i + 1] as string, consumed: 1 };
    if (arg.startsWith(`${name}=`)) return { value: arg.slice(name.length + 1), consumed: 0 };
  }
  return undefined;
}

/** The Dockerfile a `docker build` command reads, when it can be determined statically. */
export function parseDockerBuild(tokens: string[], cwd = "."): DockerBuild | undefined {
  let rest: string[];
  if (tokens[0] === "docker" && tokens[1] === "build") rest = tokens.slice(2);
  else if (tokens[0] === "docker" && (tokens[1] === "buildx" || tokens[1] === "image") && tokens[2] === "build") rest = tokens.slice(3);
  else return undefined;

  let file: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    const fileFlag = flagValue(rest, i, ["-f", "--file"]);
    if (fileFlag) {
      file = fileFlag.value;
      i += fileFlag.consumed;
    } else if (BUILD_VALUE_FLAGS.has(arg)) i++;
    else if (!arg.startsWith("-") || arg === "-") positional.push(arg);
  }

  const context = positional[positional.length - 1];
  const candidate = file ?? (context === undefined ? undefined : path.posix.join(context, "Dockerfile"));
  if (candidate === undefined || candidate === "-" || context === "-") return undefined;
  if (isGeneratedOrPlaceholder(candidate) || /:\/\/|^git@|^github\.com/.test(context ?? "")) return undefined;
  const dockerfile = toRepoPath(path.posix.join(cwd, candidate));
  return dockerfile === undefined ? undefined : { dockerfile };
}

/** Compose files a `docker compose` / `docker-compose` command uses; `[]` means the default lookup. */
export function parseCompose(tokens: string[]): ComposeUse | undefined {
  let rest: string[];
  if (tokens[0] === "docker" && tokens[1] === "compose") rest = tokens.slice(2);
  else if (tokens[0] === "docker-compose") rest = tokens.slice(1);
  else return undefined;

  const files: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (arg === "--project-directory" || arg.startsWith("--project-directory=")) return undefined;
    const fileFlag = flagValue(rest, i, ["-f", "--file"]);
    if (fileFlag) {
      files.push(fileFlag.value);
      i += fileFlag.consumed;
    } else if (COMPOSE_VALUE_FLAGS.has(arg)) i++;
    else if (!arg.startsWith("-")) return COMPOSE_SUBCOMMANDS.has(arg) ? { files } : undefined;
  }
  return undefined;
}

export async function checkDocker(ctx: CheckContext): Promise<Finding[]> {
  const severity = severityOf(ctx, "docker");
  if (!severity) return [];
  const findings: Finding[] = [];

  const commands: DocCommand[] = ctx.docs.flatMap((d) => d.commands);
  const flagged = new Set<string>();
  const report = (cmd: DocCommand, subject: string, message: string, details?: string, near?: string): void => {
    const key = `${cmd.file}:${cmd.line}:${subject}`;
    if (flagged.has(key)) return;
    flagged.add(key);
    findings.push({
      rule: "docker",
      severity,
      message,
      ...locationOf(cmd),
      subject,
      ...(details ? { details } : {}),
      ...(near !== undefined ? { suggestion: `Did you mean ${near}?` } : {}),
    });
  };
  const command = (cmd: DocCommand): string => `"${cmd.tokens.join(" ")}"`;

  for (const cmd of commands) {
    const build = parseDockerBuild(cmd.tokens, cmd.cwd);
    if (build && (await ctx.kindOf(build.dockerfile)) === "missing") {
      report(
        cmd,
        build.dockerfile,
        `${cmd.file} runs ${command(cmd)}, but ${build.dockerfile} does not exist.`,
        ctx.repo.dockerfiles.length > 0
          ? `Dockerfiles in the repository: ${ctx.repo.dockerfiles.join(", ")}.`
          : "The repository contains no Dockerfile in its root or docker/ directory.",
        suggestPath(build.dockerfile, ctx.repo.dockerfiles) ?? closestMatch(build.dockerfile, ctx.repo.dockerfiles),
      );
    }

    const compose = parseCompose(cmd.tokens);
    if (!compose) continue;
    if (compose.files.length === 0) {
      const defaults = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];
      const present = await Promise.all(defaults.map((name) => ctx.kindOf(path.posix.join(cmd.cwd, name))));
      if (!present.includes("file")) {
        const where = cmd.cwd === "." ? "the repository root" : cmd.cwd;
        report(
          cmd,
          "compose file",
          `${cmd.file} runs ${command(cmd)}, but no Compose file exists in ${where}.`,
          "Looked for compose.yaml, compose.yml, docker-compose.yaml and docker-compose.yml.",
          ctx.repo.composeFiles[0],
        );
      }
      continue;
    }
    for (const file of compose.files) {
      const target = file === "-" || isGeneratedOrPlaceholder(file) ? undefined : toRepoPath(path.posix.join(cmd.cwd, file));
      if (target !== undefined && (await ctx.kindOf(target)) === "missing") {
        report(cmd, target, `${cmd.file} runs ${command(cmd)}, but Compose file ${target} does not exist.`, undefined, suggestPath(target, ctx.repo.composeFiles));
      }
    }
  }

  // Inline references such as `Dockerfile` or `docker/compose.yml`.
  for (const doc of ctx.docs) {
    for (const code of doc.inlineCode) {
      const target = toRepoPath(code.value);
      if (target === undefined || code.insideLink || /\s/.test(code.value) || looksLikeCreation(code.before)) continue;
      if (!DOCKER_FILE_NAMES.has(path.posix.basename(target).toLowerCase())) continue;
      if ((await ctx.kindOf(target)) !== "missing") continue;
      const near = suggestPath(target, [...ctx.repo.dockerfiles, ...ctx.repo.composeFiles]);
      findings.push({
        rule: "docker",
        severity,
        message: `${doc.file} references ${target}, but it does not exist.`,
        ...locationOf(code),
        subject: target,
        ...(near !== undefined ? { suggestion: `Did you mean ${near}?` } : {}),
      });
    }
  }

  // "Docker is supported" is a softer claim than a concrete file reference.
  for (const { file, line, column, claim } of ctx.readme?.claims ?? []) {
    if (claim.kind !== "docker-support") continue;
    if (ctx.repo.dockerfiles.length + ctx.repo.composeFiles.length > 0) continue;
    findings.push({
      rule: "docker",
      severity: capSeverity(severity, "warning"),
      message: `${file} says Docker is supported, but the repository contains no Dockerfile or Compose file.`,
      file,
      line,
      column,
      subject: "docker support",
      details: "Looked in the repository root and docker/.",
    });
  }

  return groupBy(findings, (f) => `${f.file}:${f.line}:${f.subject}`).map((g) => g[0] as Finding);
}
