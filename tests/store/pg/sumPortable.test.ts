import { describe, expect, it } from 'vitest';
import { argument, codeOf, isBoolean, lineAt, srcFiles } from '../../helpers/sqlScan.ts';

// The first test:pg run (S2.7): SQLite sums a comparison as 0 or 1, but Postgres has no SUM of a boolean ("function
// sum(boolean) does not exist"), so SUM(status = 'done') fails there. Counts are written SUM(CASE WHEN … THEN 1 ELSE 0
// END), which both engines run. This scan fails on any SUM( in src whose argument is, at its top level, a comparison
// or a boolean (=, <>, <, >, AND, OR, NOT, IS, IN, LIKE, BETWEEN, EXISTS) rather than a CASE or a plain value.

/** True for an argument that is a comparison or a boolean at its top level. */
export const booleanSum = isBoolean;

/** Each boolean SUM( in a file, as `path:line: SUM(…)`. Whole-line comments are left out. */
function offences(path: string, text: string): string[] {
  const out: string[] = [];
  const code = codeOf(path, text);
  for (const m of code.matchAll(/\bSUM\s*\(/gi)) {
    const at = m.index! + m[0].length;
    const arg = argument(code, at);
    if (booleanSum(arg)) out.push(`${path}:${lineAt(code, at)}: SUM(${arg.replace(/\s+/g, ' ').slice(0, 70)})`);
  }
  return out;
}

describe('every SUM( in src runs on both engines (S2.7, the first test:pg run)', () => {
  it('no SUM over a comparison or a boolean anywhere in src', () => {
    expect(srcFiles().flatMap((f) => offences(f, codeOf(f)))).toEqual([]);
  });

  it('catches a comparison, a boolean, IN and EXISTS, also behind a function call; passes CASE, a value and JS sum()', () => {
    for (const bad of [
      "status = 'done'", "status <> 'done'", "deadline < @today", "a = 1 AND b = 2", "NOT archived", "x IS NULL",
      "COALESCE(md.kind, m.media_type) IN ('image', 'video')", "COALESCE(k, t) = 'voice'", "m.f = 1 AND EXISTS (SELECT 1 FROM x WHERE y = 2)",
      "kind LIKE 'v%'", "closed_on BETWEEN @a AND @b",
    ]) expect(booleanSum(bad), bad).toBe(true);
    for (const fine of [
      'usd', 'm.size * 2', "CASE WHEN status = 'done' THEN 1 ELSE 0 END", 'COALESCE(usd, 0)', "'open'", 'message_count',
      "CASE WHEN COALESCE(a, b) IN ('x') THEN 1 ELSE 0 END", "(v ->> 'n')::int",
    ]) expect(booleanSum(fine), fine).toBe(false);
    expect(offences('x.ts', "const a = `SELECT SUM(status = 'done') AS d FROM t`;")).toEqual(["x.ts:1: SUM(status = 'done')"]);
    expect(offences('x.ts', "// SUM(status = 'done') in a comment is fine\nconst n = sum('open');")).toEqual([]);
  });
});
