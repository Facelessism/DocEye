import type { NodeDeclaration } from "../repository";
import type { Finding, Verification } from "../types";
import { severityOf, type CheckContext } from "./shared";

/**
 * A documented Node.js requirement conflicts only when it is *stricter* than
 * what the repository declares (documentation says 22, engines allows 20).
 * Documentation that mentions an older or equal version is not flagged: the
 * repository may simply have moved on, and a CI matrix is not a minimum.
 */
export function verifyNodeClaim(major: number, declarations: NodeDeclaration[]): Verification {
  const comparable = declarations.filter((d) => d.minMajor !== undefined);
  if (comparable.length === 0) return { verdict: "unknown" };
  const conflicts = comparable.filter((d) => major > (d.minMajor as number));
  if (conflicts.length === 0) return { verdict: "supported" };
  return {
    verdict: "contradicted",
    evidence: conflicts.map((d) => `${d.source} = ${d.value} (allows Node.js ${d.minMajor})`).join("; "),
  };
}

export function checkRuntime(ctx: CheckContext): Finding[] {
  const severity = severityOf(ctx, "runtime");
  if (!severity) return [];
  const findings: Finding[] = [];
  for (const { file, line, column, claim } of ctx.readme?.claims ?? []) {
    if (claim.kind !== "node-version") continue;
    const result = verifyNodeClaim(claim.major, ctx.repo.node);
    if (result.verdict !== "contradicted") continue;
    const declared = Math.min(...ctx.repo.node.flatMap((d) => (d.minMajor !== undefined && claim.major > d.minMajor ? [d.minMajor] : [])));
    findings.push({
      rule: "runtime",
      severity,
      message: `${file} says "${claim.text}", but the repository declares support for an older Node.js version.`,
      file,
      line,
      column,
      subject: `node ${claim.major}`,
      details: `Repository evidence: ${result.evidence}.`,
      suggestion: `Update the documentation to Node.js ${declared}+, or raise the declared version to ${claim.major}.`,
    });
  }
  return findings;
}
