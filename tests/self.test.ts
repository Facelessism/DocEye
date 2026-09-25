import path from "node:path";
import { describe, expect, it } from "vitest";
import { runDocEye } from "../src/check";

describe("dogfooding", () => {
  it("DocEye finds no documentation drift in its own repository", async () => {
    const root = path.resolve(__dirname, "..");
    const report = await runDocEye({ root, externalLinks: false });
    expect(report.findings).toEqual([]);
    expect(report.docsChecked).toContain("README.md");
  });
});
