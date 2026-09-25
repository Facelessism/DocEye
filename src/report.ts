import { SEVERITY_RANK, type FailOn, type Finding, type Severity } from "./types";

export const COMMENT_MARKER = "<!-- doceye-summary -->";
const MAX_COMMENT_ENTRIES = 30;

export function countBySeverity(findings: Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { error: 0, warning: 0, notice: 0 };
  for (const finding of findings) counts[finding.severity]++;
  return counts;
}

/** True when at least one finding is at or above the threshold. */
export function shouldFail(findings: Finding[], failOn: FailOn): boolean {
  if (failOn === "none") return false;
  return findings.some((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[failOn]);
}

export function formatLocation(finding: Finding): string {
  if (finding.file === undefined) return "";
  return finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function headline(findings: Finding[]): string {
  if (findings.length === 0) return "DocEye found no documentation issues.";
  const c = countBySeverity(findings);
  const parts = [
    c.error > 0 ? plural(c.error, "error") : "",
    c.warning > 0 ? plural(c.warning, "warning") : "",
    c.notice > 0 ? plural(c.notice, "notice") : "",
  ].filter(Boolean);
  return `DocEye found ${plural(findings.length, "documentation issue")} (${parts.join(", ")}).`;
}

/** Plain-text console report. */
export function formatText(findings: Finding[]): string {
  const lines = [headline(findings)];
  for (const finding of findings) {
    lines.push("", `${finding.severity.toUpperCase()} [${finding.rule}]`);
    const location = formatLocation(finding);
    if (location) lines.push(location);
    lines.push(finding.message);
    if (finding.details) lines.push(`  ${finding.details}`);
    if (finding.suggestion) lines.push(`  Suggestion: ${finding.suggestion}`);
  }
  return lines.join("\n");
}

/** Keep repository-controlled text from pinging users or injecting markup into a comment. */
function sanitize(text: string): string {
  return text.replace(/@/g, "@\u200b").replace(/</g, "&lt;").replace(/`/g, "'");
}

/** One summary for a pull request comment or job summary; never one entry per finding thread. */
export function formatComment(findings: Finding[], maxEntries = MAX_COMMENT_ENTRIES): string {
  const lines = [COMMENT_MARKER, `### ${headline(findings)}`];
  if (findings.length > 0) lines.push("");
  for (const finding of findings.slice(0, maxEntries)) {
    const location = formatLocation(finding);
    lines.push(`- **${finding.severity}** ${location ? `\`${location}\` ` : ""}${sanitize(finding.message)}`);
    if (finding.suggestion) lines.push(`  - Suggestion: ${sanitize(finding.suggestion)}`);
  }
  if (findings.length > maxEntries) {
    lines.push(`- ...and ${findings.length - maxEntries} more (see the workflow log).`);
  }
  return lines.join("\n");
}
