import { describe, expect, it } from "vitest";
import { anchorsOf, parseMarkdown, slugify } from "../src/markdown";

describe("parseMarkdown", () => {
  it("extracts links, images and definitions with source positions", () => {
    const doc = parseMarkdown(
      "README.md",
      ["# Title", "", "See [setup](docs/setup.md) and ![logo](img/logo.png).", "", "[ref]: https://example.com/ref"].join("\n"),
    );
    expect(doc.links).toMatchObject([
      { url: "docs/setup.md", kind: "link", line: 3, column: 5 },
      { url: "img/logo.png", kind: "image", line: 3 },
      { url: "https://example.com/ref", kind: "definition", line: 5 },
    ]);
  });

  it("extracts href and src attributes from HTML and collects HTML anchors", () => {
    const doc = parseMarkdown("README.md", '<a name="top"></a>\n<img src="docs/banner.png" width="10">\n\n<a href="docs/a.md">a</a>');
    expect(doc.links.map((l) => [l.url, l.kind, l.line])).toEqual([
      ["docs/banner.png", "html", 2],
      ["docs/a.md", "html", 4],
    ]);
    expect(doc.htmlAnchors).toContain("top");
  });

  it("extracts fenced shell commands with the right line numbers", () => {
    const doc = parseMarkdown("README.md", ["Intro", "", "```bash", "npm install", "npm run build", "```"].join("\n"));
    expect(doc.commands.map((c) => [c.tokens.join(" "), c.line])).toEqual([
      ["npm install", 4],
      ["npm run build", 5],
    ]);
    expect(doc.codeBlocks).toMatchObject([{ lang: "bash", startLine: 4 }]);
  });

  it("does not treat non-shell code blocks as commands", () => {
    const doc = parseMarkdown("README.md", "```json\n{ \"scripts\": \"npm run x\" }\n```\n\n```js\nnpm run build\n```");
    expect(doc.commands).toHaveLength(0);
  });

  it("treats inline code that is clearly a command as a command", () => {
    const doc = parseMarkdown("README.md", "Run `pnpm build` first, then edit `src/app.ts`.");
    expect(doc.commands.map((c) => c.tokens.join(" "))).toEqual(["pnpm build"]);
    expect(doc.inlineCode.map((c) => c.value)).toEqual(["pnpm build", "src/app.ts"]);
  });

  it("marks inline code inside links", () => {
    const doc = parseMarkdown("README.md", "[`docs/a.md`](docs/a.md) and `docs/b.md`");
    expect(doc.inlineCode.map((c) => [c.value, c.insideLink])).toEqual([
      ["docs/a.md", true],
      ["docs/b.md", false],
    ]);
  });

  it("does not crash on malformed or unusual Markdown", () => {
    const inputs = [
      "",
      "\0\0\0",
      "[unclosed link](docs/x.md",
      "![](",
      "```\nunterminated fence",
      "[a]: \n[b]: <>\n",
      "<div\n<a href=\"x",
      "# ".repeat(500),
      "> > > > > `code\n\n- - - - [x](y)",
      "\r\n\r\n```bash\r\nnpm run x \\\r\n --flag\r\n```\r\n",
      "```bash\necho 'unbalanced\n```",
      "[😀](docs/emoji%ZZ.md) [x](<docs/with space.md>)",
      "\uFEFF# BOM heading",
    ];
    for (const input of inputs) expect(() => parseMarkdown("README.md", input)).not.toThrow();
  });

  it("computes GitHub-style anchors including duplicates", () => {
    expect(slugify("Getting Started!")).toBe("getting-started");
    expect(slugify("A & B")).toBe("a--b");
    expect(slugify("snake_case_heading")).toBe("snake_case_heading");
    expect(slugify("Multiple   Spaces")).toBe("multiple---spaces");
    expect(slugify("Already-Hyphenated-Heading")).toBe("already-hyphenated-heading");
    expect(slugify("Café Ünïcödé")).toBe("café-ünïcödé");
    expect(slugify("100% Done?")).toBe("100-done");
    const doc = parseMarkdown("README.md", "# Usage\n\n## Usage\n\n## `pnpm` scripts\n\n<a id=\"custom\"></a>");
    const anchors = anchorsOf(doc);
    expect(anchors.has("usage")).toBe(true);
    expect(anchors.has("usage-1")).toBe(true);
    expect(anchors.has("pnpm-scripts")).toBe(true);
    expect(anchors.has("custom")).toBe(true);
  });
});
