import { describe, expect, it } from 'vitest';
import { translate } from '../../../src/store/engine/translate.ts';

describe('translate (SQLite text to Postgres text)', () => {
  it('numbers ? and @name values, outside quotes, reusing a repeated name', () => {
    expect(translate('SELECT * FROM t WHERE a = ? AND b = ?', [1, 2])).toEqual({ text: 'SELECT * FROM t WHERE a = $1 AND b = $2', values: [1, 2] });
    expect(translate("SELECT '?' AS q, x FROM t WHERE at < @cut AND at > @cut", { cut: 'Z' })).toEqual({ text: "SELECT '?' AS q, x FROM t WHERE at < $1 AND at > $1", values: ['Z'] });
    expect(translate("SELECT 'it''s @a ?' FROM t WHERE a = ?", [1]).text).toBe("SELECT 'it''s @a ?' FROM t WHERE a = $1");
    expect(translate('SELECT "odd?name" FROM t WHERE a = @a', { a: 1 }).text).toBe('SELECT "odd?name" FROM t WHERE a = $1');
  });

  it('takes the named values in the order they first appear, and ignores extra keys', () => {
    expect(translate('UPDATE t SET a = @a WHERE b = @b AND c = @a', { b: 2, a: 1, unused: 3 })).toEqual({ text: 'UPDATE t SET a = $1 WHERE b = $2 AND c = $1', values: [1, 2] });
  });

  it('refuses a statement that mixes ? and @name, a missing name, and the wrong number of ? values', () => {
    expect(() => translate('SELECT ? , @a', { a: 1 })).toThrow(/mixes/);
    expect(() => translate('SELECT @a', {})).toThrow(/no value for @a/);
    expect(() => translate('SELECT ?, ?', [1])).toThrow(/2 values, got 1/);
    expect(() => translate('SELECT ?', { a: 1 })).toThrow(/positional/);
    expect(() => translate('SELECT @a', [1])).toThrow(/named/);
  });

  it('a statement with no values takes none', () => {
    expect(translate('SELECT 1')).toEqual({ text: 'SELECT 1', values: [] });
  });

  it('quotes camelCase aliases so row keys match SQLite, and leaves the rest', () => {
    expect(translate('SELECT c.code AS clientCode, t.at AS at, x AS from_me, y AS "kept" FROM t').text)
      .toBe('SELECT c.code AS "clientCode", t.at AS at, x AS from_me, y AS "kept" FROM t');
  });

  it('maps json_each, json_array_length with a path, and instr', () => {
    expect(translate('SELECT value FROM json_each(?)', ['[1]']).text).toBe('SELECT value FROM json_array_elements_text(($1)::json)');
    expect(translate('SELECT 1 FROM t WHERE id NOT IN (SELECT value FROM json_each(@ids))', { ids: '[]' }).text)
      .toBe('SELECT 1 FROM t WHERE id NOT IN (SELECT value FROM json_array_elements_text(($1)::json))');
    expect(translate("SELECT json_array_length(summary, '$.actionItems') AS n FROM meetings").text)
      .toBe("SELECT json_array_length((summary)::json -> 'actionItems') AS n FROM meetings");
    expect(translate("SELECT CAST(substr(t.code, instr(t.code, '-') + 1) AS INTEGER) FROM t").text)
      .toBe("SELECT CAST(substr(t.code, strpos(t.code, '-') + 1) AS INTEGER) FROM t");
  });

  it('makes LIKE case-insensitive, as it is in SQLite', () => {
    expect(translate("SELECT 1 FROM t WHERE a LIKE @q ESCAPE '\\' AND b NOT LIKE 'x%'", { q: '%a%' }).text)
      .toBe("SELECT 1 FROM t WHERE a ILIKE $1 ESCAPE '\\' AND b NOT ILIKE 'x%'");
  });

  it('puts tenant_id first in an ON CONFLICT target, once, and only for customer tables', () => {
    expect(translate('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v', ['a', 'b']).text)
      .toBe('INSERT INTO kv (k, v) VALUES ($1, $2) ON CONFLICT (tenant_id, k) DO UPDATE SET v = excluded.v');
    expect(translate('INSERT INTO m (tenant_id, user_id) VALUES (?, ?) ON CONFLICT (tenant_id, user_id) DO NOTHING', [1, 2]).text)
      .toBe('INSERT INTO m (tenant_id, user_id) VALUES ($1, $2) ON CONFLICT (tenant_id, user_id) DO NOTHING');
    expect(translate('INSERT INTO t (a) VALUES (?) ON CONFLICT DO NOTHING', [1]).text).toBe('INSERT INTO t (a) VALUES ($1) ON CONFLICT DO NOTHING');
    // The platform tables have no tenant_id column (S2 plan 4.9, A4): their Db asks for no rewrite.
    expect(translate('INSERT INTO users (id, email) VALUES (?, ?) ON CONFLICT (email) DO NOTHING', [1, 'a'], { tenantKeys: false }).text)
      .toBe('INSERT INTO users (id, email) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING');
  });

  it('gives the same text from its cache, for either setting', () => {
    const sql = 'INSERT INTO kv (k) VALUES (?) ON CONFLICT (k) DO NOTHING';
    expect(translate(sql, ['a']).text).toBe(translate(sql, ['b']).text);
    expect(translate(sql, ['a'], { tenantKeys: false }).text).toBe('INSERT INTO kv (k) VALUES ($1) ON CONFLICT (k) DO NOTHING');
    expect(translate(sql, ['a']).text).toBe('INSERT INTO kv (k) VALUES ($1) ON CONFLICT (tenant_id, k) DO NOTHING');
  });
});
