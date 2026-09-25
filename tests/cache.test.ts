import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LinkCache, loadLinkCache, saveLinkCache } from "../src/cache";
import { runDocEye } from "../src/check";
import { ConfigError, parseConfig } from "../src/config";
import { cleanupRepos, fakeTransport, makeRepo } from "./helpers";

afterEach(cleanupRepos);

const HOUR = 3_600_000;
const OK = { kind: "ok", status: 200 } as const;

describe("LinkCache", () => {
  it("remembers only successful results", () => {
    const cache = new LinkCache(HOUR, () => 0);
    cache.set("https://a.test/", OK);
    cache.set("https://b.test/", { kind: "redirect", finalUrl: "https://c.test/", permanent: true });
    cache.set("https://broken.test/", { kind: "broken", reason: "HTTP 404" });
    cache.set("https://down.test/", { kind: "unreachable", reason: "ECONNREFUSED" });
    cache.set("https://flaky.test/", { kind: "unavailable", reason: "HTTP 503" });
    expect(cache.size).toBe(2);
    expect(cache.get("https://broken.test/")).toBeUndefined();
  });

  it("expires entries after the time-to-live", () => {
    let now = 0;
    const cache = new LinkCache(HOUR, () => now);
    cache.set("https://a.test/", OK);
    now = HOUR - 1;
    expect(cache.get("https://a.test/")).toEqual(OK);
    now = HOUR + 1;
    expect(cache.get("https://a.test/")).toBeUndefined();
  });

  it("stores nothing when the time-to-live is zero", () => {
    const cache = new LinkCache(0, () => 0);
    cache.set("https://a.test/", OK);
    expect(cache.size).toBe(0);
  });
});

describe("loading and saving", () => {
  it("round-trips entries through a file", async () => {
    const root = await makeRepo({});
    const first = new LinkCache(HOUR, () => 1000);
    first.set("https://a.test/", OK);
    expect(await saveLinkCache(root, ".doceye-cache/links.json", first)).toBeUndefined();

    const loaded = await loadLinkCache(root, ".doceye-cache/links.json", 1, () => 2000);
    expect(loaded.problem).toBeUndefined();
    expect(loaded.cache.get("https://a.test/")).toEqual(OK);
    const leftovers = (await fs.readdir(path.join(root, ".doceye-cache"))).filter((n) => n.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("does not write a file when nothing changed", async () => {
    const root = await makeRepo({});
    expect(await saveLinkCache(root, "cache.json", new LinkCache(HOUR))).toBeUndefined();
    await expect(fs.stat(path.join(root, "cache.json"))).rejects.toThrow();
  });

  it("drops expired, future-dated and malformed entries but keeps valid ones", async () => {
    const now = 10 * HOUR;
    const file = JSON.stringify({
      version: 1,
      entries: {
        "https://fresh.test/": { at: now - 1000, result: { kind: "ok", status: 200 } },
        "https://old.test/": { at: 0, result: { kind: "ok", status: 200 } },
        "https://future.test/": { at: now + 1000 * HOUR, result: { kind: "ok", status: 200 } },
        "https://bad-status.test/": { at: now, result: { kind: "ok", status: 999 } },
        "https://bad-kind.test/": { at: now, result: { kind: "broken", reason: "x" } },
        "https://bad-redirect.test/": { at: now, result: { kind: "redirect", finalUrl: "javascript:alert(1)", permanent: true } },
        "https://no-at.test/": { result: { kind: "ok", status: 200 } },
        "https://string-at.test/": { at: "yesterday", result: { kind: "ok", status: 200 } },
      },
    });
    const root = await makeRepo({ "c.json": file });
    const { cache, problem } = await loadLinkCache(root, "c.json", 5, () => now);
    expect(problem).toBeUndefined();
    expect(cache.size).toBe(1);
    expect(cache.get("https://fresh.test/")).toEqual(OK);
  });

  it("ignores files that are not a DocEye cache, with a problem report and no crash", async () => {
    for (const content of ["not json", "[]", "null", '{"version":2,"entries":{}}', '{"version":1}', '{"version":1,"entries":[]}']) {
      const root = await makeRepo({ "c.json": content });
      const loaded = await loadLinkCache(root, "c.json", 1);
      expect(loaded.cache.size).toBe(0);
      expect(loaded.problem).toContain("not a DocEye cache file");
    }
  });

  it("refuses to overwrite an existing file that is not a cache", async () => {
    const root = await makeRepo({ "package.json": '{"name":"precious"}' });
    const cache = new LinkCache(HOUR);
    cache.set("https://a.test/", OK);
    expect(await saveLinkCache(root, "package.json", cache)).toContain("was not overwritten");
    expect(await fs.readFile(path.join(root, "package.json"), "utf8")).toBe('{"name":"precious"}');
  });

  it("refuses paths outside the repository and non-json files", async () => {
    const root = await makeRepo({});
    const cache = new LinkCache(HOUR);
    cache.set("https://a.test/", OK);
    expect(await saveLinkCache(root, "../escape.json", cache)).toContain("must be a .json file inside the repository");
    expect(await saveLinkCache(root, "cache.txt", cache)).toContain("must be a .json file");
    expect(await saveLinkCache(root, "/tmp/abs.json", cache)).toContain("must be a .json file");
  });

  it("refuses to write through a symlinked directory that leaves the repository", async () => {
    const outside = await makeRepo({});
    const root = await makeRepo({});
    await fs.symlink(outside, path.join(root, "linked"));
    const cache = new LinkCache(HOUR);
    cache.set("https://a.test/", OK);
    expect(await saveLinkCache(root, "linked/cache.json", cache)).toContain("could not be written");
    expect(await fs.readdir(outside)).toEqual([]);
  });
});

describe("cache configuration", () => {
  it("validates cache options", () => {
    expect(parseConfig("external-links:\n  cache-file: .doceye-cache/links.json\n  cache-hours: 24").externalLinks).toMatchObject({
      cacheFile: ".doceye-cache/links.json",
      cacheHours: 24,
    });
    for (const bad of ["../x.json", "x.txt", "/abs/x.json", "123"]) {
      expect(() => parseConfig(`external-links:\n  cache-file: ${bad}`)).toThrow(ConfigError);
    }
    expect(() => parseConfig("external-links:\n  cache-hours: 9999")).toThrow("cache-hours");
  });
});

describe("cache in a run", () => {
  const readme = "[ok](https://ok.test/) [gone](https://gone.test/)\n";
  const config = "external-links:\n  cache-file: .doceye-cache/links.json\n  cache-hours: 24\n";
  const routes = { "https://ok.test/": 200, "https://gone.test/": 404 };

  it("skips URLs that were fine on an earlier run, but always rechecks broken ones", async () => {
    const root = await makeRepo({ "README.md": readme, ".doceye.yml": config });
    const first = fakeTransport(routes);
    const run1 = await runDocEye({ root, transport: first.transport, backoffMs: 0, now: () => 1000 });
    expect(first.calls.map((c) => c.url).sort()).toEqual(["https://gone.test/", "https://gone.test/", "https://ok.test/"]);
    expect(run1.findings.map((f) => f.subject)).toEqual(["https://gone.test/"]);

    const second = fakeTransport(routes);
    const run2 = await runDocEye({ root, transport: second.transport, backoffMs: 0, now: () => 2000 });
    expect(second.calls.some((c) => c.url === "https://ok.test/")).toBe(false);
    expect(second.calls.some((c) => c.url === "https://gone.test/")).toBe(true);
    expect(run2.findings.map((f) => f.subject)).toEqual(["https://gone.test/"]);
  });

  it("checks a URL again once its entry has expired", async () => {
    const root = await makeRepo({ "README.md": readme, ".doceye.yml": config });
    await runDocEye({ root, transport: fakeTransport(routes).transport, backoffMs: 0, now: () => 0 });
    const later = fakeTransport(routes);
    await runDocEye({ root, transport: later.transport, backoffMs: 0, now: () => 25 * HOUR });
    expect(later.calls.some((c) => c.url === "https://ok.test/")).toBe(true);
  });

  it("does not let cached URLs count against the request cap", async () => {
    const urls = Array.from({ length: 6 }, (_, i) => `https://s.test/${i}`);
    const routesAll = Object.fromEntries(urls.map((u) => [u, 200]));
    const root = await makeRepo({
      "README.md": urls.map((u) => `[x](${u})`).join(" "),
      ".doceye.yml": "external-links:\n  cache-file: c.json\n  max-urls: 3\n",
    });
    const first = fakeTransport(routesAll);
    const run1 = await runDocEye({ root, transport: first.transport, backoffMs: 0, now: () => 0 });
    expect(new Set(first.calls.map((c) => c.url)).size).toBe(3);
    expect(run1.findings.map((f) => f.message)).toEqual(["3 external URLs were not checked"]);

    const second = fakeTransport(routesAll);
    const run2 = await runDocEye({ root, transport: second.transport, backoffMs: 0, now: () => 1 });
    expect(new Set(second.calls.map((c) => c.url)).size).toBe(3); // the other three
    expect(run2.findings).toEqual([]);
  });

  it("reports, but survives, a crafted cache path that points at a real file", async () => {
    const root = await makeRepo({
      "README.md": readme,
      "package.json": '{"name":"precious"}',
      ".doceye.yml": "external-links:\n  cache-file: package.json\n",
    });
    const report = await runDocEye({ root, transport: fakeTransport(routes).transport, backoffMs: 0 });
    expect(report.findings.map((f) => f.rule)).toContain("doceye");
    expect(report.findings.some((f) => f.message.includes("is not a DocEye cache file"))).toBe(true);
    expect(await fs.readFile(path.join(root, "package.json"), "utf8")).toBe('{"name":"precious"}');
  });

  it("rejects an invalid cacheFile option", async () => {
    const root = await makeRepo({ "README.md": "x" });
    await expect(runDocEye({ root, cacheFile: "../x.json", externalLinks: false })).rejects.toThrow(ConfigError);
  });

  it("does not create a cache file when external links are off", async () => {
    const root = await makeRepo({ "README.md": readme, ".doceye.yml": config });
    await runDocEye({ root, externalLinks: false });
    await expect(fs.stat(path.join(root, ".doceye-cache"))).rejects.toThrow();
  });
});
