import { afterEach, describe, expect, it } from "vitest";
import { byRule, check, cleanupRepos } from "./helpers";

afterEach(cleanupRepos);

const wf = { ".github/workflows/ci.yml": "name: CI\non: push\n" };

describe("workflow references", () => {
  it("reports a missing workflow file referenced in prose", async () => {
    const report = await check({ "README.md": "Deployment is defined in `.github/workflows/deploy.yml`.\n", ...wf });
    expect(byRule(report.findings, "workflows")).toMatchObject([
      {
        severity: "error",
        file: "README.md",
        line: 1,
        message: 'README.md references workflow "deploy.yml", but .github/workflows/deploy.yml does not exist.',
        details: "Workflows in the repository: ci.yml.",
      },
    ]);
  });

  it("accepts a valid workflow reference", async () => {
    const report = await check({ "README.md": "CI lives in `.github/workflows/ci.yml`.", ...wf });
    expect(byRule(report.findings, "workflows")).toHaveLength(0);
  });

  it("checks GitHub Actions badge URLs for this repository", async () => {
    const badge = (name: string) => `[![CI](https://github.com/acme/tool/actions/workflows/${name}/badge.svg)](https://github.com/acme/tool/actions/workflows/${name})`;
    const missing = await check({ "README.md": badge("release.yml"), ...wf }, { slug: "acme/tool" });
    expect(byRule(missing.findings, "workflows").map((f) => f.subject)).toEqual([".github/workflows/release.yml"]);
    const valid = await check({ "README.md": badge("ci.yml"), ...wf }, { slug: "acme/tool" });
    expect(byRule(valid.findings, "workflows")).toHaveLength(0);
  });

  it("uses the package.json repository field when no slug is supplied", async () => {
    const report = await check({
      "README.md": "![CI](https://github.com/acme/tool/actions/workflows/gone.yml/badge.svg)",
      "package.json": JSON.stringify({ repository: "git+https://github.com/acme/tool.git" }),
    });
    expect(byRule(report.findings, "workflows")).toHaveLength(1);
  });

  it("ignores workflows that belong to other repositories", async () => {
    const report = await check({ "README.md": "![CI](https://github.com/other/thing/actions/workflows/nope.yml/badge.svg)", ...wf }, { slug: "acme/tool" });
    expect(byRule(report.findings, "workflows")).toHaveLength(0);
  });

  it("does not flag files the README asks the reader to create, or YAML examples", async () => {
    const report = await check({
      "README.md": [
        "Create `.github/workflows/doceye.yml`:",
        "",
        "```yaml",
        "# .github/workflows/doceye.yml",
        "name: DocEye",
        "```",
        "",
        "```bash",
        "# .github/workflows/other.yml",
        "```",
      ].join("\n"),
    });
    expect(byRule(report.findings, "workflows")).toHaveLength(0);
  });

  it("checks references in shell code blocks with accurate line numbers", async () => {
    const report = await check({ "README.md": "```bash\necho hi\ncat .github/workflows/lint.yaml\n```\n" });
    expect(byRule(report.findings, "workflows")[0]).toMatchObject({ line: 3 });
  });
});
