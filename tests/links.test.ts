import { afterEach, describe, expect, it } from "vitest";
import { parseLocalTarget, resolveLocalPath } from "../src/checks/links";
import { byRule, check, cleanupRepos } from "./helpers";

afterEach(cleanupRepos);

describe("parseLocalTarget / resolveLocalPath", () => {
  it("ignores URLs and other protocols", () => {
    for (const url of ["https://a.b/c", "http://a.b", "mailto:a@b.c", "tel:+123", "//cdn.example/x", "data:text/plain,hi", ""]) {
      expect(parseLocalTarget(url)).toBeUndefined();
    }
  });

  it("splits fragments and queries and decodes paths", () => {
    expect(parseLocalTarget("docs/my%20file.md?x=1#Top")).toEqual({ path: "docs/my file.md", fragment: "Top" });
    expect(parseLocalTarget("#usage")).toEqual({ path: "", fragment: "usage" });
  });

  it("skips template placeholders it cannot verify", () => {
    expect(parseLocalTarget("{{ site.url }}/x")).toBeUndefined();
    expect(parseLocalTarget("$ROOT/x.md")).toBeUndefined();
  });

  it("normalizes paths and refuses to leave the repository", () => {
    expect(resolveLocalPath("README.md", "./docs/a.md")).toBe("docs/a.md");
    expect(resolveLocalPath("docs/guide/a.md", "../b.md")).toBe("docs/b.md");
    expect(resolveLocalPath("docs/a.md", "/LICENSE")).toBe("LICENSE");
    expect(resolveLocalPath("README.md", "../secret")).toBeUndefined();
    expect(resolveLocalPath("docs/a.md", "../../etc/passwd")).toBeUndefined();
  });
});

describe("local link checking", () => {
  it("accepts valid local links, directories and ./ and parent references", async () => {
    const report = await check({
      "README.md": "[a](docs/a.md) [b](./docs/b.md) [dir](docs/) [lic](LICENSE)\n",
      "docs/a.md": "[up](../README.md) [sib](b.md)",
      "docs/b.md": "# B",
      LICENSE: "x",
    });
    expect(byRule(report.findings, "local-links")).toHaveLength(0);
  });

  it("reports a broken local link with file, line and column", async () => {
    const report = await check({ "README.md": "# Title\n\nSee the [install guide](docs/install.md) first.\n" });
    expect(report.findings).toMatchObject([
      {
        rule: "local-links",
        severity: "error",
        message: "Broken local link: docs/install.md",
        file: "README.md",
        line: 3,
        column: 9,
        subject: "docs/install.md",
      },
    ]);
    expect(report.failed).toBe(true);
  });

  it("reports links that resolve relative to the containing document", async () => {
    const report = await check({
      "README.md": "[ok](docs/a.md)",
      "docs/a.md": "[bad](missing.md)\n[ok](../README.md)",
    });
    const broken = byRule(report.findings, "local-links");
    expect(broken).toHaveLength(1);
    expect(broken[0]).toMatchObject({ file: "docs/a.md", line: 1, subject: "docs/missing.md" });
  });

  it("flags links that point outside the repository", async () => {
    const report = await check({ "README.md": "[x](../../etc/passwd)" });
    expect(report.findings[0]).toMatchObject({ rule: "local-links", message: expect_outside() });
  });

  it("does not check URLs or mailto links as files", async () => {
    const report = await check({ "README.md": "[a](https://example.invalid/x) [m](mailto:a@b.c) <https://example.invalid/y>" });
    expect(report.findings).toHaveLength(0);
  });

  it("checks image and HTML references and reference-style definitions", async () => {
    const report = await check({
      "README.md": '![logo](assets/logo.png)\n\n<img src="assets/banner.png">\n\n[ref]: docs/gone.md\n',
      "assets/logo.png": "",
    });
    expect(byRule(report.findings, "local-links").map((f) => f.subject).sort()).toEqual(["assets/banner.png", "docs/gone.md"]);
  });

  it("validates same-file and cross-file anchors conservatively", async () => {
    const report = await check({
      "README.md": "# Usage\n\n[ok](#usage) [bad](#nope) [x](docs/a.md#deep-dive) [y](docs/a.md#missing) [line](src/x.ts#L10)\n",
      "docs/a.md": "# A\n\n## Deep dive\n",
      "src/x.ts": "",
    });
    const anchors = byRule(report.findings, "anchors");
    expect(anchors.map((f) => f.message)).toEqual([
      'Anchor "#nope" not found in README.md',
      'Anchor "#missing" not found in docs/a.md',
    ]);
    expect(anchors[0]?.severity).toBe("warning");
  });

  it("does not report anything under node_modules", async () => {
    const report = await check({ "README.md": "[x](node_modules/pkg/readme.md)" });
    expect(report.findings).toHaveLength(0);
  });
});

function expect_outside(): string {
  return "Local link points outside the repository: ../../etc/passwd";
}
