import { promises as fs } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { runDocEye, type RunOptions } from "./check";
import { ConfigError, isFailOn } from "./config";
import { formatJson, formatSarif } from "./output";
import { formatText } from "./report";
import { VERSION } from "./version";

export type CliIo = {
  stdout(text: string): void;
  stderr(text: string): void;
  /** Directory relative paths are resolved against. */
  cwd: string;
};

const USAGE = `Usage: doceye [directory] [options]

Checks a repository's documentation against the repository itself.

Options:
  -c, --config <file>       Configuration file (default: .doceye.yml if present)
      --readme <file>       README path (default: README.md)
      --no-external-links   Do not check external URLs (no network requests)
      --cache-file <file>   Remember successful external link results in this .json file
      --fail-on <level>     error | warning | notice | none (default: error)
  -f, --format <format>     text | json | sarif (default: text)
  -o, --output <file>       Write the report to a file instead of stdout
  -h, --help                Show this help
  -v, --version             Show the version

Exit codes: 0 no findings at or above --fail-on, 1 findings found, 2 usage or configuration error.
`;

const FORMATS = new Set(["text", "json", "sarif"]);

/** Run the command line tool. Returns the process exit code. */
export async function main(argv: string[], io: CliIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: "string", short: "c" },
        readme: { type: "string" },
        "no-external-links": { type: "boolean" },
        "cache-file": { type: "string" },
        "fail-on": { type: "string" },
        format: { type: "string", short: "f" },
        output: { type: "string", short: "o" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (error) {
    io.stderr(`doceye: ${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }

  const { values, positionals } = parsed;
  if (values.help) {
    io.stdout(USAGE);
    return 0;
  }
  if (values.version) {
    io.stdout(`${VERSION}\n`);
    return 0;
  }
  if (positionals.length > 1) {
    io.stderr(`doceye: expected at most one directory, got ${positionals.length}\n`);
    return 2;
  }
  const format = values.format ?? "text";
  if (!FORMATS.has(format)) {
    io.stderr(`doceye: --format must be one of: text, json, sarif (got "${format}")\n`);
    return 2;
  }
  const failOn = values["fail-on"];
  if (failOn !== undefined && !isFailOn(failOn)) {
    io.stderr(`doceye: --fail-on must be one of: error, warning, notice, none (got "${failOn}")\n`);
    return 2;
  }

  const options: RunOptions = { root: path.resolve(io.cwd, positionals[0] ?? ".") };
  if (values.config !== undefined) options.configPath = values.config;
  if (values.readme !== undefined) options.readme = values.readme;
  if (values["no-external-links"]) options.externalLinks = false;
  if (values["cache-file"] !== undefined) options.cacheFile = values["cache-file"];
  if (failOn !== undefined && isFailOn(failOn)) options.failOn = failOn;

  let report;
  try {
    report = await runDocEye(options);
  } catch (error) {
    const isUserError = error instanceof ConfigError || (error as NodeJS.ErrnoException).code === "ENOENT";
    io.stderr(`doceye: ${isUserError ? (error as Error).message : `unexpected error: ${(error as Error).message}`}\n`);
    return 2;
  }

  const rendered =
    format === "json" ? formatJson(report, VERSION) : format === "sarif" ? formatSarif(report.findings, VERSION) : formatText(report.findings);

  if (values.output !== undefined) {
    try {
      await fs.writeFile(path.resolve(io.cwd, values.output), `${rendered}\n`);
    } catch (error) {
      io.stderr(`doceye: could not write ${values.output}: ${(error as Error).message}\n`);
      return 2;
    }
    io.stdout(`DocEye: ${report.findings.length} finding${report.findings.length === 1 ? "" : "s"}; ${format} report written to ${values.output}\n`);
  } else {
    io.stdout(`${rendered}\n`);
  }
  return report.failed ? 1 : 0;
}
