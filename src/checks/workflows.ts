import { closestMatch } from "../suggest";
import type { Finding } from "../types";
import { looksLikeCreation, severityOf, type CheckContext } from "./shared";

const WORKFLOW_PATH = /\.github\/workflows\/([\w.-]+\.ya?ml)/gi;
const ACTIONS_URL = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:actions\/workflows|(?:blob|tree)\/[^/]+\/\.github\/workflows)\/([^/?#]+\.ya?ml)/i;

type WorkflowRef = { file: string; line: number; column: number; name: string };

function collectRefs(ctx: CheckContext): WorkflowRef[] {
  const refs: WorkflowRef[] = [];
  const slug = ctx.repo.slug?.toLowerCase();

  for (const doc of ctx.docs) {
    for (const block of doc.textBlocks) {
      for (const m of block.text.matchAll(WORKFLOW_PATH)) {
        const index = m.index ?? 0;
        if (looksLikeCreation(block.text.slice(0, index).split("\n").pop() ?? "")) continue;
        const newlines = block.text.slice(0, index).split("\n").length - 1;
        refs.push({ file: doc.file, line: block.line + newlines, column: newlines === 0 ? block.column : 1, name: m[1] as string });
      }
    }

    for (const block of doc.codeBlocks) {
      if (block.lang === "yaml" || block.lang === "yml") continue; // examples of workflow content
      block.value.split(/\r?\n/).forEach((text, i) => {
        if (/^\s*(#|\/\/)/.test(text)) return;
        for (const m of text.matchAll(WORKFLOW_PATH)) {
          refs.push({ file: doc.file, line: block.startLine + i, column: (m.index ?? 0) + 1, name: m[1] as string });
        }
      });
    }

    for (const link of doc.links) {
      const m = ACTIONS_URL.exec(link.url);
      if (!m) continue;
      const repo = `${m[1]}/${(m[2] as string).replace(/\.git$/, "")}`.toLowerCase();
      if (slug !== undefined && repo !== slug) continue; // a workflow in some other repository
      refs.push({ file: doc.file, line: link.line, column: link.column, name: m[3] as string });
    }
  }
  return refs;
}

export function checkWorkflows(ctx: CheckContext): Finding[] {
  const severity = severityOf(ctx, "workflows");
  if (!severity) return [];
  const existing = new Set(ctx.repo.workflows);
  const findings: Finding[] = [];
  const seen = new Set<string>();

  for (const ref of collectRefs(ctx)) {
    if (existing.has(ref.name)) continue;
    const key = `${ref.file}:${ref.line}:${ref.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const near = closestMatch(ref.name, ctx.repo.workflows);
    findings.push({
      rule: "workflows",
      severity,
      message: `${ref.file} references workflow "${ref.name}", but .github/workflows/${ref.name} does not exist.`,
      file: ref.file,
      line: ref.line,
      column: ref.column,
      subject: `.github/workflows/${ref.name}`,
      details:
        ctx.repo.workflows.length > 0
          ? `Workflows in the repository: ${ctx.repo.workflows.join(", ")}.`
          : "The repository has no files in .github/workflows.",
      ...(near !== undefined ? { suggestion: `Did you mean .github/workflows/${near}?` } : {}),
    });
  }
  return findings;
}
