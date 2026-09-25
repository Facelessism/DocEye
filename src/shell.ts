import path from "node:path";

/**
 * Static shell-command extraction. Nothing here evaluates or executes input:
 * a documentation snippet is tokenized into simple commands and that is all.
 */

const SHELL_LANGS = new Set(["", "bash", "sh", "shell", "zsh", "console", "terminal", "shell-session", "sh-session"]);
const PROMPT_ONLY_LANGS = new Set(["console", "terminal", "shell-session", "sh-session"]);
const KNOWN_EXECUTABLES = new Set(["npm", "pnpm", "yarn", "bun", "node", "docker", "docker-compose", "npx"]);

export function isShellLang(lang: string | undefined): boolean {
  return SHELL_LANGS.has((lang ?? "").toLowerCase());
}

/**
 * Split one logical command line into simple commands on `;`, `&&`, `||`, `|`
 * and `&`. Quotes and backslash escapes are honoured. Redirections and
 * comments end a command. Returns [] when quoting is unbalanced.
 */
export function splitCommandLine(input: string): string[][] {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let current = "";
  let hasToken = false;
  let quote: string | null = null;
  let skipRest = false;

  const pushToken = (): void => {
    if (hasToken) tokens.push(current);
    current = "";
    hasToken = false;
  };
  const pushSegment = (): void => {
    pushToken();
    if (tokens.length > 0) segments.push(tokens);
    tokens = [];
    skipRest = false;
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i] as string;
    const next = input[i + 1];

    if (quote !== null) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && next !== undefined) current += input[++i];
      else current += ch;
      continue;
    }

    if (ch === ";" || (ch === "&" && next === "&") || (ch === "|" && next === "|")) {
      pushSegment();
      if (ch !== ";") i++;
      continue;
    }
    if (ch === "|" || ch === "&") {
      if (skipRest && ch === "&") continue; // the & in `2>&1`
      pushSegment();
      continue;
    }
    if (skipRest) continue;

    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
    } else if (ch === "\\" && next !== undefined) {
      current += input[++i];
      hasToken = true;
    } else if (ch === "#" && !hasToken) {
      skipRest = true;
    } else if (ch === ">" || ch === "<") {
      if (/^\d+$/.test(current)) {
        current = "";
        hasToken = false;
      }
      pushToken();
      skipRest = true;
    } else if (/\s/.test(ch)) {
      pushToken();
    } else {
      current += ch;
      hasToken = true;
    }
  }

  if (quote !== null) return [];
  pushSegment();
  return segments.map(stripPrefixes).filter((segment) => segment.length > 0);
}

/** Drop leading `KEY=value` assignments and `sudo`/`time`. */
function stripPrefixes(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i] as string;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || token === "sudo" || token === "time") i++;
    else break;
  }
  return tokens.slice(i);
}

export type BlockCommand = { tokens: string[]; lineOffset: number; cwd: string };

/** The directory after `cd <target>`, or undefined when it cannot be known statically. */
function changeDirectory(cwd: string, target: string | undefined): string | undefined {
  if (target === undefined || /^[/~-]|[$*{}`\\]/.test(target)) return undefined;
  const next = path.posix.normalize(path.posix.join(cwd, target));
  return next === ".." || next.startsWith("../") ? undefined : next;
}

/**
 * Extract commands from a fenced shell block. `lineOffset` is the 0-based line
 * within the block where the command starts and `cwd` the repo-relative
 * directory it runs in: a documented `cd packages/web` moves later commands
 * there. Once the directory cannot be known (absolute, `~`, variables, `..`
 * out of the repository) the rest of the block is skipped. `git clone x && cd x`
 * enters the repository root, so that first `cd` does not count.
 */
export function commandsFromBlock(value: string, lang: string | undefined): BlockCommand[] {
  const promptOnly = PROMPT_ONLY_LANGS.has((lang ?? "").toLowerCase());
  const lines = value.split(/\r?\n/);
  const out: BlockCommand[] = [];
  let cwd: string | undefined = ".";
  let cloned = false;
  let enteredClone = false;

  for (let i = 0; i < lines.length; i++) {
    const startIndex = i;
    let logical = lines[i] as string;
    while (logical.trimEnd().endsWith("\\") && i + 1 < lines.length) {
      logical = logical.trimEnd().slice(0, -1) + " " + (lines[++i] as string);
    }

    const prompt = /^\s*\$\s+/.exec(logical);
    if (promptOnly && !prompt) continue;
    const text = prompt ? logical.slice(prompt[0].length) : logical;
    if (/^\s*(#|\/\/)/.test(text)) continue;

    for (const tokens of splitCommandLine(text)) {
      if (tokens[0] === "git" && tokens[1] === "clone") cloned = true;
      if (tokens[0] === "cd" || tokens[0] === "pushd") {
        if (cloned && !enteredClone) enteredClone = true;
        else if (cwd !== undefined) cwd = changeDirectory(cwd, tokens[1]);
        continue;
      }
      if (tokens[0] === "popd") cwd = undefined;
      if (cwd !== undefined) out.push({ tokens, lineOffset: startIndex, cwd });
    }
  }
  return out;
}

/**
 * Inline code is only treated as a command when it starts with a known tool
 * and has arguments, so a bare tool name in prose (`yarn`) is not a command.
 */
export function commandsFromInline(value: string): string[][] {
  return splitCommandLine(value).filter(
    (tokens) => KNOWN_EXECUTABLES.has(tokens[0] as string) && tokens.length >= 2,
  );
}
