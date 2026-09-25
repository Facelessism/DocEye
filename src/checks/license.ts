import { normalizeLicenseId, type RepoFacts } from "../repository";
import type { Finding, Verification } from "../types";
import { alsoAt, groupBy, joinDetails, severityOf, type CheckContext } from "./shared";

/**
 * Conservative license verification: a claim is contradicted only when the
 * repository has recognizable license evidence that does not include it, or
 * has no license evidence at all. An unrecognized LICENSE file yields "unknown".
 * This is a consistency check, not legal analysis.
 */
export function verifyLicenseClaim(id: string, repo: RepoFacts): Verification {
  const claimed = normalizeLicenseId(id);
  if (repo.licenses.length === 0) {
    if (repo.licenseFiles.length > 0) return { verdict: "unknown" };
    return { verdict: "contradicted", evidence: "no LICENSE file and no license field in package.json" };
  }
  const found = repo.licenses.map((l) => normalizeLicenseId(l.id));
  const evidence = repo.licenses.map((l) => `${l.source} identifies ${l.id}`).join("; ");
  return { verdict: found.includes(claimed) ? "supported" : "contradicted", evidence };
}

export function checkLicense(ctx: CheckContext): Finding[] {
  const severity = severityOf(ctx, "license");
  if (!severity) return [];
  const claims = (ctx.readme?.claims ?? []).flatMap((c) => (c.claim.kind === "license" ? [{ ...c, id: c.claim.id }] : []));

  const findings: Finding[] = [];
  for (const [first, ...others] of groupBy(claims, (c) => c.id)) {
    if (!first) continue;
    const result = verifyLicenseClaim(first.id, ctx.repo);
    if (result.verdict !== "contradicted") continue;
    const noEvidence = ctx.repo.licenses.length === 0;
    findings.push({
      rule: "license",
      severity,
      message: noEvidence
        ? `${first.file} says the project is licensed under ${first.id}, but no license evidence was found.`
        : `${first.file} says the project is licensed under ${first.id}, but the repository indicates a different license.`,
      file: first.file,
      line: first.line,
      column: first.column,
      subject: first.id,
      details: joinDetails(`Repository evidence: ${result.evidence}.`, alsoAt(others)),
      suggestion: noEvidence
        ? `Add a LICENSE file for ${first.id}, or remove the claim.`
        : `Update the documentation to say ${[...new Set(ctx.repo.licenses.map((l) => l.id))].join(" or ")}, or correct the license files.`,
    });
  }
  return findings;
}
