import type { UrlResult } from "./http";
import { pathKind, readTextInside, toRepoPath, writeTextInside } from "./repository";

/**
 * A small cache of external link results, so repeated runs do not re-request
 * URLs that were fine a moment ago. The workflow persists the file (for
 * example with actions/cache); DocEye only reads and writes it.
 *
 * Only successful outcomes are stored ("ok" and "redirect"). Broken,
 * unavailable and unreachable results are always re-checked, so a cache can
 * hide neither a link that broke nor a transient outage. The file is treated
 * as untrusted input: it is validated entry by entry, bounded in size, and
 * expired entries are dropped.
 */

export type CachedResult = Extract<UrlResult, { kind: "ok" | "redirect" }>;
type Entry = { at: number; result: CachedResult };

const VERSION = 1;
const MAX_ENTRIES = 5000;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_URL = 2048;
const HOUR_MS = 3_600_000;

export class LinkCache {
  private readonly entries = new Map<string, Entry>();
  private dirty = false;

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get changed(): boolean {
    return this.dirty;
  }

  get(url: string): CachedResult | undefined {
    const entry = this.entries.get(url);
    if (!entry) return undefined;
    if (this.now() - entry.at > this.ttlMs) {
      this.entries.delete(url);
      this.dirty = true;
      return undefined;
    }
    return entry.result;
  }

  set(url: string, result: UrlResult): void {
    if (result.kind !== "ok" && result.kind !== "redirect") return;
    if (url.length > MAX_URL || this.ttlMs <= 0) return;
    if (this.entries.size >= MAX_ENTRIES && !this.entries.has(url)) return;
    this.entries.set(url, { at: this.now(), result });
    this.dirty = true;
  }

  /** Insert an entry that was read from disk, keeping its original timestamp. */
  restore(url: string, entry: Entry): void {
    this.entries.set(url, entry);
  }

  serialize(): string {
    return JSON.stringify({ version: VERSION, entries: Object.fromEntries(this.entries) });
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function validResult(value: unknown): CachedResult | undefined {
  if (!isRecord(value)) return undefined;
  if (value["kind"] === "ok") {
    const status = value["status"];
    return typeof status === "number" && Number.isInteger(status) && status >= 100 && status < 400 ? { kind: "ok", status } : undefined;
  }
  if (value["kind"] === "redirect") {
    const { finalUrl, permanent } = value;
    return typeof finalUrl === "string" && finalUrl.length <= MAX_URL && /^https?:\/\//i.test(finalUrl) && typeof permanent === "boolean"
      ? { kind: "redirect", finalUrl, permanent }
      : undefined;
  }
  return undefined;
}

/** Parse cache file text. Returns undefined if it is not a DocEye link cache at all. */
export function parseLinkCache(text: string, cache: LinkCache, now: number, ttlMs: number): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (!isRecord(parsed) || parsed["version"] !== VERSION || !isRecord(parsed["entries"])) return false;

  let count = 0;
  for (const [url, raw] of Object.entries(parsed["entries"])) {
    if (++count > MAX_ENTRIES) break;
    if (url.length > MAX_URL || !isRecord(raw)) continue;
    const at = raw["at"];
    const result = validResult(raw["result"]);
    if (typeof at !== "number" || !Number.isFinite(at) || result === undefined) continue;
    if (now - at > ttlMs || at > now + 24 * HOUR_MS) continue; // expired, or from the future
    cache.restore(url, { at, result });
  }
  return true;
}

export type LoadedCache = { cache: LinkCache; problem?: string };

export async function loadLinkCache(root: string, rel: string, ttlHours: number, now: () => number = Date.now): Promise<LoadedCache> {
  const ttlMs = ttlHours * HOUR_MS;
  const cache = new LinkCache(ttlMs, now);
  try {
    const text = await readTextInside(root, rel, MAX_BYTES);
    if (text !== undefined && !parseLinkCache(text, cache, now(), ttlMs)) {
      return { cache, problem: `link cache ${rel} is not a DocEye cache file and was ignored` };
    }
  } catch (error) {
    return { cache, problem: `link cache ${rel} could not be read: ${(error as Error).message}` };
  }
  return { cache };
}

/**
 * Persist the cache. A file that already exists is only replaced if it is
 * itself a valid cache, so a crafted configuration cannot turn the cache path
 * into an arbitrary-file overwrite. Returns a problem description on refusal.
 */
export async function saveLinkCache(root: string, rel: string, cache: LinkCache): Promise<string | undefined> {
  if (!cache.changed) return undefined;
  const normalized = toRepoPath(rel);
  if (normalized === undefined || !normalized.endsWith(".json")) return `link cache path must be a .json file inside the repository: ${rel}`;
  try {
    if ((await pathKind(root, normalized)) === "file") {
      const existing = await readTextInside(root, normalized, MAX_BYTES);
      if (existing === undefined || !parseLinkCache(existing, new LinkCache(Infinity), 0, Infinity)) {
        return `link cache ${rel} exists and is not a DocEye cache file; it was not overwritten`;
      }
    }
    await writeTextInside(root, normalized, cache.serialize());
    return undefined;
  } catch (error) {
    return `link cache ${rel} could not be written: ${(error as Error).message}`;
  }
}
