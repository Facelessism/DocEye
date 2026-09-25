import { afterEach, describe, expect, it } from "vitest";
import { checkUrl, isPublicHost, mapWithLimit, type Transport } from "../src/http";
import { byRule, check, cleanupRepos, fakeTransport } from "./helpers";

afterEach(cleanupRepos);

const opts = (t: Transport, extra: object = {}) => ({ transport: t, timeoutMs: 200, retries: 2, backoffMs: 0, ...extra });

describe("checkUrl classification", () => {
  it("2xx is valid", async () => {
    const { transport } = fakeTransport({ "https://ok.test/": 200 });
    expect(await checkUrl("https://ok.test/", opts(transport))).toEqual({ kind: "ok", status: 200 });
  });

  it("follows a permanent redirect and reports the destination", async () => {
    const { transport } = fakeTransport({
      "https://old.test/": { status: 301, location: "https://new.test/page" },
      "https://new.test/page": 200,
    });
    expect(await checkUrl("https://old.test/", opts(transport))).toEqual({
      kind: "redirect",
      finalUrl: "https://new.test/page",
      permanent: true,
    });
  });

  it("marks temporary redirects as non-permanent and resolves relative Location headers", async () => {
    const { transport } = fakeTransport({ "https://a.test/x": { status: 302, location: "/y" }, "https://a.test/y": 200 });
    expect(await checkUrl("https://a.test/x", opts(transport))).toMatchObject({ kind: "redirect", permanent: false, finalUrl: "https://a.test/y" });
  });

  it("404 and 410 are broken", async () => {
    const { transport } = fakeTransport({ "https://a.test/gone": 410 });
    expect(await checkUrl("https://a.test/gone", opts(transport))).toMatchObject({ kind: "broken", status: 410 });
    expect(await checkUrl("https://a.test/missing", opts(transport))).toMatchObject({ kind: "broken", status: 404 });
  });

  it("403 and 429 are unverifiable rather than broken", async () => {
    const { transport } = fakeTransport({ "https://a.test/private": 403 });
    expect(await checkUrl("https://a.test/private", opts(transport))).toMatchObject({ kind: "unavailable", status: 403 });
  });

  it("5xx is unavailable and retried a bounded number of times", async () => {
    const { transport, calls } = fakeTransport({ "https://a.test/": 503 });
    const result = await checkUrl("https://a.test/", opts(transport, { retries: 2 }));
    expect(result).toMatchObject({ kind: "unavailable", status: 503 });
    // 3 attempts x (HEAD + GET fallback)
    expect(calls).toHaveLength(6);
  });

  it("network errors are unreachable", async () => {
    const { transport } = fakeTransport({ "https://down.test/": new Error("getaddrinfo ENOTFOUND") });
    expect(await checkUrl("https://down.test/", opts(transport, { retries: 0 }))).toEqual({
      kind: "unreachable",
      reason: "getaddrinfo ENOTFOUND",
    });
  });

  it("times out instead of hanging", async () => {
    const hanging: Transport = (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    const result = await checkUrl("https://slow.test/", { transport: hanging, timeoutMs: 20, retries: 0, backoffMs: 0 });
    expect(result).toEqual({ kind: "unreachable", reason: "timed out after 20ms" });
  });

  it("falls back to GET when HEAD is not supported", async () => {
    const { transport, calls } = fakeTransport({ "HEAD https://a.test/": 405, "GET https://a.test/": 200 });
    expect(await checkUrl("https://a.test/", opts(transport))).toMatchObject({ kind: "ok" });
    expect(calls.map((c) => c.method)).toEqual(["HEAD", "GET"]);
  });

  it("does not follow redirect loops forever", async () => {
    const { transport, calls } = fakeTransport({
      "https://a.test/a": { status: 302, location: "/b" },
      "https://a.test/b": { status: 302, location: "/a" },
    });
    const result = await checkUrl("https://a.test/a", opts(transport, { retries: 0, maxRedirects: 4 }));
    expect(result).toEqual({ kind: "broken", reason: "too many redirects" });
    expect(calls.length).toBeLessThan(20);
  });

  it("never contacts local or private hosts, directly or via redirect", async () => {
    const { transport, calls } = fakeTransport({ "https://evil.test/": { status: 302, location: "http://169.254.169.254/latest/meta-data" } });
    expect(await checkUrl("http://localhost:3000/", opts(transport))).toMatchObject({ kind: "skipped" });
    expect(await checkUrl("http://10.0.0.5/", opts(transport))).toMatchObject({ kind: "skipped" });
    expect(await checkUrl("http://[::1]/", opts(transport))).toMatchObject({ kind: "skipped" });
    expect(await checkUrl("https://evil.test/", opts(transport))).toMatchObject({ kind: "skipped" });
    expect(calls.map((c) => c.url)).not.toContain("http://169.254.169.254/latest/meta-data");
    expect(calls.every((c) => c.url === "https://evil.test/")).toBe(true);
  });

  it("stops starting requests after the deadline", async () => {
    const { transport, calls } = fakeTransport({});
    const result = await checkUrl("https://a.test/", opts(transport, { deadline: Date.now() - 1 }));
    expect(result).toEqual({ kind: "skipped", reason: "time budget exhausted" });
    expect(calls).toHaveLength(0);
  });

  it("classifies host safety, including IPv6 link-local and IPv4-mapped forms", () => {
    for (const host of [
      "localhost", "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.1.1", "[::1]", "intranet", "x.internal",
      "100.64.0.1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "fd00::1",
    ]) {
      expect(isPublicHost(host)).toBe(false);
    }
    for (const host of ["example.com", "github.com", "8.8.8.8", "172.32.0.1", "2001:4860:4860::8888"]) {
      expect(isPublicHost(host)).toBe(true);
    }
  });

  it("switches between HTTP and HTTPS across a redirect, and follows several distinct hops", async () => {
    const { transport } = fakeTransport({
      "https://a.test/": { status: 302, location: "http://b.test/" },
      "http://b.test/": { status: 302, location: "https://c.test/" },
      "https://c.test/": 200,
    });
    expect(await checkUrl("https://a.test/", opts(transport, { maxRedirects: 5 }))).toEqual({
      kind: "redirect",
      finalUrl: "https://c.test/",
      permanent: false,
    });
  });

  it("treats a syntactically invalid redirect Location as broken, not as a crash", async () => {
    const { transport } = fakeTransport({ "https://a.test/": { status: 302, location: "http://[not a host" } });
    expect(await checkUrl("https://a.test/", opts(transport))).toEqual({ kind: "broken", reason: "invalid redirect target" });
  });

  it("rejects a redirect to a non-http(s) scheme", async () => {
    const { transport } = fakeTransport({ "https://a.test/": { status: 302, location: "javascript:alert(1)" } });
    expect(await checkUrl("https://a.test/", opts(transport))).toEqual({ kind: "broken", reason: "invalid redirect target" });
  });
});

describe("mapWithLimit", () => {
  it("bounds concurrency and preserves order", async () => {
    let inFlight = 0;
    let max = 0;
    const results = await mapWithLimit([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, async (n) => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return n * 2;
    });
    expect(results).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
    expect(max).toBe(3);
  });
});

describe("external link findings", () => {
  const readme = (...urls: string[]) => urls.map((u, i) => `[l${i}](${u})`).join("\n");

  it("reports a broken external URL", async () => {
    const { transport } = fakeTransport({ "https://ok.test/": 200, "https://gone.test/page": 404 });
    const report = await check({ "README.md": readme("https://ok.test/", "https://gone.test/page") }, { transport });
    expect(report.findings).toMatchObject([
      { rule: "external-links", severity: "warning", message: "Broken external link: https://gone.test/page", file: "README.md", line: 2 },
    ]);
    expect(report.failed).toBe(false);
  });

  it("reports an unreachable URL as a warning that does not fail the run by default", async () => {
    const { transport } = fakeTransport({ "https://down.test/": new Error("ECONNREFUSED") });
    const report = await check({ "README.md": readme("https://down.test/") }, { transport });
    expect(report.findings[0]).toMatchObject({ severity: "warning", message: "External URL appears unreachable: https://down.test/" });
    expect(report.failed).toBe(false);
  });

  it("caps transient failures at warning even when external-links is set to error", async () => {
    const { transport } = fakeTransport({ "https://down.test/": 503, "https://gone.test/": 404 });
    const report = await check(
      { "README.md": readme("https://down.test/", "https://gone.test/"), ".doceye.yml": "rules:\n  external-links: error\n" },
      { transport },
    );
    const bySubject = Object.fromEntries(report.findings.map((f) => [f.subject, f.severity]));
    expect(bySubject).toEqual({ "https://down.test/": "warning", "https://gone.test/": "error" });
  });

  it("reports a permanent redirect as a notice and stays silent for temporary ones", async () => {
    const { transport } = fakeTransport({
      "https://old.test/": { status: 301, location: "https://new.test/" },
      "https://new.test/": 200,
      "https://tmp.test/": { status: 302, location: "https://new.test/" },
    });
    const report = await check({ "README.md": readme("https://old.test/", "https://tmp.test/") }, { transport });
    expect(report.findings).toMatchObject([
      { severity: "notice", message: "External URL permanently redirects: https://old.test/", details: expectDetails() },
    ]);
  });

  it("requests each unique URL once but reports every occurrence", async () => {
    const { transport, calls } = fakeTransport({ "https://gone.test/": 404 });
    const report = await check({ "README.md": readme("https://gone.test/", "https://gone.test/#frag", "https://gone.test/") }, { transport });
    expect(report.findings).toHaveLength(3);
    expect(calls.filter((c) => c.method === "HEAD")).toHaveLength(1);
  });

  it("bounds the number of URLs and the concurrency for a hostile README", async () => {
    const urls = Array.from({ length: 2000 }, (_, i) => `https://spam.test/${i}`);
    const routes = Object.fromEntries(urls.map((u) => [u, 200]));
    const { transport, calls, maxInFlight } = fakeTransport(routes);
    const report = await check(
      { "README.md": readme(...urls), ".doceye.yml": "external-links:\n  max-urls: 40\n  concurrency: 4\n" },
      { transport },
    );
    expect(calls.length).toBeLessThanOrEqual(40);
    expect(maxInFlight()).toBeLessThanOrEqual(4);
    expect(byRule(report.findings, "external-links")).toMatchObject([{ severity: "notice", message: "1960 external URLs were not checked" }]);
  });

  it("makes no requests when disabled, ignored, local, or rule is off", async () => {
    const { transport, calls } = fakeTransport({});
    const body = { "README.md": readme("https://a.test/", "http://localhost:8080/x", "https://b.test/ignored") };
    await check(body, { transport, externalLinks: false });
    await check({ ...body, ".doceye.yml": "external-links:\n  enabled: false\n" }, { transport });
    await check({ ...body, ".doceye.yml": "rules:\n  external-links: off\n" }, { transport });
    expect(calls).toHaveLength(0);

    const report = await check({ ...body, ".doceye.yml": 'ignore:\n  - "https://b.test/*"\n  - "https://a.test/"\n' }, { transport });
    expect(calls).toHaveLength(0);
    expect(report.findings).toHaveLength(0);
  });
});

function expectDetails(): string {
  return "It now resolves to https://new.test/. Consider updating the link.";
}
