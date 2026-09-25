import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, defaultConfig, globToRegExp, isIgnored, loadConfig, parseConfig } from "../src/config";
import { shouldFail } from "../src/report";
import type { Finding } from "../src/types";
import { check, cleanupRepos, makeRepo } from "./helpers";

afterEach(cleanupRepos);

const finding = (severity: Finding["severity"]): Finding => ({ rule: "x", severity, message: "m" });

describe("parseConfig", () => {
  it("returns defaults for empty input", () => {
    expect(parseConfig("")).toEqual(defaultConfig());
    expect(parseConfig("# only a comment\n")).toEqual(defaultConfig());
  });

  it("reads the documented options", () => {
    const config = parseConfig(
      [
        "readme: docs/README.md",
        "rules:",
        "  local-links: warning",
        "  package-scripts: off",
        "ignore:",
        '  - "https://example.com/temporary"',
        "  - docs/legacy.md",
        "external-links:",
        "  enabled: false",
        "  max-urls: 10",
        "fail-on: warning",
      ].join("\n"),
    );
    expect(config.readme).toBe("docs/README.md");
    expect(config.rules["local-links"]).toBe("warning");
    expect(config.rules["package-scripts"]).toBe("off");
    expect(config.rules["external-links"]).toBe("warning");
    expect(config.ignore).toEqual(["https://example.com/temporary", "docs/legacy.md"]);
    expect(config.externalLinks).toMatchObject({ enabled: false, maxUrls: 10 });
    expect(config.failOn).toBe("warning");
  });

  it("rejects typos and invalid values with a clear message", () => {
    expect(() => parseConfig("rulez: {}")).toThrow('unknown key "rulez"');
    expect(() => parseConfig("rules:\n  local-link: error")).toThrow('unknown rule "local-link"');
    expect(() => parseConfig("rules:\n  local-links: fatal")).toThrow('rule "local-links" must be one of');
    expect(() => parseConfig("fail-on: sometimes")).toThrow("fail-on");
    expect(() => parseConfig("external-links:\n  max-urls: -1")).toThrow("max-urls");
    expect(() => parseConfig("external-links:\n  turbo: true")).toThrow("external-links.turbo");
    expect(() => parseConfig("ignore: docs/x.md")).toThrow("list of strings");
    expect(() => parseConfig("- a\n- b")).toThrow("mapping");
    expect(() => parseConfig("a: [unclosed")).toThrow(ConfigError);
  });
});

describe("loadConfig", () => {
  it("discovers .doceye.yml, then doceye.yml, and falls back to defaults", async () => {
    const both = await makeRepo({ ".doceye.yml": "fail-on: warning", "doceye.yml": "fail-on: notice" });
    expect((await loadConfig(both)).config.failOn).toBe("warning");
    const second = await makeRepo({ "doceye.yml": "fail-on: notice" });
    expect(await loadConfig(second)).toMatchObject({ path: "doceye.yml", config: { failOn: "notice" } });
    const none = await makeRepo({});
    expect((await loadConfig(none)).path).toBeUndefined();
  });

  it("fails when an explicitly named config file is missing", async () => {
    const root = await makeRepo({});
    await expect(loadConfig(root, "nope.yml")).rejects.toThrow("config file not found: nope.yml");
  });
});

describe("ignore matching", () => {
  it("matches exact values, globs, files and subjects", () => {
    const config = { ignore: ["https://example.com/temporary", "docs/legacy/**", "*.draft.md", "docs/old.md"] };
    expect(isIgnored(config, "README.md", "https://example.com/temporary")).toBe(true);
    expect(isIgnored(config, "docs/legacy/a/b.md", undefined)).toBe(true);
    expect(isIgnored(config, "notes.draft.md", undefined)).toBe(true);
    expect(isIgnored(config, "README.md", "docs/old.md")).toBe(true);
    expect(isIgnored(config, "README.md", "https://example.com/other")).toBe(false);
    expect(isIgnored(config, undefined, undefined)).toBe(false);
  });

  it("escapes regex metacharacters in patterns", () => {
    expect(globToRegExp("a.b").test("axb")).toBe(false);
    expect(globToRegExp("https://x.test/?q=1").test("https://x.test/aq=1")).toBe(false);
    expect(globToRegExp("https://x.test/?q=1").test("https://x.test/?q=1")).toBe(true);
    expect(globToRegExp("docs/*.md").test("docs/a/b.md")).toBe(false);
  });

  it("removes ignored findings and skips ignored files entirely", async () => {
    const files = {
      "README.md": "[a](docs/gone.md) [b](docs/legacy.md) [c](docs/keep-gone.md)",
      "docs/legacy.md": "[x](missing-in-legacy.md)",
    };
    const all = await check(files);
    expect(all.findings.map((f) => f.subject).sort()).toEqual(["docs/gone.md", "docs/keep-gone.md", "docs/missing-in-legacy.md"]);
    const ignored = await check({ ...files, ".doceye.yml": "ignore:\n  - docs/gone.md\n  - docs/legacy.md\n" });
    expect(ignored.findings.map((f) => f.subject)).toEqual(["docs/keep-gone.md"]);
    expect(ignored.docsChecked).toEqual(["README.md"]);
  });
});

describe("severity and failure threshold", () => {
  it("applies the configured severity per rule", async () => {
    const files = { "README.md": "[a](docs/gone.md)" };
    expect((await check(files)).findings[0]?.severity).toBe("error");
    expect((await check({ ...files, ".doceye.yml": "rules:\n  local-links: notice\n" })).findings[0]?.severity).toBe("notice");
    expect((await check({ ...files, ".doceye.yml": "rules:\n  local-links: off\n" })).findings).toHaveLength(0);
  });

  it("decides failure from the threshold", () => {
    const list = [finding("notice"), finding("warning")];
    expect(shouldFail(list, "error")).toBe(false);
    expect(shouldFail(list, "warning")).toBe(true);
    expect(shouldFail(list, "notice")).toBe(true);
    expect(shouldFail([finding("error")], "none")).toBe(false);
    expect(shouldFail([], "notice")).toBe(false);
  });

  it("takes fail-on from the config file, with an option override", async () => {
    const files = { "README.md": "Licensed under MIT.", ".doceye.yml": "fail-on: warning\n" };
    expect((await check(files)).failed).toBe(true);
    expect((await check(files, { failOn: "error" })).failed).toBe(false);
    expect((await check({ "README.md": "[a](gone.md)" }, { failOn: "none" })).failed).toBe(false);
  });
});
