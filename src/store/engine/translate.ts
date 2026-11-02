import type { Params } from './types.ts';

// SQLite statement text to Postgres text (SaaS S2, plan 4.6), once per statement, cached. Pure: no Postgres needed.
//  - `?` and `@name` become $1..$n outside quotes; a repeated @name keeps its number; mixing the two styles throws.
//  - A camelCase alias (`AS clientCode`) is quoted, so row keys stay as SQLite gives them (Postgres folds to lower case).
//  - json_each(X) -> json_array_elements_text((X)::json); json_array_length(X, '$.key') -> json_array_length((X)::json -> 'key').
//  - instr( -> strpos(;  LIKE -> ILIKE (SQLite's LIKE ignores ASCII case, Postgres's does not).
//  - ON CONFLICT (cols) -> ON CONFLICT (tenant_id, cols) for customer tables, whose unique keys all start with tenant_id
//    (plan 4.3); `tenantKeys: false` for the platform tables, which have no tenant_id.
// What cannot be translated safely (INSERT OR IGNORE, GLOB, sqlite_master) is changed in the source instead (S2.5).

export interface TranslateOptions {
  /** Put tenant_id first in ON CONFLICT targets (customer tables). Default true. */
  tenantKeys?: boolean;
}

interface Compiled {
  text: string;
  /** The @names in order of first appearance, or null for a statement with ? values. */
  names: string[] | null;
  /** How many ? values it takes. */
  count: number;
}

const CACHE_MAX = 1_000;
const cache = new Map<string, Compiled>();
/** A quoted string ('…', '' inside) or a quoted name ("…", "" inside). */
const QUOTED = /'(?:[^']|'')*'|"(?:[^"]|"")*"/g;
const HOLE = /\u0000(\d+)\u0000/g;

function compile(sql: string, tenantKeys: boolean): Compiled {
  // Quoted parts are set aside first, so no rewrite ever touches text inside them, and put back at the end.
  const quoted: string[] = [];
  let code = sql.replace(QUOTED, (q) => `\u0000${quoted.push(q) - 1}\u0000`);
  const names: string[] = [];
  let count = 0;
  code = code.replace(/@([A-Za-z_][A-Za-z0-9_]*)|\?/g, (_m, name: string | undefined) => {
    if (name === undefined) return `$${++count}`;
    const i = names.indexOf(name);
    if (i >= 0) return `$${i + 1}`;
    names.push(name);
    return `$${names.length}`;
  });
  if (count > 0 && names.length > 0) throw new Error('a statement mixes ? and @name values');
  code = code
    .replace(/\bAS\s+([a-z][A-Za-z0-9_]*[A-Z][A-Za-z0-9_]*)\b/g, 'AS "$1"')
    .replace(/\bjson_each\(((?:[^()]|\([^()]*\))*)\)/g, 'json_array_elements_text(($1)::json)')
    .replace(/\bjson_array_length\(([^(),]+),\s*\u0000(\d+)\u0000\)/g, (_m, value: string, hole: string) => {
      const path = /^'\$\.([A-Za-z_][A-Za-z0-9_]*)'$/.exec(quoted[Number(hole)]!);
      if (!path) throw new Error('json_array_length takes only a simple $.key path here');
      return `json_array_length((${value.trim()})::json -> '${path[1]}')`;
    })
    .replace(/\binstr\(/g, 'strpos(')
    .replace(/\bLIKE\b/g, 'ILIKE');
  if (tenantKeys) code = code.replace(/\bON CONFLICT\s*\(\s*(?!tenant_id\b)/g, 'ON CONFLICT (tenant_id, ');
  const text = code.replace(HOLE, (_m, i: string) => quoted[Number(i)]!);
  return { text, names: count > 0 ? null : names, count };
}

/** The Postgres text and its values in order. Throws when the values do not fit the statement. */
export function translate(sql: string, params?: Params, o: TranslateOptions = {}): { text: string; values: unknown[] } {
  const tenantKeys = o.tenantKeys ?? true;
  const key = `${tenantKeys ? 't' : 'p'}\u0001${sql}`;
  let c = cache.get(key);
  if (!c) {
    c = compile(sql, tenantKeys);
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(key, c);
  }
  if (c.names === null) {
    if (params !== undefined && !Array.isArray(params)) throw new Error('a statement with ? takes positional values');
    const values = params ?? [];
    if (values.length !== c.count) throw new Error(`the statement takes ${c.count} values, got ${values.length}`);
    return { text: c.text, values: [...values] };
  }
  if (c.names.length === 0) return { text: c.text, values: [] };
  if (params === undefined || Array.isArray(params)) throw new Error('a statement with @name takes named values');
  const named = params as Record<string, unknown>;
  return {
    text: c.text,
    values: c.names.map((n) => {
      if (!Object.hasOwn(named, n)) throw new Error(`no value for @${n}`);
      return named[n];
    }),
  };
}
