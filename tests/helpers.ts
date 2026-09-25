import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDocEye, type Report, type RunOptions } from "../src/check";
import type { Transport } from "../src/http";
import type { Finding } from "../src/types";

const created: string[] = [];

/** Create a temporary repository from a map of relative path -> file content. */
export async function makeRepo(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "doceye-test-"));
  created.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  return root;
}

export async function cleanupRepos(): Promise<void> {
  await Promise.all(created.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
}

/** Run DocEye against an in-memory description of a repository. Network is off unless `transport` is given. */
export async function check(
  files: Record<string, string>,
  options: Partial<RunOptions> = {},
): Promise<Report> {
  const root = await makeRepo(files);
  return runDocEye({ root, externalLinks: options.transport ? undefined : false, backoffMs: 0, ...options });
}

export const rules = (findings: Finding[]): string[] => findings.map((f) => f.rule);
export const byRule = (findings: Finding[], rule: string): Finding[] => findings.filter((f) => f.rule === rule);

export type Route = number | { status: number; location?: string } | Error;

/**
 * A deterministic stand-in for the network. `routes` maps "METHOD url" or "url"
 * to a response; unmatched URLs return 404. Records every call.
 */
export function fakeTransport(routes: Record<string, Route>) {
  const calls: Array<{ method: string; url: string }> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const transport: Transport = async (url, { method }) => {
    calls.push({ method, url });
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1));
      const route = routes[`${method} ${url}`] ?? routes[url] ?? 404;
      if (route instanceof Error) throw route;
      const { status, location } = typeof route === "number" ? { status: route, location: undefined } : route;
      return { status, ...(location ? { location } : {}) };
    } finally {
      inFlight--;
    }
  };
  return { transport, calls, maxInFlight: () => maxInFlight };
}
