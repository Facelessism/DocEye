import { afterEach, describe, expect, it } from "vitest";
import { formatJson, formatSarif } from "../src/output";
import type { Finding } from "../src/types";
import { check, cleanupRepos } from "./helpers";

afterEach(cleanupRepos);

const findings: Finding[] = [
  { rule: "local-links", severity: "error", message: "Broken local link: docs/x.md", file: "README.md", line: 5, column: 3, subject: "docs/x.md", suggestion: "Did you mean docs/y.md?" },
  { rule: "license", severity: "warning", message: "README.md says MIT.", file: "README.md", line: 1 },
  { rule: "doceye", severity: "notice", message: "README file not found: README.md" },
];

describe("formatJson", () => {
  it("is valid JSON with a stable, complete shape", () => {
    const parsed = JSON.parse(formatJson({ findings, docsChecked: ["README.md"], failOn: "error", failed: true }, "1.1.0"));
    expect(parsed.tool).toEqual({ name: "doceye", version: "1.1.0" });
    expect(parsed.summary).toEqual({ total: 3, error: 1, warning: 1, notice: 1, failOn: "error", failed: true });
    expect(parsed.docsChecked).toEqual(["README.md"]);
    expect(parsed.findings).toEqual(findings);
  });

  it("round-trips through a real run", async () => {
    const report = await check({ "README.md": "[x](gone.md)" });
    const parsed = JSON.parse(formatJson(report, "1.1.0"));
    expect(parsed.findings).toEqual(report.findings);
    expect(parsed.summary.total).toBe(report.findings.length);
  });
});

describe("formatSarif", () => {
  it("produces a well-formed SARIF 2.1.0 document", () => {
    const sarif = JSON.parse(formatSarif(findings, "1.1.0"));
    expect(sarif.version).toBe("2.1.0");
    const run = sarif.runs[0];
    expect(run.tool.driver.name).toBe("DocEye");
    expect(run.tool.driver.semanticVersion).toBe("1.1.0");
    expect(run.tool.driver.rules.map((r: { id: string }) => r.id)).toEqual(["doceye", "license", "local-links"]);
    expect(run.results).toHaveLength(3);
  });

  it("maps DocEye severities to SARIF levels and includes locations and suggestions", () => {
    const [error, warning, notice] = JSON.parse(formatSarif(findings, "1.1.0")).runs[0].results;
    expect(error.level).toBe("error");
    expect(warning.level).toBe("warning");
    expect(notice.level).toBe("note");
    expect(error.locations[0].physicalLocation).toMatchObject({
      artifactLocation: { uri: "README.md" },
      region: { startLine: 5, startColumn: 3 },
    });
    expect(error.message.text).toContain("Did you mean docs/y.md?");
    expect(notice.locations).toBeUndefined();
  });

  it("assigns a stable ruleIndex matching the rules array", () => {
    const { runs } = JSON.parse(formatSarif(findings, "1.1.0"));
    const ids: string[] = runs[0].tool.driver.rules.map((r: { id: string }) => r.id);
    for (const result of runs[0].results) expect(ids[result.ruleIndex]).toBe(result.ruleId);
  });

  it("handles no findings", () => {
    const sarif = JSON.parse(formatSarif([], "1.1.0"));
    expect(sarif.runs[0].results).toEqual([]);
    expect(sarif.runs[0].tool.driver.rules).toEqual([]);
  });
});
