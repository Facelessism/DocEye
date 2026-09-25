import { countBySeverity } from "./report";
import { RULE_DESCRIPTIONS, type FailOn, type Finding, type Severity } from "./types";

export type ReportSummary = {
  findings: Finding[];
  docsChecked: string[];
  failOn: FailOn;
  failed: boolean;
};

/** A stable, machine-readable report. */
export function formatJson(report: ReportSummary, version: string): string {
  const counts = countBySeverity(report.findings);
  return JSON.stringify(
    {
      tool: { name: "doceye", version },
      summary: { total: report.findings.length, ...counts, failOn: report.failOn, failed: report.failed },
      docsChecked: report.docsChecked,
      findings: report.findings,
    },
    null,
    2,
  );
}

const SARIF_LEVEL: Record<Severity, "error" | "warning" | "note"> = { error: "error", warning: "warning", notice: "note" };

/**
 * SARIF 2.1.0, the format GitHub code scanning ingests. Upload the file with
 * github/codeql-action/upload-sarif to see findings in the Security tab and
 * as pull request annotations.
 */
export function formatSarif(findings: Finding[], version: string): string {
  const ruleIds = [...new Set(findings.map((f) => f.rule))].sort();
  const describe = (id: string): string => (RULE_DESCRIPTIONS as Record<string, string | undefined>)[id] ?? id;

  const results = findings.map((finding) => {
    const text = [finding.message, finding.details, finding.suggestion ? `Suggestion: ${finding.suggestion}` : undefined]
      .filter((part): part is string => part !== undefined)
      .join(" ");
    return {
      ruleId: finding.rule,
      ruleIndex: ruleIds.indexOf(finding.rule),
      level: SARIF_LEVEL[finding.severity],
      message: { text },
      ...(finding.file !== undefined
        ? {
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: finding.file, uriBaseId: "%SRCROOT%" },
                  ...(finding.line !== undefined
                    ? { region: { startLine: finding.line, ...(finding.column !== undefined ? { startColumn: finding.column } : {}) } }
                    : {}),
                },
              },
            ],
          }
        : {}),
      ...(finding.subject !== undefined ? { properties: { subject: finding.subject } } : {}),
    };
  });

  return JSON.stringify(
    {
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      version: "2.1.0",
      runs: [
        {
          tool: {
            driver: {
              name: "DocEye",
              semanticVersion: version,
              rules: ruleIds.map((id) => ({ id, name: id, shortDescription: { text: describe(id) } })),
            },
          },
          results,
        },
      ],
    },
    null,
    2,
  );
}
