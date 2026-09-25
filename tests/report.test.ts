import { describe, expect, it } from "vitest";
import { emitAnnotations, upsertSummaryComment, type CommentClient } from "../src/github";
import { COMMENT_MARKER, countBySeverity, formatComment, formatText } from "../src/report";
import type { Finding } from "../src/types";

const findings: Finding[] = [
  { rule: "local-links", severity: "error", message: "Broken local link: docs/setup.md", file: "README.md", line: 42, column: 3, details: "No file exists." },
  { rule: "package-manager", severity: "warning", message: "README.md uses npm, but repository configuration indicates pnpm.", file: "README.md", line: 17 },
  { rule: "external-links", severity: "notice", message: "External URL permanently redirects: https://a.test/" },
];

describe("formatText", () => {
  it("summarizes findings with locations", () => {
    const text = formatText(findings);
    expect(text.split("\n")[0]).toBe("DocEye found 3 documentation issues (1 error, 1 warning, 1 notice).");
    expect(text).toContain("ERROR [local-links]\nREADME.md:42\nBroken local link: docs/setup.md\n  No file exists.");
    expect(text).toContain("NOTICE [external-links]\nExternal URL permanently redirects");
  });

  it("says so when everything is consistent", () => {
    expect(formatText([])).toBe("DocEye found no documentation issues.");
    expect(countBySeverity(findings)).toEqual({ error: 1, warning: 1, notice: 1 });
  });
});

describe("formatComment", () => {
  it("is a single marked summary and neutralizes mentions and markup from repository text", () => {
    const body = formatComment([{ rule: "x", severity: "warning", message: "Broken external link: https://x.test/@octocat <script>`a`" }]);
    expect(body.startsWith(COMMENT_MARKER)).toBe(true);
    expect(body).not.toContain("@octocat");
    expect(body).not.toContain("<script>");
  });

  it("caps the number of listed findings", () => {
    const many = Array.from({ length: 100 }, (_, i): Finding => ({ rule: "x", severity: "notice", message: `m${i}` }));
    const body = formatComment(many);
    expect(body.split("\n").filter((l) => l.startsWith("- ")).length).toBe(31);
    expect(body).toContain("and 70 more");
  });
});

function sinkCollecting(): { sink: { error: (m: string, p?: object) => void; warning: (m: string, p?: object) => void; notice: (m: string, p?: object) => void }; calls: Array<[string, string, object | undefined]> } {
  const calls: Array<[string, string, object | undefined]> = [];
  return {
    calls,
    sink: {
      error: (m, p) => calls.push(["error", m, p]),
      warning: (m, p) => calls.push(["warning", m, p]),
      notice: (m, p) => calls.push(["notice", m, p]),
    },
  };
}

describe("emitAnnotations", () => {
  it("maps severities to annotation levels with file and line", () => {
    const { sink, calls } = sinkCollecting();
    const omitted = emitAnnotations(findings, sink);
    expect(omitted).toBe(0);
    expect(calls.map((c) => c[0])).toEqual(["error", "warning", "notice"]);
    expect(calls[0]).toEqual([
      "error",
      "Broken local link: docs/setup.md\nNo file exists.",
      { title: "DocEye: local-links", file: "README.md", startLine: 42, startColumn: 3 },
    ]);
    expect(calls[2]?.[2]).toEqual({ title: "DocEye: external-links" });
  });

  it("includes a finding's suggestion in the annotation message", () => {
    const { sink, calls } = sinkCollecting();
    emitAnnotations([{ rule: "paths", severity: "warning", message: "m", suggestion: "Did you mean x?" }], sink);
    expect(calls[0]?.[1]).toBe("m\nSuggestion: Did you mean x?");
  });

  it("caps annotations per severity and reports how many were left out", () => {
    const many: Finding[] = Array.from({ length: 15 }, (_, i): Finding => ({ rule: "x", severity: "error", message: `e${i}` }));
    const { sink, calls } = sinkCollecting();
    const omitted = emitAnnotations(many, sink, 10);
    expect(calls).toHaveLength(10);
    expect(omitted).toBe(5);
  });
});

function fakeClient(existing: Array<{ id: number; body: string }> = []) {
  const log: string[] = [];
  const client: CommentClient = {
    rest: {
      issues: {
        listComments: async () => ({ data: existing }),
        createComment: async (p) => void log.push(`create:${p.body}`),
        updateComment: async (p) => void log.push(`update:${p.comment_id}:${p.body}`),
      },
    },
  };
  return { client, log };
}

describe("upsertSummaryComment", () => {
  const target = { owner: "o", repo: "r", issue_number: 1 };
  const body = `${COMMENT_MARKER}\nnew`;

  it("creates a comment when findings exist and none is present", async () => {
    const { client, log } = fakeClient([{ id: 9, body: "unrelated" }]);
    expect(await upsertSummaryComment(client, target, body, COMMENT_MARKER, true)).toBe("created");
    expect(log).toEqual([`create:${body}`]);
  });

  it("updates its own earlier comment instead of adding another", async () => {
    const { client, log } = fakeClient([{ id: 5, body: `${COMMENT_MARKER}\nold` }]);
    expect(await upsertSummaryComment(client, target, body, COMMENT_MARKER, true)).toBe("updated");
    expect(log).toEqual([`update:5:${body}`]);
  });

  it("does nothing when the comment is unchanged", async () => {
    const { client, log } = fakeClient([{ id: 5, body }]);
    expect(await upsertSummaryComment(client, target, body, COMMENT_MARKER, true)).toBe("unchanged");
    expect(log).toEqual([]);
  });

  it("never creates a comment for a clean run, but refreshes a stale one", async () => {
    const clean = `${COMMENT_MARKER}\nclean`;
    const none = fakeClient();
    expect(await upsertSummaryComment(none.client, target, clean, COMMENT_MARKER, false)).toBe("skipped");
    const stale = fakeClient([{ id: 3, body: `${COMMENT_MARKER}\nold problems` }]);
    expect(await upsertSummaryComment(stale.client, target, clean, COMMENT_MARKER, false)).toBe("updated");
  });
});
