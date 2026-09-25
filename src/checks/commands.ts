import path from "node:path";
import { toRepoPath } from "../repository";
import { suggestPath } from "../suggest";
import type { Finding } from "../types";
import { alsoAt, groupBy, isGeneratedPath, joinDetails, locationOf, severityOf, type CheckContext } from "./shared";

/** Flags of `node` that consume the following token. */
const NODE_VALUE_FLAGS = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "--env-file"]);
/** Flags after which the argument is code or a different mode, not a script path. */
const NODE_NON_FILE_FLAGS = new Set(["-e", "--eval", "-p", "--print", "-c", "--check", "--test", "--watch", "-i", "--interactive"]);

/**
 * The script file of a `node <file>` command, when the command clearly runs a
 * repository-relative JavaScript/TypeScript file. Undefined otherwise.
 */
export function nodeScriptPath(tokens: string[]): string | undefined {
  if (tokens[0] !== "node") return undefined;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i] as string;
    if (NODE_NON_FILE_FLAGS.has(token)) return undefined;
    if (NODE_VALUE_FLAGS.has(token)) {
      i++;
      continue;
    }
    if (token.startsWith("-")) continue;
    if (!/\.[cm]?[jt]sx?$/.test(token) || /[$*{}<>%~`]/.test(token) || path.posix.isAbsolute(token)) return undefined;
    return token;
  }
  return undefined;
}

export async function checkNodeCommands(ctx: CheckContext): Promise<Finding[]> {
  const severity = severityOf(ctx, "commands");
  if (!severity) return [];

  const refs: Array<{ cmd: (typeof ctx.docs)[number]["commands"][number]; target: string }> = [];
  for (const doc of ctx.docs) {
    for (const cmd of doc.commands) {
      const script = nodeScriptPath(cmd.tokens);
      // Relative to where the documentation says the command runs (after any `cd`).
      const target = script === undefined ? undefined : toRepoPath(path.posix.join(cmd.cwd, script));
      if (target !== undefined && !isGeneratedPath(target)) refs.push({ cmd, target });
    }
  }

  const findings: Finding[] = [];
  for (const [first, ...others] of groupBy(refs, (r) => `${r.cmd.file}\0${r.target}`)) {
    if (!first) continue;
    if ((await ctx.kindOf(first.target)) !== "missing") continue;
    const near = suggestPath(first.target, await ctx.files());
    findings.push({
      rule: "commands",
      severity,
      message: `${first.cmd.file} runs "${first.cmd.tokens.join(" ")}", but ${first.target} does not exist.`,
      ...locationOf(first.cmd),
      subject: first.target,
      details: joinDetails(
        "Commands in documentation are assumed to run from the repository root.",
        alsoAt(others.map((o) => o.cmd)),
      ),
      ...(near !== undefined ? { suggestion: `Did you mean ${near}?` } : {}),
    });
  }
  return findings;
}
