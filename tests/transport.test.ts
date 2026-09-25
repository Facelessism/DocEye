import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { checkUrl, createGuardedLookup, createNodeTransport } from "../src/http";

type Hits = { count: number; methods: string[] };

async function withServer(fn: (port: number, hits: Hits) => Promise<void>): Promise<void> {
  const hits: Hits = { count: 0, methods: [] };
  const server = http.createServer((req, res) => {
    hits.count++;
    hits.methods.push(req.method ?? "");
    if (req.url === "/moved") res.writeHead(301, { location: "/new" });
    else if (req.url === "/missing") res.writeHead(404);
    else if (req.url === "/hang") return; // never answers
    else res.writeHead(200);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await fn((server.address() as AddressInfo).port, hits);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

const signal = () => new AbortController().signal;

describe("createGuardedLookup", () => {
  const lookup = (addresses: string[]) => createGuardedLookup(async () => addresses.map((address) => ({ address })));
  const run = (fn: ReturnType<typeof createGuardedLookup>, all: boolean) =>
    new Promise<{ error: Error | null; result: unknown }>((resolve) => {
      (fn as (h: string, o: object, cb: (e: Error | null, a: unknown, f?: number) => void) => void)("x.test", { all }, (error, result) =>
        resolve({ error, result }),
      );
    });

  it("passes public addresses through in both callback shapes", async () => {
    const guarded = lookup(["93.184.216.34"]);
    expect((await run(guarded, false)).result).toBe("93.184.216.34");
    expect((await run(guarded, true)).result).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("refuses private, loopback, link-local and metadata addresses", async () => {
    for (const address of ["10.0.0.5", "127.0.0.1", "169.254.169.254", "192.168.1.1", "::1", "fe80::1", "::ffff:127.0.0.1", "100.64.0.1"]) {
      const { error } = await run(lookup([address]), false);
      expect(error?.message).toContain("non-public address");
    }
  });

  it("refuses a name if any one of its addresses is non-public", async () => {
    const { error } = await run(lookup(["93.184.216.34", "10.0.0.5"]), true);
    expect(error?.message).toContain("10.0.0.5");
  });

  it("reports names with no addresses and resolver failures", async () => {
    expect((await run(lookup([]), false)).error?.message).toContain("no addresses");
    const failing = createGuardedLookup(async () => {
      throw Object.assign(new Error("boom"), { code: "ENOTFOUND" });
    });
    expect((await run(failing, false)).error?.message).toBe("boom");
  });
});

describe("node transport: malformed redirect headers", () => {
  it("passes a real HTTP-level malformed Location header through unmodified, for follow() to reject", async () => {
    // checkUrl refuses a loopback initial URL before ever calling the transport (tested elsewhere),
    // so this checks the transport in isolation: that a real server's raw header round-trips intact.
    const server = http.createServer((req, res) => {
      res.writeHead(302, { location: "http://[invalid" });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const response = await createNodeTransport()(`http://127.0.0.1:${port}/`, { method: "GET", signal: signal() });
      expect(response).toEqual({ status: 302, location: "http://[invalid" });
      // Confirms follow()'s URL-construction guard (unit-tested via fakeTransport in external.test.ts)
      // is really what stands between a raw malformed header and a crash, not something the transport filters out.
      expect(() => new URL(response.location as string)).toThrow();
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("node transport", () => {
  it("returns the status and Location without following redirects", async () => {
    await withServer(async (port, hits) => {
      const transport = createNodeTransport();
      expect(await transport(`http://127.0.0.1:${port}/`, { method: "HEAD", signal: signal() })).toEqual({ status: 200 });
      expect(await transport(`http://127.0.0.1:${port}/moved`, { method: "GET", signal: signal() })).toEqual({ status: 301, location: "/new" });
      expect((await transport(`http://127.0.0.1:${port}/missing`, { method: "HEAD", signal: signal() })).status).toBe(404);
      expect(hits.methods).toEqual(["HEAD", "GET", "HEAD"]);
    });
  });

  it("aborts a request that never completes", async () => {
    await withServer(async (port) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 50);
      await expect(createNodeTransport()(`http://127.0.0.1:${port}/hang`, { method: "GET", signal: controller.signal })).rejects.toThrow();
    });
  });

  it("never connects to a hostname that resolves to a loopback address", async () => {
    await withServer(async (port, hits) => {
      // "localhost" really resolves to 127.0.0.1 here, and the default lookup must refuse it.
      await expect(createNodeTransport()(`http://localhost:${port}/`, { method: "HEAD", signal: signal() })).rejects.toThrow("non-public address");
      expect(hits.count).toBe(0);
    });
  });

  it("blocks DNS rebinding: a public-looking name that resolves to a private address is never contacted", async () => {
    await withServer(async (port, hits) => {
      const rebinding = createNodeTransport(createGuardedLookup(async () => [{ address: "127.0.0.1" }]));
      const result = await checkUrl(`http://totally-public.example:${port}/`, { transport: rebinding, timeoutMs: 500, retries: 0, backoffMs: 0 });
      expect(result.kind).toBe("unreachable");
      expect(result.kind === "unreachable" && result.reason).toContain("non-public address 127.0.0.1");
      expect(hits.count).toBe(0);
    });
  });

  it("blocks the cloud metadata address behind a hostname", async () => {
    const metadata = createNodeTransport(createGuardedLookup(async () => [{ address: "169.254.169.254" }]));
    await expect(metadata("http://metadata.attacker.example/latest/meta-data", { method: "GET", signal: signal() })).rejects.toThrow(
      "non-public address 169.254.169.254",
    );
  });
});
