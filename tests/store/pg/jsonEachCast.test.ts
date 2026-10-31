import { describe, expect, it } from 'vitest';
import { codeOf, lineAt, srcFiles } from '../../helpers/sqlScan.ts';

// The Postgres conversion (S2.7): the engine turns json_each(X) into json_array_elements_text(X), whose values are
// text. So `id IN (SELECT value FROM json_each(?))` compares a bigint with text, which Postgres refuses ("operator does
// not exist: bigint = text"); SQLite compares numbers. An id list is read as SELECT CAST(value AS INTEGER) FROM
// json_each(?), which both engines run. This scan fails on an id column (id, or a name ending in _id) compared with
// json_each's bare value. WhatsApp's own ids are text, so the *wa_id columns are fine as they are.

/** Text columns whose names end in _id: WhatsApp's message ids. */
const TEXT_IDS = new Set(['wa_id', 'target_wa_id', 'source_wa_id', 'quoted_wa_id']);

/** Each id column compared with json_each's uncast value, as `path:line: …`. */
function offences(path: string, text: string): string[] {
  const out: string[] = [];
  const code = codeOf(path, text);
  for (const m of code.matchAll(/([A-Za-z_][\w.]*)\s+(?:NOT\s+)?IN\s*\(\s*SELECT\s+(CAST\s*\(\s*)?value\b[^)]*?\bFROM\s+json_each\s*\(/gi)) {
    const column = m[1]!.split('.').at(-1)!.toLowerCase();
    const idLike = column === 'id' || column.endsWith('_id');
    if (idLike && !TEXT_IDS.has(column) && !m[2]) out.push(`${path}:${lineAt(code, m.index!)}: ${m[0].replace(/\s+/g, ' ')}`);
  }
  return out;
}

describe('an id list from json_each is cast to integers (S2.7, the Postgres conversion)', () => {
  it('no id column compared with json_each’s bare value anywhere in src', () => {
    expect(srcFiles().flatMap((f) => offences(f, codeOf(f)))).toEqual([]);
  });

  it('catches id and *_id columns, IN and NOT IN; passes CAST, text ids and text columns', () => {
    for (const bad of [
      'WHERE id NOT IN (SELECT value FROM json_each(?))', 'WHERE m.message_id IN (SELECT value FROM json_each(@ids))',
      'AND media_id in ( select value from json_each(?) )',
    ]) expect(offences('x.ts', bad), bad).not.toEqual([]);
    for (const fine of [
      'WHERE id NOT IN (SELECT CAST(value AS INTEGER) FROM json_each(?))', 'AND target_wa_id IN (SELECT value FROM json_each(?))',
      'AND status IN (SELECT value FROM json_each(?))', "// id IN (SELECT value FROM json_each(?)) in a comment",
    ]) expect(offences('x.ts', fine), fine).toEqual([]);
  });
});
