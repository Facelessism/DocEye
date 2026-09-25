import * as core from "@actions/core";
import * as github from "@actions/github";
import { runDocEye, type RunOptions } from "./check";
import { ConfigError, isFailOn } from "./config";
import type { FailOn } from "./types";
import { emitAnnotations, upsertSummaryComment } from "./github";
import { formatJson, formatSarif } from "./output";
import { writeTextInside } from "./repository";
import { COMMENT_MARKER, countBySeverity, formatComment, formatText } from "./report";
import { VERSION } from "./version";

export const DEFAULT_README = "README.md";
export const DEFAULT_FAIL_ON: FailOn = "error";

/** The action.yml inputs this needs, read as plain strings/booleans so the mapping below is testable without @actions/core. */
export type ActionInputs = {
  readme: string;
  config: string;
  checkExternalLinks: boolean;
  failOn: string;
  cacheFile: string;
};

export type ActionEnv = { workspace?: string; repository?: string; cwd: string };

/**
 * Map action.yml inputs (and the environment GitHub sets) to `RunOptions`.
 * An input left at its documented default does not override whatever the
 * repository's own config file says, so a config file's `readme`, `fail-on`,
 * etc. still take effect for someone who left the corresponding action.yml
 * input unset. Pure and independent of @actions/core so this precedence can
 * be tested directly, without a fake GitHub runtime.
 */
export function buildRunOptions(inputs: ActionInputs, env: ActionEnv): RunOptions {
  if (!isFailOn(inputs.failOn)) {
    throw new ConfigError(`fail-on must be one of: error, warning, notice, none (got "${inputs.failOn}")`);
  }
  const options: RunOptions = { root: env.workspace ?? env.cwd };
  if (inputs.readme !== DEFAULT_README) options.readme = inputs.readme;
  if (inputs.config !== "") options.configPath = inputs.config;
  if (!inputs.checkExternalLinks) options.externalLinks = false;
  if (inputs.failOn !== DEFAULT_FAIL_ON) options.failOn = inputs.failOn;
  if (inputs.cacheFile !== "") options.cacheFile = inputs.cacheFile;
  if (env.repository) options.slug = env.repository;
  return options;
}

async function run(): Promise<void> {
  const options = buildRunOptions(
    {
      readme: core.getInput("readme") || DEFAULT_README,
      config: core.getInput("config"),
      checkExternalLinks: core.getBooleanInput("check-external-links"),
      failOn: core.getInput("fail-on") || DEFAULT_FAIL_ON,
      cacheFile: core.getInput("cache-file"),
    },
    { workspace: process.env["GITHUB_WORKSPACE"], repository: process.env["GITHUB_REPOSITORY"], cwd: process.cwd() },
  );

  const report = await runDocEye(options);
  const { findings } = report;

  core.info(formatText(findings));
  const omitted = emitAnnotations(findings, core);
  if (omitted > 0) {
    core.info(`${omitted} more finding${omitted === 1 ? " was" : "s were"} not annotated because GitHub limits annotations per step. See the log above and the job summary.`);
  }
  core.setOutput("findings-count", String(findings.length));
  await core.summary.addRaw(formatComment(findings, 200)).write();

  // Machine-readable reports are written inside the workspace, e.g. for github/codeql-action/upload-sarif.
  const reports: Array<[string, () => string]> = [
    [core.getInput("json-file"), () => formatJson(report, VERSION)],
    [core.getInput("sarif-file"), () => formatSarif(findings, VERSION)],
  ];
  for (const [file, render] of reports) {
    if (file === "") continue;
    try {
      await writeTextInside(report.root, file, render());
    } catch (error) {
      core.warning(`Could not write ${file}: ${(error as Error).message}`);
    }
  }

  const pullRequest = github.context.payload.pull_request;
  const token = core.getInput("github-token");
  if (core.getBooleanInput("comment") && pullRequest && token) {
    try {
      const outcome = await upsertSummaryComment(
        github.getOctokit(token),
        { ...github.context.repo, issue_number: pullRequest.number },
        formatComment(findings),
        COMMENT_MARKER,
        findings.length > 0,
      );
      core.debug(`Pull request comment: ${outcome}`);
    } catch (error) {
      // Fork pull requests get a read-only token; that must not fail the check.
      core.warning(`Could not post the DocEye summary comment: ${(error as Error).message}`);
    }
  }

  if (report.failed) {
    const counts = countBySeverity(findings);
    const n = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;
    core.setFailed(
      `DocEye found documentation issues at or above "${report.failOn}" ` +
        `(${n(counts.error, "error")}, ${n(counts.warning, "warning")}, ${n(counts.notice, "notice")}).`,
    );
  }
}

// Only run automatically when this file is the entry point GitHub invokes (dist/index.js), not
// when it is imported for its exports, e.g. buildRunOptions in tests.
if (require.main === module) {
  run().catch((error: unknown) => {
    core.setFailed(error instanceof Error ? error.message : String(error));
  });
}
