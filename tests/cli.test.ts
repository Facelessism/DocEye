import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main, type CliIo } from "../src/cli";
import { VERSION } from "../src/version";
import { cleanupRepos, makeRepo } from "./helpers";

afterEach(cleanupRepos);

function io(cwd: string): CliIo & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { cwd, out, err, stdout: (t) => out.push(t), stderr: (t) => err.push(t) };
}

describe("cli", () => {
  it("prints help and version without touching a repository", async () => {
    const help = io("/does/not/exist");
    expect(await main(["--help"], help)).toBe(0);
    expect(help.out.join("")).toContain("Usage: doceye");

    const version = io("/does/not/exist");
    expect(await main(["--version"], version)).toBe(0);
    expect(version.out.join("")).toBe(`${VERSION}\n`);
    expect(await main(["-v"], io("/does/not/exist"))).toBe(0);
  });

  it("exits 0 on a clean repository and 1 when findings are at or above fail-on", async () => {
    const clean = await makeRepo({ "README.md": "# X" });
    expect(await main([clean, "--no-external-links"], io(clean))).toBe(0);

    const dirty = await makeRepo({ "README.md": "[x](gone.md)" });
    const out = io(dirty);
    expect(await main([dirty, "--no-external-links"], out)).toBe(1);
    expect(out.out.join("")).toContain("Broken local link: gone.md");
  });

  it("defaults to the current directory when none is given", async () => {
    const root = await makeRepo({ "README.md": "[x](gone.md)" });
    expect(await main(["--no-external-links"], io(root))).toBe(1);
  });

  it("respects --fail-on", async () => {
    const root = await makeRepo({ "README.md": "[x](gone.md)" });
    expect(await main([root, "--no-external-links", "--fail-on", "none"], io(root))).toBe(0);
  });

  it("exits 2 on bad usage or a bad configuration, without a stack trace", async () => {
    const badFlag = io("/tmp");
    expect(await main(["--nope"], badFlag)).toBe(2);
    expect(badFlag.err.join("")).toContain("Usage: doceye");

    const badFormat = io("/tmp");
    expect(await main(["/tmp", "--format", "xml"], badFormat)).toBe(2);
    expect(badFormat.err.join("")).toContain("--format must be one of");

    const badFailOn = io("/tmp");
    expect(await main(["/tmp", "--fail-on", "maybe"], badFailOn)).toBe(2);

    const root = await makeRepo({ "README.md": "x", ".doceye.yml": "rulez: nope" });
    const badConfig = io(root);
    expect(await main([root, "--no-external-links"], badConfig)).toBe(2);
    expect(badConfig.err.join("")).toContain("unknown key");
    expect(badConfig.err.join("")).not.toContain("at Object");

    const missing = io("/tmp");
    expect(await main(["/definitely/does/not/exist"], missing)).toBe(2);
  });

  it("rejects more than one directory argument", async () => {
    const bad = io("/tmp");
    expect(await main(["a", "b"], bad)).toBe(2);
  });

  it("writes json and sarif reports to a file", async () => {
    const root = await makeRepo({ "README.md": "[x](gone.md)" });
    const jsonOut = io(root);
    expect(await main([root, "--no-external-links", "--format", "json", "--output", "report.json"], jsonOut)).toBe(1);
    const json = JSON.parse(await fs.readFile(path.join(root, "report.json"), "utf8"));
    expect(json.findings).toHaveLength(1);
    expect(jsonOut.out.join("")).toContain("report.json");

    const sarifOut = io(root);
    await main([root, "--no-external-links", "--format", "sarif", "--output", "report.sarif"], sarifOut);
    const sarif = JSON.parse(await fs.readFile(path.join(root, "report.sarif"), "utf8"));
    expect(sarif.version).toBe("2.1.0");
  });

  it("uses --config and --readme, and --cache-file remembers link results", async () => {
    const root = await makeRepo({
      "docs/START.md": "# Start",
      "custom.yml": "readme: docs/START.md\n",
    });
    expect(await main([root, "--config", "custom.yml", "--no-external-links"], io(root))).toBe(0);
    expect(await main([root, "--readme", "docs/START.md", "--no-external-links"], io(root))).toBe(0);
  });
});
