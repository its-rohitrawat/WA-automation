import { describe, expect, it } from 'vitest';
import { codeOf, isBoolean, lineAt, literals, selectedValues, setValues, srcFiles } from '../../helpers/sqlScan.ts';

// The Postgres conversion (S2.7): on SQLite a comparison is the number 0 or 1, on Postgres a boolean. So a comparison
// used as a value differs by engine: `ref_enc IS NOT NULL AS has_ref` read as `=== 1` is never true on Postgres, and
// `SET backlog = (x = y)` puts a boolean in an INTEGER column. A flag is written CASE WHEN … THEN 1 ELSE 0 END, which
// both engines give as 0 or 1. This scan fails on a SELECTed value (`… AS name`) or a SET value in src's SQL that is,
// at its top level, a comparison or a boolean.

/** Code that only ever talks to Postgres: a boolean there is read as a boolean. */
const POSTGRES_ONLY = (path: string) => path === 'migrate/target.ts' || path === 'store/engine/pg.ts' || path.startsWith('store/pg/');
/** A literal holding a SQL statement (the codebase writes SQL in capitals; prose and messages are left out). */
const SQL = /\b(?:SELECT|UPDATE|INSERT|DELETE)\b/;

/** Each boolean value in a file's SQL, as `path:line: …`. */
function offences(path: string, text: string): string[] {
  const out: string[] = [];
  if (POSTGRES_ONLY(path)) return out;
  for (const lit of literals(codeOf(path, text)).filter((l) => SQL.test(l.text))) {
    const line = lineAt(text, lit.at);
    for (const v of selectedValues(lit.text)) if (isBoolean(v)) out.push(`${path}:${line}: ${v.trim().replace(/\s+/g, ' ').slice(0, 70)} AS …`);
    for (const v of setValues(lit.text)) if (isBoolean(v)) out.push(`${path}:${line}: SET … = ${v.trim().replace(/\s+/g, ' ').slice(0, 70)}`);
  }
  return out;
}

describe('no comparison or boolean used as a value in src SQL (S2.7, the Postgres conversion)', () => {
  it('none anywhere in src', () => {
    expect(srcFiles().flatMap((f) => offences(f, codeOf(f)))).toEqual([]);
  });

  it('catches a boolean SELECTed AS a name or assigned in SET; passes values, CASE, aliases, casts and TypeScript', () => {
    const q = (sql: string) => offences('x.ts', `const s = \`${sql}\`;`);
    for (const bad of [
      'SELECT ref_enc IS NOT NULL AS has_ref FROM media', 'SELECT id, m.from_me = 1 AS mine FROM messages m',
      "SELECT a, EXISTS (SELECT 1 FROM t) AS any FROM x", "SELECT kind IN ('a', 'b') AS ok FROM t", 'SELECT a AND b AS both FROM t',
      'UPDATE media SET backlog = (SELECT n > 0 FROM x) = 1 WHERE id = 1', 'UPDATE t SET a = 1, flag = b IS NULL WHERE id = ?',
      "UPDATE t SET done = status = 'done'",
    ]) expect(q(bad), bad).not.toEqual([]);
    for (const fine of [
      'SELECT id, code AS clientCode FROM clients c JOIN tasks AS t ON t.client_id = c.id WHERE t.x = 1',
      "SELECT CASE WHEN ref_enc IS NOT NULL THEN 1 ELSE 0 END AS has_ref FROM media", 'SELECT CAST(x AS text) AS y FROM t',
      'SELECT COUNT(*) AS n FROM t WHERE a = 1', "SELECT (SELECT COUNT(*) FROM tasks t WHERE t.meeting_id = m.id) AS actionItems FROM meetings m",
      'UPDATE t SET a = @a, b = COALESCE(b, 0) + 1 WHERE id = ? AND c = 1', 'UPDATE t SET a = CASE WHEN x = 1 THEN 1 ELSE 0 END WHERE id = ?',
      "INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v",
      'SELECT max(id) AS v FROM t WHERE x <> 1',
    ]) expect(q(fine), fine).toEqual([]);
    // TypeScript's own `as`, and comparisons outside any string, are not SQL.
    expect(offences('x.ts', 'const a = (b === c) as boolean; const d = x as unknown as Db;')).toEqual([]);
  });
});
