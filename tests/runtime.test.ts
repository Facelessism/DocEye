import { afterEach, describe, expect, it } from "vitest";
import { verifyNodeClaim } from "../src/checks/runtime";
import { minMajorOfRange } from "../src/repository";
import { byRule, check, cleanupRepos } from "./helpers";

afterEach(cleanupRepos);

describe("minMajorOfRange", () => {
  it("extracts the lowest allowed major", () => {
    const table: Array<[string, number | undefined]> = [
      [">=20", 20],
      [">= 20.10.0", 20],
      ["^18.17.0 || ^20.3.0", 18],
      ["20", 20],
      ["20.x", 20],
      ["~22.1.0", 22],
      [">=18 <23", 18],
      ["18 - 22", 18],
      ["v20.1.0", 20],
      ["<22", undefined],
      ["*", undefined],
      ["", undefined],
      ["lts/*", undefined],
      [">=18 || <10", undefined],
    ];
    for (const [range, expected] of table) expect(minMajorOfRange(range)).toBe(expected);
  });
});

describe("verifyNodeClaim", () => {
  const engines = (value: string, minMajor: number) => [{ source: "package.json engines.node", value, minMajor }];

  it("does not flag compatible declarations", () => {
    expect(verifyNodeClaim(20, engines(">=20", 20)).verdict).toBe("supported");
    expect(verifyNodeClaim(20, engines(">=22", 22)).verdict).toBe("supported");
    expect(verifyNodeClaim(18, engines(">=20", 20)).verdict).toBe("supported");
  });

  it("flags a documented minimum that is stricter than the repository declares", () => {
    const result = verifyNodeClaim(22, engines(">=20", 20));
    expect(result.verdict).toBe("contradicted");
    expect(result.evidence).toBe("package.json engines.node = >=20 (allows Node.js 20)");
  });

  it("is unknown without comparable declarations", () => {
    expect(verifyNodeClaim(22, []).verdict).toBe("unknown");
    expect(verifyNodeClaim(22, [{ source: ".nvmrc", value: "lts/*" }]).verdict).toBe("unknown");
  });
});

describe("runtime rule", () => {
  it("reports a documented Node.js requirement newer than engines.node", async () => {
    const report = await check({
      "README.md": "# X\n\nRequires Node.js 22.\n",
      "package.json": JSON.stringify({ engines: { node: ">=20" } }),
    });
    expect(byRule(report.findings, "runtime")).toMatchObject([
      {
        severity: "warning",
        file: "README.md",
        line: 3,
        message: 'README.md says "Node.js 22", but the repository declares support for an older Node.js version.',
      },
    ]);
    expect(byRule(report.findings, "runtime")[0]?.details).toContain("package.json engines.node = >=20");
  });

  it("does not flag compatible declarations", async () => {
    for (const [readme, engines] of [
      ["Node.js 20+ is required.", ">=20"],
      ["Node.js 20+", ">=22"],
      ["Requires Node 18 or newer", ">=18"],
      ["Requires Node 20", "^20 || ^22"],
    ] as const) {
      const report = await check({ "README.md": readme, "package.json": JSON.stringify({ engines: { node: engines } }) });
      expect(byRule(report.findings, "runtime")).toHaveLength(0);
    }
  });

  it("compares against .nvmrc, .node-version, .tool-versions and Volta", async () => {
    const cases: Array<Record<string, string>> = [
      { ".nvmrc": "v20.11.0\n" },
      { ".node-version": "20\n" },
      { ".tool-versions": "nodejs 20.11.0\npython 3.12\n" },
      { "package.json": JSON.stringify({ volta: { node: "20.11.0" } }) },
    ];
    for (const files of cases) {
      const report = await check({ "README.md": "Requires Node.js 22+", ...files });
      expect(byRule(report.findings, "runtime")).toHaveLength(1);
    }
  });

  it("ignores unresolvable pins such as lts/* and text without a requirement", async () => {
    const report = await check({ "README.md": "We love Node. Node-RED is unrelated. Tested with node 24.", ".nvmrc": "lts/*" });
    expect(byRule(report.findings, "runtime")).toHaveLength(0);
  });

  it("only verifies claims made in the README", async () => {
    const report = await check({
      "README.md": "See docs.",
      "docs/legacy.md": "Requires Node 8.",
      "package.json": JSON.stringify({ engines: { node: ">=6" } }),
    });
    expect(byRule(report.findings, "runtime")).toHaveLength(0);
  });
});
