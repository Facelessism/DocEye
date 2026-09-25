import type { Finding } from "./types";

/**
 * GitHub-facing helpers. They take the minimal structural interfaces they
 * need (satisfied by @actions/core and Octokit) so they stay testable
 * without GitHub.
 */

export type AnnotationProperties = { title?: string; file?: string; startLine?: number; startColumn?: number };

export type AnnotationSink = {
  error(message: string, properties?: AnnotationProperties): void;
  warning(message: string, properties?: AnnotationProperties): void;
  notice(message: string, properties?: AnnotationProperties): void;
};

/** GitHub keeps only the first 10 annotations of each level per step and drops the rest silently. */
export const ANNOTATION_LIMIT_PER_LEVEL = 10;

/** Emit annotations, at most `limit` per severity. Returns how many findings were left out. */
export function emitAnnotations(findings: Finding[], sink: AnnotationSink, limit = ANNOTATION_LIMIT_PER_LEVEL): number {
  const emitted = { error: 0, warning: 0, notice: 0 };
  let omitted = 0;
  for (const finding of findings) {
    if (emitted[finding.severity] >= limit) {
      omitted++;
      continue;
    }
    emitted[finding.severity]++;
    const properties: AnnotationProperties = { title: `DocEye: ${finding.rule}` };
    if (finding.file !== undefined) properties.file = finding.file;
    if (finding.line !== undefined) properties.startLine = finding.line;
    if (finding.column !== undefined && finding.line !== undefined) properties.startColumn = finding.column;
    const message = [finding.message, finding.details, finding.suggestion ? `Suggestion: ${finding.suggestion}` : undefined]
      .filter((part): part is string => part !== undefined && part !== "")
      .join("\n");
    sink[finding.severity](message, properties);
  }
  return omitted;
}

export type CommentTarget = { owner: string; repo: string; issue_number: number };

export type CommentClient = {
  rest: {
    issues: {
      listComments(params: CommentTarget & { per_page?: number; page?: number }): Promise<{
        data: ReadonlyArray<{ id: number; body?: string | null | undefined }>;
      }>;
      createComment(params: CommentTarget & { body: string }): Promise<unknown>;
      updateComment(params: { owner: string; repo: string; comment_id: number; body: string }): Promise<unknown>;
    };
  };
};

export type CommentOutcome = "created" | "updated" | "unchanged" | "skipped";

const MAX_COMMENT_PAGES = 10;

/**
 * Maintain a single summary comment. An existing DocEye comment (found via
 * `marker`) is updated in place, or left alone if unchanged, so repeated
 * runs never add duplicates. A clean result never creates a new comment.
 */
export async function upsertSummaryComment(
  client: CommentClient,
  target: CommentTarget,
  body: string,
  marker: string,
  hasFindings: boolean,
): Promise<CommentOutcome> {
  let existing: { id: number; body?: string | null | undefined } | undefined;
  for (let page = 1; page <= MAX_COMMENT_PAGES && existing === undefined; page++) {
    const { data } = await client.rest.issues.listComments({ ...target, per_page: 100, page });
    existing = data.find((comment) => comment.body?.includes(marker));
    if (data.length < 100) break;
  }

  if (existing) {
    if (existing.body === body) return "unchanged";
    await client.rest.issues.updateComment({ owner: target.owner, repo: target.repo, comment_id: existing.id, body });
    return "updated";
  }
  if (!hasFindings) return "skipped";
  await client.rest.issues.createComment({ ...target, body });
  return "created";
}
