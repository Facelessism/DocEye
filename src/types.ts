export type Severity = "error" | "warning" | "notice";
export type Level = Severity | "off";
export type FailOn = Severity | "none";

export const RULES = [
  "local-links",
  "anchors",
  "external-links",
  "package-manager",
  "package-scripts",
  "commands",
  "paths",
  "config-files",
  "runtime",
  "workflows",
  "docker",
  "license",
] as const;
export type RuleName = (typeof RULES)[number];

export const RULE_DESCRIPTIONS: Record<RuleName | "doceye", string> = {
  "local-links": "Relative links, images and HTML references must point to files that exist.",
  anchors: "Link fragments must match a heading or HTML anchor in the target file.",
  "external-links": "External http(s) URLs should respond successfully.",
  "package-manager": "Documented package manager usage should match the repository.",
  "package-scripts": "Documented package scripts must be defined in package.json.",
  commands: "Documented node commands must refer to files that exist.",
  paths: "File paths written as inline code should exist.",
  "config-files": "Documented configuration locations must exist.",
  runtime: "A documented Node.js requirement should not be stricter than the declared engine.",
  workflows: "Referenced GitHub workflow files and badges must exist.",
  docker: "Documented Docker and Compose commands and files must exist.",
  license: "The license named in the documentation should match the repository.",
  doceye: "DocEye could not fully analyze part of the repository.",
};

export const SEVERITY_RANK: Record<Severity, number> = { notice: 0, warning: 1, error: 2 };

/**
 * A single documentation inconsistency. `rule` is a string so that meta
 * findings (e.g. a missing README) can use the reserved rule name "doceye".
 */
export type Finding = {
  rule: string;
  severity: Severity;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  /** The thing the documentation refers to (URL, path, script name). Used by `ignore`. */
  subject?: string;
  /** Repository evidence explaining why this is a finding. */
  details?: string;
  /** A concrete fix derived from repository facts, e.g. the closest existing script name. */
  suggestion?: string;
};

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

// ---------------------------------------------------------------------------
// Documentation model (produced by markdown.ts, consumed by checks)
// ---------------------------------------------------------------------------

export type SourceLocation = { line: number; column: number };

export type LinkRef = SourceLocation & {
  file: string;
  url: string;
  kind: "link" | "image" | "definition" | "html";
};

export type Heading = SourceLocation & { text: string; depth: number };

export type InlineCodeRef = SourceLocation & {
  file: string;
  value: string;
  /** Up to 40 characters of prose preceding the code span in the same block. */
  before: string;
  insideLink: boolean;
};

export type CodeBlock = {
  file: string;
  lang?: string;
  value: string;
  /** Line of the first line of `value` in the source file. */
  startLine: number;
};

export type TextBlock = SourceLocation & {
  file: string;
  /** Flattened inline text; inline code is wrapped in backticks. */
  text: string;
  /** Text of the nearest preceding heading, if any. */
  section?: string;
};

export type DocCommand = SourceLocation & {
  file: string;
  /** Directory (repo-relative, "." for the root) the command runs in, after any documented `cd`. */
  cwd: string;
  /** One simple command (already split on `&&`, `;`, `|`). */
  tokens: string[];
  origin: "code-block" | "inline-code";
};

export type Claim =
  | { kind: "package-manager"; manager: PackageManager }
  | { kind: "node-version"; major: number; text: string }
  | { kind: "docker-support" }
  | { kind: "config-location"; path: string }
  | { kind: "license"; id: string };

export type DocClaim = SourceLocation & { file: string; claim: Claim };

export type DocModel = {
  file: string;
  links: LinkRef[];
  headings: Heading[];
  /** Explicit HTML anchors (`id="x"`, `name="x"`). */
  htmlAnchors: string[];
  inlineCode: InlineCodeRef[];
  codeBlocks: CodeBlock[];
  textBlocks: TextBlock[];
  commands: DocCommand[];
  claims: DocClaim[];
};

// ---------------------------------------------------------------------------
// Claim verification
// ---------------------------------------------------------------------------

export type Verification = {
  verdict: "supported" | "contradicted" | "unknown";
  /** Human-readable repository evidence. */
  evidence?: string;
};
