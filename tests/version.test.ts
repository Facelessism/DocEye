import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version";

describe("version", () => {
  it("matches package.json, so the published version is always accurate", async () => {
    const pkg = JSON.parse(await fs.readFile(path.resolve(__dirname, "../package.json"), "utf8"));
    expect(VERSION).toBe(pkg.version);
  });

  it("is a plain semantic version", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
