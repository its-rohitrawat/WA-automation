const MIN_MS = 5_000;
const MAX_MS = 600_000;

/** Exponential backoff from 5 s to 10 min with ±20% jitter. Never a tight loop. */
export function backoffMs(attempt: number, rand: () => number = Math.random): number {
  const base = Math.min(MIN_MS * 2 ** attempt, MAX_MS);
  const jitter = base * 0.2 * (rand() * 2 - 1);
  return Math.round(Math.min(MAX_MS, Math.max(MIN_MS, base + jitter)));
}
