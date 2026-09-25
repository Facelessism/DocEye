import path from "node:path";

/**
 * "Did you mean" support. Suggestions only ever come from names that exist in
 * the repository, so they can be applied as-is.
 */

const MAX_LENGTH = 120;

/** Levenshtein distance. Inputs are truncated, so cost stays bounded. */
export function editDistance(a: string, b: string): number {
  const x = a.slice(0, MAX_LENGTH);
  const y = b.slice(0, MAX_LENGTH);
  if (x === y) return 0;
  let previous = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const current = [i];
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      current[j] = Math.min((previous[j] as number) + 1, (current[j - 1] as number) + 1, (previous[j - 1] as number) + cost);
    }
    previous = current;
  }
  return previous[y.length] as number;
}

function allowedDistance(length: number): number {
  if (length <= 3) return 1;
  if (length <= 6) return 2;
  return Math.min(4, Math.floor(length / 3));
}

/**
 * The candidate closest to `target`, or undefined if nothing is close enough
 * to be a plausible typo. A case-only difference always counts.
 */
export function closestMatch(target: string, candidates: Iterable<string>): string | undefined {
  const wanted = target.toLowerCase();
  const limit = allowedDistance(wanted.length);
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    if (candidate === target) continue;
    const distance = editDistance(wanted, candidate.toLowerCase());
    if (distance <= limit && distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/** Script names related to a missing one: `test` for `test:unit`, `deploy:prod` for `deploy`. */
export function closestScript(name: string, scripts: string[]): string | undefined {
  const related = scripts.find((s) => s.startsWith(`${name}:`) || name.startsWith(`${s}:`));
  return related ?? closestMatch(name, scripts);
}

function sharedPrefixLength(a: string, b: string): number {
  const x = a.split("/");
  const y = b.split("/");
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n;
}

/**
 * Where a missing file probably went: the same file name elsewhere in the
 * repository (it was moved), otherwise the closest name in the same directory.
 */
export function suggestPath(missing: string, files: string[]): string | undefined {
  const base = path.posix.basename(missing).toLowerCase();
  const dir = path.posix.dirname(missing);
  const moved = files
    .filter((f) => path.posix.basename(f).toLowerCase() === base && f !== missing)
    .sort((a, b) => sharedPrefixLength(b, missing) - sharedPrefixLength(a, missing) || a.localeCompare(b));
  if (moved[0] !== undefined) return moved[0];

  const siblings = files.filter((f) => path.posix.dirname(f) === dir).map((f) => path.posix.basename(f));
  const close = closestMatch(path.posix.basename(missing), siblings);
  return close === undefined ? undefined : path.posix.join(dir, close);
}
