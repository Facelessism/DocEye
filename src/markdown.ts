import { unified } from "unified";
import remarkParse from "remark-parse";
import { extractClaims, licenseBadgeText } from "./claims";
import { commandsFromBlock, commandsFromInline, isShellLang } from "./shell";
import type { DocModel, TextBlock } from "./types";

/** The small part of the mdast shape this module relies on. */
type MdNode = {
  type: string;
  value?: string;
  url?: string;
  lang?: string | null;
  alt?: string | null;
  depth?: number;
  children?: MdNode[];
  position?: { start: { line: number; column: number } };
};

const processor = unified().use(remarkParse);

/** Text of a node without markup; used for headings and anchors. */
function plainText(node: MdNode): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value ?? "";
  if (node.type === "break") return " ";
  return (node.children ?? []).map(plainText).join("");
}

/** Inline text for claim extraction: like plainText, but inline code keeps its backticks. */
function flatten(node: MdNode): string {
  if (node.type === "text") return node.value ?? "";
  if (node.type === "inlineCode") return `\`${node.value ?? ""}\``;
  if (node.type === "break") return "\n";
  if (node.type === "html" || node.type === "image") return "";
  return (node.children ?? []).map(flatten).join("");
}

/**
 * GitHub-style heading slug: lowercase, strip punctuation, spaces to hyphens.
 * This matches GitHub's algorithm for the common cases exercised in
 * markdown.test.ts (letters, numbers, underscores, basic punctuation,
 * Unicode, duplicate headings). It is not a byte-for-byte reimplementation
 * of GitHub's slugger, so an unusual heading (heavy emoji, exotic Unicode
 * punctuation, HTML entities) could in principle slug differently than
 * GitHub renders it. The anchor rule stays warning-level, not error, partly
 * for this reason.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "")
    .replace(/ /g, "-");
}

/** All anchor names a document exposes: heading slugs (with -1, -2 duplicates) and HTML ids. */
export function anchorsOf(doc: DocModel): Set<string> {
  const anchors = new Set<string>(doc.htmlAnchors.map((a) => a.toLowerCase()));
  const counts = new Map<string, number>();
  for (const heading of doc.headings) {
    const base = slugify(heading.text);
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  return anchors;
}

export function parseMarkdown(file: string, source: string): DocModel {
  const tree = processor.parse(source) as unknown as MdNode;
  const sourceLines = source.split(/\r?\n/);
  const model: DocModel = {
    file,
    links: [],
    headings: [],
    htmlAnchors: [],
    inlineCode: [],
    codeBlocks: [],
    textBlocks: [],
    commands: [],
    claims: [],
  };
  let section: string | undefined;

  const indentColumn = (line: number): number => Math.max(1, (sourceLines[line - 1] ?? "").search(/\S/) + 1);

  const visit = (node: MdNode, inLink: boolean): void => {
    const line = node.position?.start.line ?? 1;
    const column = node.position?.start.column ?? 1;

    switch (node.type) {
      case "heading": {
        const text = plainText(node);
        model.headings.push({ text, depth: node.depth ?? 1, line, column });
        section = text;
        addTextBlock(node, line, column);
        break;
      }
      case "paragraph":
        addTextBlock(node, line, column);
        break;
      case "link":
        if (node.url) model.links.push({ file, url: node.url, kind: "link", line, column });
        break;
      case "image": {
        if (!node.url) return;
        model.links.push({ file, url: node.url, kind: "image", line, column });
        const badge = licenseBadgeText(node.alt ?? "", node.url);
        if (badge !== undefined) {
          const block: TextBlock = { file, text: badge, line, column, ...(section !== undefined ? { section } : {}) };
          model.claims.push(...extractClaims(block));
        }
        return;
      }
      case "definition":
        if (node.url) model.links.push({ file, url: node.url, kind: "definition", line, column });
        return;
      case "html":
        collectHtml(node.value ?? "", line, column);
        return;
      case "inlineCode": {
        const value = node.value ?? "";
        const before = (sourceLines[line - 1] ?? "").slice(0, column - 1).slice(-40);
        model.inlineCode.push({ file, value, before, line, column, insideLink: inLink });
        if (!inLink) {
          for (const tokens of commandsFromInline(value)) {
            model.commands.push({ file, tokens, cwd: ".", line, column: column + 1, origin: "inline-code" });
          }
        }
        return;
      }
      case "code":
        collectCode(node, line);
        return;
      default:
        break;
    }

    const childInLink = inLink || node.type === "link";
    for (const child of node.children ?? []) visit(child, childInLink);
  };

  const addTextBlock = (node: MdNode, line: number, column: number): void => {
    const text = flatten(node);
    if (text.trim() === "") return;
    const block: TextBlock = { file, text, line, column, ...(section !== undefined ? { section } : {}) };
    model.textBlocks.push(block);
    model.claims.push(...extractClaims(block));
  };

  const collectHtml = (html: string, line: number, column: number): void => {
    const locate = (index: number): { line: number; column: number } => {
      const newlines = html.slice(0, index).split("\n").length - 1;
      return { line: line + newlines, column: newlines === 0 ? column + index : 1 };
    };
    for (const m of html.matchAll(/\b(?:id|name)\s*=\s*["']([^"']+)["']/gi)) {
      model.htmlAnchors.push(m[1] as string);
    }
    for (const m of html.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
      model.links.push({ file, url: m[1] as string, kind: "html", ...locate(m.index ?? 0) });
    }
  };

  const collectCode = (node: MdNode, line: number): void => {
    const value = node.value ?? "";
    const opener = sourceLines[line - 1] ?? "";
    const fenced = opener.includes("```") || opener.includes("~~~");
    const startLine = fenced ? line + 1 : line;
    const lang = node.lang ? node.lang.toLowerCase() : undefined;
    model.codeBlocks.push({ file, value, startLine, ...(lang !== undefined ? { lang } : {}) });
    if (!isShellLang(lang)) return;
    for (const command of commandsFromBlock(value, lang)) {
      const commandLine = startLine + command.lineOffset;
      model.commands.push({
        file,
        tokens: command.tokens,
        cwd: command.cwd,
        line: commandLine,
        column: indentColumn(commandLine),
        origin: "code-block",
      });
    }
  };

  visit(tree, false);
  return model;
}
