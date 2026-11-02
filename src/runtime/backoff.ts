/** The wait before a crashed customer runtime's nth restart (n from 1): 1 s, doubling, at most 5 minutes. */
export function backoffMs(n: number): number {
  return Math.min(300_000, 1_000 * 2 ** Math.max(0, n - 1));
}
