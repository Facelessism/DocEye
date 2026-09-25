import { afterEach, describe, expect, it } from "vitest";
import { closestMatch, closestScript, editDistance, suggestPath } from "../src/suggest";
import { byRule, check, cleanupRepos } from "./helpers";

afterEach(cleanupRepos);

describe("closestMatch", () => {
  it("computes edit distance", () => {
    expect(editDistance("build", "build")).toBe(0);
    expect(editDistance("build", "biuld")).toBe(2);
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(editDistance("", "abc")).toBe(3);
  });

  it("suggests plausible typos and nothing else", () => {
    expect(closestMatch("biuld", ["build", "test", "lint"])).toBe("build");
    expect(closestMatch("Build", ["build", "test"])).toBe("build");
    expect(closestMatch("deploy", ["build", "test", "lint"])).toBeUndefined();
    expect(closestMatch("dev", ["doc", "test"])).toBeUndefined();
    expect(closestMatch("build", ["build"])).toBeUndefined();
    expect(closestMatch("x", [])).toBeUndefined();
  });

  it("relates namespaced scripts", () => {
    expect(closestScript("deploy", ["build", "deploy:prod"])).toBe("deploy:prod");
    expect(closestScript("test:unit", ["test", "lint"])).toBe("test");
    expect(closestScript("nothing", ["build", "test"])).toBeUndefined();
  });
});

describe("suggestPath", () => {
  const files = ["README.md", "docs/guide/setup.md", "docs/index.md", "docs/faq.md", "src/a/util.ts", "src/b/util.ts"];

  it("finds a file that moved", () => {
    expect(suggestPath("docs/setup.md", files)).toBe("docs/guide/setup.md");
  });

  it("prefers the moved copy nearest the original location", () => {
    expect(suggestPath("src/b/x/util.ts", files)).toBe("src/b/util.ts");
  });

  it("finds a typo in the same directory", () => {
    expect(suggestPath("docs/fqa.md", files)).toBe("docs/faq.md");
    expect(suggestPath("docs/Index.md", files)).toBe("docs/index.md");
  });

  it("returns nothing when nothing is close", () => {
    expect(suggestPath("docs/unrelated-topic.md", files)).toBeUndefined();
  });
});

describe("suggestions in findings", () => {
  it("suggests the moved file for a broken link", async () => {
    const report = await check({ "README.md": "[setup](docs/setup.md)", "docs/guide/setup.md": "# S" });
    expect(byRule(report.findings, "local-links")[0]?.suggestion).toBe("Did you mean docs/guide/setup.md?");
  });

  it("suggests the closest anchor", async () => {
    const report = await check({ "README.md": "# Installation\n\n[go](#instalation)" });
    expect(byRule(report.findings, "anchors")[0]?.suggestion).toBe("Did you mean #installation?");
  });

  it("suggests the closest script", async () => {
    const report = await check({ "README.md": "```\nnpm run biuld\n```", "package.json": JSON.stringify({ scripts: { build: "x", test: "y" } }) });
    expect(byRule(report.findings, "package-scripts")[0]?.suggestion).toBe('Did you mean the script "build"?');
  });

  it("suggests the equivalent command for the package manager the repository uses", async () => {
    const report = await check({
      "README.md": "```\nnpm install\nnpm run build\n```",
      "package.json": JSON.stringify({ scripts: { build: "x" }, packageManager: "pnpm@10.0.0" }),
    });
    expect(byRule(report.findings, "package-manager")[0]?.suggestion).toBe('Use "pnpm install" instead.');
    const claim = await check({ "README.md": "This project uses yarn.", "package.json": JSON.stringify({ packageManager: "pnpm@10.0.0" }) });
    expect(byRule(claim.findings, "package-manager")[0]?.suggestion).toBe("Update the documentation to say pnpm.");
  });

  it("gives no manager suggestion when several ecosystems are present", async () => {
    const report = await check({ "README.md": "```\nyarn install\n```", "package.json": "{}", "package-lock.json": "{}", "pnpm-lock.yaml": "" });
    expect(byRule(report.findings, "package-manager")[0]?.suggestion).toBeUndefined();
  });

  it("suggests a workflow, a Dockerfile, a node file and a config path", async () => {
    const report = await check({
      "README.md": [
        "See `.github/workflows/ci-test.yml`.",
        "",
        "```bash",
        "docker build -f Dockerfile.prd .",
        "node servr.js",
        "```",
        "",
        "Old notes are in `docs/notes.md`.",
      ].join("\n"),
      ".github/workflows/ci-tests.yml": "name: x",
      "Dockerfile.prod": "FROM scratch",
      "server.js": "",
      "docs/note.md": "",
    });
    expect(byRule(report.findings, "workflows")[0]?.suggestion).toBe("Did you mean .github/workflows/ci-tests.yml?");
    expect(byRule(report.findings, "docker")[0]?.suggestion).toBe("Did you mean Dockerfile.prod?");
    expect(byRule(report.findings, "commands")[0]?.suggestion).toBe("Did you mean server.js?");
    expect(byRule(report.findings, "paths")[0]?.suggestion).toBe("Did you mean docs/note.md?");
  });

  it("explains how to reconcile runtime and license mismatches", async () => {
    const runtime = await check({ "README.md": "Requires Node.js 22.", "package.json": JSON.stringify({ engines: { node: ">=20" } }) });
    expect(byRule(runtime.findings, "runtime")[0]?.suggestion).toBe("Update the documentation to Node.js 20+, or raise the declared version to 22.");
    const none = await check({ "README.md": "Licensed under MIT." });
    expect(byRule(none.findings, "license")[0]?.suggestion).toBe("Add a LICENSE file for MIT, or remove the claim.");
  });
});
