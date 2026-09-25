import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

/**
 * External URL validation. Requests are bounded: per-request timeout, limited
 * retries for transient failures, at most `maxRedirects` hops, and callers
 * cap concurrency with mapWithLimit.
 *
 * Loopback, private and link-local addresses are never contacted, so a
 * hostile README cannot use the runner to probe internal services. Literal
 * addresses and well-known internal names are rejected up front (and again for
 * every redirect target). Hostnames are the harder case: a public-looking
 * name can resolve to 169.254.169.254, so the default transport validates the
 * addresses the name resolves to inside the socket's own DNS lookup. The
 * address that was checked is the address that is connected to, which leaves
 * no window for DNS rebinding.
 */

export type TransportResponse = { status: number; location?: string };

/** Sends one HEAD or GET request without following redirects. Injected in tests. */
export type Transport = (url: string, init: { method: "HEAD" | "GET"; signal: AbortSignal }) => Promise<TransportResponse>;

export type Resolver = (hostname: string) => Promise<Array<{ address: string }>>;

const defaultResolver: Resolver = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });

/** A `lookup` function for net sockets that refuses non-public addresses. */
export function createGuardedLookup(resolve: Resolver = defaultResolver): net.LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (addresses) => {
        const blocked = addresses.find((a) => !isPublicHost(a.address));
        if (addresses.length === 0 || blocked) {
          const reason = blocked ? `refusing to connect to non-public address ${blocked.address}` : `no addresses for ${hostname}`;
          callback(Object.assign(new Error(reason), { code: blocked ? "EBLOCKED" : "ENOTFOUND" }) as NodeJS.ErrnoException, "");
          return;
        }
        const list = addresses.map((a) => ({ address: a.address, family: net.isIP(a.address) === 6 ? 6 : 4 }));
        if (options.all) callback(null, list);
        else callback(null, (list[0] as { address: string }).address, (list[0] as { family: number }).family);
      },
      (error: NodeJS.ErrnoException) => callback(error, ""),
    );
  };
}

/** The default transport: node:http(s) with the guarded lookup. Never reads a response body. */
export function createNodeTransport(lookup: net.LookupFunction = createGuardedLookup()): Transport {
  return (url, { method, signal }) =>
    new Promise((resolve, reject) => {
      const target = new URL(url);
      const client = target.protocol === "https:" ? https : http;
      const request = client.request(
        target,
        { method, signal, lookup, agent: false, headers: { "user-agent": "doceye-link-checker", accept: "*/*" } },
        (response) => {
          const location = response.headers.location;
          response.destroy();
          resolve({ status: response.statusCode ?? 0, ...(location ? { location } : {}) });
        },
      );
      request.on("error", reject);
      request.end();
    });
}

export type UrlResult =
  | { kind: "ok"; status: number }
  | { kind: "redirect"; finalUrl: string; permanent: boolean }
  | { kind: "broken"; reason: string; status?: number }
  | { kind: "unavailable"; reason: string; status?: number }
  | { kind: "unreachable"; reason: string }
  | { kind: "skipped"; reason: string };

export type CheckUrlOptions = {
  transport?: Transport;
  timeoutMs: number;
  retries: number;
  maxRedirects?: number;
  /** Base delay between retries; multiplied by the attempt number. */
  backoffMs?: number;
  /** Epoch ms after which no new request is started. */
  deadline?: number;
};

/** Statuses that usually mean "blocked or rate limited", not "the page is gone". */
const UNVERIFIABLE_STATUSES = new Set([401, 403, 407, 408, 429, 451, 999]);

export function isPublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "" || host === "localhost") return false;
  if (/\.(localhost|local|internal|localdomain|lan)$/.test(host)) return false;

  if (host.includes(":")) {
    return !(host === "::1" || host === "::" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith("::ffff:"));
  }
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  return host.includes(".");
}

type Hop =
  | { type: "response"; status: number; finalUrl: string; permanent: boolean }
  | { type: "blocked" }
  | { type: "invalid-redirect" }
  | { type: "too-many-redirects" };

async function request(transport: Transport, url: string, method: "HEAD" | "GET", timeoutMs: number): Promise<TransportResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await transport(url, { method, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function follow(transport: Transport, start: string, method: "HEAD" | "GET", options: CheckUrlOptions): Promise<Hop> {
  const maxRedirects = options.maxRedirects ?? 5;
  let current = start;
  let permanent = false;
  for (let hops = 0; hops <= maxRedirects; hops++) {
    const response = await request(transport, current, method, options.timeoutMs);
    if (response.status >= 300 && response.status < 400 && response.location) {
      let next: URL;
      try {
        next = new URL(response.location, current);
      } catch {
        return { type: "invalid-redirect" };
      }
      if (next.protocol !== "http:" && next.protocol !== "https:") return { type: "invalid-redirect" };
      if (!isPublicHost(next.hostname)) return { type: "blocked" };
      permanent ||= response.status === 301 || response.status === 308;
      current = next.toString();
      continue;
    }
    return { type: "response", status: response.status, finalUrl: current, permanent };
  }
  return { type: "too-many-redirects" };
}

function classify(hop: Hop, requested: string): UrlResult {
  switch (hop.type) {
    case "blocked":
      return { kind: "skipped", reason: "redirects to a local or private address" };
    case "invalid-redirect":
      return { kind: "broken", reason: "invalid redirect target" };
    case "too-many-redirects":
      return { kind: "broken", reason: "too many redirects" };
    case "response": {
      const { status } = hop;
      if (status < 400) {
        const moved = new URL(hop.finalUrl).toString() !== new URL(requested).toString();
        return moved ? { kind: "redirect", finalUrl: hop.finalUrl, permanent: hop.permanent } : { kind: "ok", status };
      }
      if (UNVERIFIABLE_STATUSES.has(status) || status >= 500) {
        return { kind: "unavailable", reason: `HTTP ${status}`, status };
      }
      return { kind: "broken", reason: `HTTP ${status}`, status };
    }
  }
}

function describeError(error: unknown, timeoutMs: number): string {
  const err = error as { name?: string; message?: string; cause?: { code?: string } };
  if (err.name === "AbortError" || err.name === "TimeoutError") return `timed out after ${timeoutMs}ms`;
  return err.cause?.code ?? err.message ?? "network error";
}

async function attempt(transport: Transport, url: string, options: CheckUrlOptions): Promise<UrlResult> {
  // HEAD is cheap but unevenly supported, so any non-success falls back to GET.
  try {
    const viaHead = classify(await follow(transport, url, "HEAD", options), url);
    if (viaHead.kind === "ok" || viaHead.kind === "redirect" || viaHead.kind === "skipped") return viaHead;
  } catch {
    // fall through to GET
  }
  try {
    return classify(await follow(transport, url, "GET", options), url);
  } catch (error) {
    return { kind: "unreachable", reason: describeError(error, options.timeoutMs) };
  }
}

function isTransient(result: UrlResult): boolean {
  if (result.kind === "unreachable") return true;
  return result.kind === "unavailable" && (result.status === undefined || result.status >= 500 || result.status === 429);
}

let shared: Transport | undefined;
const defaultTransport = (): Transport => (shared ??= createNodeTransport());

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function checkUrl(url: string, options: CheckUrlOptions): Promise<UrlResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: "skipped", reason: "not a valid URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { kind: "skipped", reason: "not an http(s) URL" };
  if (!isPublicHost(parsed.hostname)) return { kind: "skipped", reason: "local or private address" };

  const transport = options.transport ?? defaultTransport();
  let last: UrlResult = { kind: "skipped", reason: "not attempted" };
  for (let tries = 0; tries <= options.retries; tries++) {
    if (options.deadline !== undefined && Date.now() > options.deadline) {
      return { kind: "skipped", reason: "time budget exhausted" };
    }
    if (tries > 0) await sleep((options.backoffMs ?? 500) * tries);
    last = await attempt(transport, parsed.toString(), options);
    if (!isTransient(last)) return last;
  }
  return last;
}

/** Run `fn` over `items` with at most `limit` calls in flight. Results keep input order. */
export async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, worker));
  return results;
}
