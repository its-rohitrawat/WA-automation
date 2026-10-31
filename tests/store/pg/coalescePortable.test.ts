import { describe, expect, it } from 'vitest';
import { argument, codeOf, isBoolean, lineAt, splitArguments, srcFiles } from '../../helpers/sqlScan.ts';

// The Postgres conversion (S2.7): on SQLite a comparison is 0 or 1, so COALESCE(note = 'x', 0) works; on Postgres it
// is a boolean, which COALESCE cannot match with an integer ("COALESCE types boolean and integer cannot be matched").
// A flag is written CASE WHEN … THEN 1 ELSE 0 END, which both engines run (a NULL gives 0, as COALESCE did). This scan
// fails on a COALESCE( in src with any argument that is, at its top level, a comparison or a boolean.

/** Each COALESCE( with a boolean argument in a file, as `path:line: COALESCE(…)`. Whole-line comments are left out. */
function offences(path: string, text: string): string[] {
  const out: string[] = [];
  const code = codeOf(path, text);
  for (const m of code.matchAll(/(?<![.\w$])COALESCE\s*\(/gi)) {
    const at = m.index! + m[0].length;
    const arg = argument(code, at);
    if (splitArguments(arg).some(isBoolean)) out.push(`${path}:${lineAt(code, at)}: COALESCE(${arg.replace(/\s+/g, ' ').slice(0, 70)})`);
  }
  return out;
}

describe('no COALESCE over a comparison or a boolean in src (S2.7, the Postgres conversion)', () => {
  it('none anywhere in src', () => {
    expect(srcFiles().flatMap((f) => offences(f, codeOf(f)))).toEqual([]);
  });

  it('catches a comparison in any argument; passes values, nested calls, CASE and comments', () => {
    for (const bad of [
      "COALESCE(note = 'found_internal', 0)", "COALESCE(m.note = 'x', 0) AS f", 'COALESCE(0, a <> b)', "COALESCE(kind IN ('a', 'b'), 0)",
      'COALESCE(a IS NULL, 0)',
    ]) expect(offences('x.ts', bad), bad).not.toEqual([]);
    for (const fine of [
      'COALESCE(m.audio_seconds, m.drive_seconds)', "COALESCE(md.kind, m.media_type) IN ('image')", "COALESCE(SUM(CASE WHEN a = b THEN 1 ELSE 0 END), 0)",
      "COALESCE(CASE WHEN note = 'x' THEN 1 ELSE 0 END, 0)", "COALESCE(last_reminder_on, '')", "COALESCE(lower(x), 'a = b')",
      "// COALESCE(note = 'x', 0) in a comment", 'COALESCE((SELECT max(id) FROM t WHERE x = 1), 0)', 'obj.coalesce(a = b)',
    ]) expect(offences('x.ts', fine), fine).toEqual([]);
  });
});
