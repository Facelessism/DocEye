import { afterEach, describe, expect, it } from "vitest";
import { checkablePath } from "../src/checks/paths";
import { byRule, check, cleanupRepos } from "./helpers";

afterEach(cleanupRepos);

describe("checkablePath", () => {
  it("accepts repository-style paths with known extensions", () => {
    expect(checkablePath("docs/setup.md")).toBe("docs/setup.md");
    expect(checkablePath("./src/index.ts")).toBe("src/index.ts");
    expect(checkablePath("webpack.config.js")).toBe("webpack.config.js");
    expect(checkablePath(".eslintrc.json")).toBe(".eslintrc.json");
  });

  it("rejects placeholders, globs, absolute paths, generated output and prose-like names", () => {
    for (const value of ["path/to/file.js", "src/*.ts", "/etc/hosts.conf", "~/.config/x.json", "dist/index.js", "node_modules/x/y.js", "index.js", "package-lock.json", "a b/c.md", "../up/x.md", "src/{a,b}.ts", "https://x.y/z.md", "@scope/pkg/file.js", "src/notes", ".json", ".ts", ".md"]) {
      expect(checkablePath(value)).toBeUndefined();
    }
  });
});

describe("checkablePath: common ambiguous inline code that must stay silent", () => {
  // These are the kinds of inline code a README legitimately contains that are not repository
  // paths: environment variable assignments, shell commands, absolute system paths, and bare
  // two-segment names with no extension. Each must be ignored rather than treated as a candidate
  // file, since DocEye can only be trusted if this rule's false-positive rate stays very low.
  it("ignores env assignments, shell commands, absolute system paths and extensionless names", () => {
    for (const value of ["PATH=/usr/bin", "./configure", "/tmp/foo", "foo/bar", "NODE_ENV=production", "chmod +x run"]) {
      expect(checkablePath(value)).toBeUndefined();
    }
  });

  it("still checks an actual repository-relative source path", () => {
    expect(checkablePath("src/index.ts")).toBe("src/index.ts");
  });
});

describe("path references", () => {
  it("reports inline code paths that do not exist", async () => {
    const report = await check({ "README.md": "The entry point is `src/main.ts` and old data is in `data/legacy.json`.\n", "src/main.ts": "" });
    expect(byRule(report.findings, "paths")).toMatchObject([
      { severity: "warning", line: 1, message: "README.md references data/legacy.json, but it does not exist.", subject: "data/legacy.json" },
    ]);
  });

  it("does not report files the reader is told to create or copy, or linked paths", async () => {
    const report = await check({
      "README.md": [
        "Copy `config/example.json` to `config/local.json`.",
        "",
        "Create `src/new-file.ts` for your feature.",
        "",
        "[`docs/a.md`](docs/a.md)",
      ].join("\n"),
      "config/example.json": "{}",
    });
    expect(byRule(report.findings, "paths")).toHaveLength(0);
  });
});

describe("configuration location claims", () => {
  it("reports a documented configuration file that is missing", async () => {
    const report = await check({ "README.md": "Configuration lives in `config/app.yml`.\n" });
    expect(byRule(report.findings, "config-files")).toMatchObject([
      { severity: "error", line: 1, message: "README.md says configuration lives in config/app.yml, but it does not exist.", subject: "config/app.yml" },
    ]);
    expect(byRule(report.findings, "paths")).toHaveLength(0); // not reported twice
  });

  it("accepts an existing configuration file, including directories", async () => {
    const report = await check({
      "README.md": "Configuration lives in `config/app.yml`. Settings are stored in `conf/`.",
      "config/app.yml": "a: 1",
      "conf/x": "",
    });
    expect(byRule(report.findings, "config-files")).toHaveLength(0);
  });
});
