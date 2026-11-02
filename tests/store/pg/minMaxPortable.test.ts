import { describe, expect, it } from 'vitest';
import { argument, codeOf, lineAt, srcFiles, topLevel } from '../../helpers/sqlScan.ts';

// The Postgres conversion (S2.7): SQLite's two-argument MAX(a, b) and MIN(a, b) pick the larger or smaller value, but
// Postgres has no such forms (its GREATEST and LEAST do that, and SQLite has neither). A choice between two values is
// written CASE WHEN … THEN … ELSE … END, which both engines run. This scan fails on a MAX( or MIN( in src with two or
// more arguments (a one-argument aggregate, MAX(ts), stays), and on GREATEST( or LEAST( outside the Postgres-only code.

/** Code that only ever talks to Postgres (the copy target, its schema, its engine): GREATEST and LEAST are fine there. */
const POSTGRES_ONLY = (path: string) => path === 'migrate/target.ts' || path === 'store/engine/pg.ts' || path.startsWith('store/pg/');

/** True for an argument list with two or more arguments at its top level. */
export const twoOrMore = (arg: string): boolean => topLevel(arg).includes(',');

/** Each offending call in a file, as `path:line: …`. Whole-line comments are left out. */
function offences(path: string, text: string): string[] {
  const out: string[] = [];
  const code = codeOf(path, text);
  // Not after a dot or a name: Math.max(a, b) and z.string().max(80) are JavaScript.
  for (const m of code.matchAll(/(?<![.\w$])(MAX|MIN)\s*\(/gi)) {
    const at = m.index! + m[0].length;
    const arg = argument(code, at);
    if (twoOrMore(arg)) out.push(`${path}:${lineAt(code, at)}: ${m[1]}(${arg.replace(/\s+/g, ' ').slice(0, 60)})`);
  }
  if (!POSTGRES_ONLY(path)) for (const m of code.matchAll(/(?<![.\w$])(GREATEST|LEAST)\s*\(/gi)) out.push(`${path}:${lineAt(code, m.index!)}: ${m[1]}(`);
  return out;
}

describe('no two-argument MAX or MIN in src, and GREATEST or LEAST only in Postgres-only code (S2.7)', () => {
  it('none anywhere in src', () => {
    expect(srcFiles().flatMap((f) => offences(f, codeOf(f)))).toEqual([]);
  });

  it('catches MAX(a, b), MIN(a, b), behind a call too, and GREATEST/LEAST; passes aggregates, JS and comments', () => {
    for (const bad of [
      "x = MAX(COALESCE(last_reminder_on, ''), @onDate)", 'SET attempts = MIN(attempts, 1)', 'max(a, b, c)', "MIN(lower(x), 'z')",
      'SELECT GREATEST(a, b)', 'least(a, 1)',
    ]) expect(offences('x.ts', bad), bad).not.toEqual([]);
    for (const fine of [
      'SELECT MAX(ts) AS last', 'MIN(at)', "MAX(COALESCE(a, b))", 'MAX(CASE WHEN a > b THEN a ELSE b END)', 'Math.max(a, b)', 'z.string().max(80)',
      ' * min(size bound, STT_MAX_SECONDS + tolerance)', '// MAX(a, b) in a comment', "COUNT(CASE WHEN x = 'a, b' THEN 1 END)", "MAX(',')",
      'MAX(COALESCE(f(g(a), b), c))',
    ]) expect(offences('x.ts', fine), fine).toEqual([]);
    expect(offences('migrate/target.ts', 'SELECT setval(s, GREATEST(a, 1))')).toEqual([]);
    expect(offences('store/clients.ts', 'SELECT GREATEST(a, 1)')).not.toEqual([]);
  });
});
