import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError } from "../src/config";
import { runDocEye } from "../src/check";
import { byRule, check, cleanupRepos, makeRepo, rules } from "./helpers";

afterEach(cleanupRepos);

const VALID_README = [
  "# Tool",
  "",
  "Requires Node.js 20+. This project uses pnpm.",
  "",
  "See the [guide](docs/guide.md#setup) and [license](LICENSE).",
  "",
  "```bash",
  "pnpm install",
  "pnpm build",
  "node scripts/run.js",
  "docker build -t tool .",
  "```",
  "",
  "CI is defined in `.github/workflows/ci.yml`. Configuration lives in `config/app.yml`.",
  "",
  "## License",
  "",
  "MIT",
].join("\n");

const VALID_REPO = {
  "README.md": VALID_README,
  "docs/guide.md": "# Guide\n\n## Setup\n\nText.",
  LICENSE: "MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy",
  "package.json": JSON.stringify({ scripts: { build: "tsc" }, packageManager: "pnpm@10.0.0", engines: { node: ">=20" }, license: "MIT" }),
  "pnpm-lock.yaml": "",
  "scripts/run.js": "",
  "config/app.yml": "a: 1",
  Dockerfile: "FROM node:22",
  ".github/workflows/ci.yml": "name: CI",
};

describe("runDocEye", () => {
  it("finds nothing in a completely valid repository", async () => {
    const report = await check(VALID_REPO);
    expect(report.findings).toEqual([]);
    expect(report.failed).toBe(false);
    expect(report.docsChecked).toEqual(["README.md", "docs/guide.md"]);
  });

  it("reports multiple findings with source locations, ordered by position", async () => {
    const report = await check({
      "README.md": [
        "# X", // 1
        "", // 2
        "[broken](docs/none.md)", // 3
        "", // 4
        "```bash", // 5
        "pnpm run deploy", // 6
        "node server.js", // 7
        "```", // 8
        "", // 9
        "Configuration lives in `conf/app.yml`.", // 10
      ].join("\n"),
      "package.json": JSON.stringify({ scripts: { build: "x" } }),
    });
    expect(report.findings.map((f) => [f.file, f.line, f.rule])).toEqual([
      ["README.md", 3, "local-links"],
      ["README.md", 6, "package-scripts"],
      ["README.md", 7, "commands"],
      ["README.md", 10, "config-files"],
    ]);
    expect(report.failed).toBe(true);
  });

  it("is deterministic and produces serializable findings", async () => {
    const files = { "README.md": "[a](x.md) [b](y.md)\n```\nnpm run z\n```", "package.json": "{}", "pnpm-lock.yaml": "" };
    const first = await check(files);
    const second = await check(files);
    expect(JSON.stringify(first.findings)).toBe(JSON.stringify(second.findings));
    expect(JSON.parse(JSON.stringify(first.findings))).toEqual(first.findings);
  });

  it("scans Markdown under docs/ and skips dependency folders", async () => {
    const report = await check({
      "README.md": "ok",
      "docs/a.md": "[x](gone.md)",
      "docs/nested/b.markdown": "[y](gone.md)",
      "docs/node_modules/c.md": "[z](gone.md)",
    });
    expect(report.docsChecked).toEqual(["README.md", "docs/a.md", "docs/nested/b.markdown"]);
    expect(byRule(report.findings, "local-links")).toHaveLength(2);
  });

  it("warns instead of failing when there is no README", async () => {
    const report = await check({ "docs/a.md": "hi" });
    expect(report.findings).toMatchObject([{ rule: "doceye", severity: "warning" }]);
    expect(report.findings[0]?.message).toContain("README file not found: README.md");
  });

  it("supports a custom README path", async () => {
    const report = await check({ "docs/START.md": "[x](gone.md)" }, { readme: "docs/START.md" });
    expect(rules(report.findings)).toEqual(["local-links"]);
  });

  it("tolerates a README that is mostly noise", async () => {
    const report = await check({ "README.md": "\0\0 [x](  ) ![](<>) ```` \n<<<<>>>>\n```bash\n\\\n```\n" });
    expect(report.findings.every((f) => f.rule !== "doceye" || f.severity !== "error")).toBe(true);
  });

  it("rejects a readme path that escapes the repository", async () => {
    const root = await makeRepo({ "README.md": "x" });
    await expect(runDocEye({ root, readme: "../outside.md", externalLinks: false })).rejects.toThrow(ConfigError);
  });
});

describe("path safety", () => {
  it("does not treat files reached through a symlink out of the repository as existing", async () => {
    const outside = await makeRepo({ "secret.md": "# secret" });
    const root = await makeRepo({ "README.md": "[a](escape/secret.md) [b](escape-file.md)" });
    await fs.symlink(outside, path.join(root, "escape"));
    await fs.symlink(path.join(outside, "secret.md"), path.join(root, "escape-file.md"));
    const report = await runDocEye({ root, externalLinks: false });
    expect(report.findings.map((f) => f.message)).toEqual(["Broken local link: escape/secret.md", "Broken local link: escape-file.md"]);
  });

  it("does not read a README that is a symlink to a file outside the repository", async () => {
    const outside = await makeRepo({ "evil.md": "[x](gone.md)" });
    const root = await makeRepo({});
    await fs.symlink(path.join(outside, "evil.md"), path.join(root, "README.md"));
    const report = await runDocEye({ root, externalLinks: false });
    expect(report.docsChecked).toEqual([]);
  });

  it("does not follow symlinked directories while discovering docs", async () => {
    const outside = await makeRepo({ "leak.md": "[x](gone.md)" });
    const root = await makeRepo({ "README.md": "ok", "docs/a.md": "ok" });
    await fs.symlink(outside, path.join(root, "docs", "linked"));
    const report = await runDocEye({ root, externalLinks: false });
    expect(report.docsChecked).toEqual(["README.md", "docs/a.md"]);
  });
});
