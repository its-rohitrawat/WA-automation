import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// The Postgres conversion (S2.7): SQLite's two-argument MAX(a, b) and MIN(a, b) pick the larger or smaller value, but
// Postgres has no such forms (its GREATEST and LEAST do that, and SQLite has neither). A choice between two values is
// written CASE WHEN … THEN … ELSE … END, which both engines run. This scan fails on a MAX( or MIN( in src with two or
// more arguments (a one-argument aggregate, MAX(ts), stays), and on GREATEST( or LEAST( outside the Postgres-only code.

const SRC = join(import.meta.dirname, '../../../src');

function files(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else if (e.name.endsWith('.ts')) out.push(relative(SRC, p).split(sep).join('/'));
  }
  return out.sort();
}

/** Lane B's sites, which lane B fixes: at most this many each until then. A ceiling. */
const PENDING: Record<string, number> = { 'store/tasks.ts': 1, 'store/meetings.ts': 1 };

/** Code that only ever talks to Postgres (the copy target, its schema, its engine): GREATEST and LEAST are fine there. */
const POSTGRES_ONLY = (path: string) => path === 'migrate/target.ts' || path === 'store/engine/pg.ts' || path.startsWith('store/pg/');

/** The text from `open` (just past a parenthesis) to its matching close, with quoted strings skipped. */
function argument(text: string, open: number): string {
  let depth = 1;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      const end = text.indexOf(ch, i + 1);
      if (end < 0) break;
      i = end;
    } else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return text.slice(open, i);
  }
  return text.slice(open);
}

/** True for an argument list with two or more arguments at its top level. */
export function twoOrMore(arg: string): boolean {
  let s = arg.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g, "''");
  for (let prev = ''; prev !== s; ) {
    prev = s;
    s = s.replace(/\([^()]*\)/g, '()');
  }
  return s.includes(',');
}

/** Each offending call in a file, as `path:line: …`. Whole-line comments are left out. */
function offences(path: string, text: string): string[] {
  const out: string[] = [];
  const code = text.split(/\r?\n/).map((l) => (/^\s*(\/\/|\/\*|\*)/.test(l) ? '' : l)).join('\n');
  const line = (at: number) => code.slice(0, at).split('\n').length;
  // Not after a dot or a name: Math.max(a, b) and z.string().max(80) are JavaScript.
  for (const m of code.matchAll(/(?<![.\w$])(MAX|MIN)\s*\(/gi)) {
    const at = m.index! + m[0].length;
    const arg = argument(code, at);
    if (twoOrMore(arg)) out.push(`${path}:${line(at)}: ${m[1]}(${arg.replace(/\s+/g, ' ').slice(0, 60)})`);
  }
  if (!POSTGRES_ONLY(path)) for (const m of code.matchAll(/(?<![.\w$])(GREATEST|LEAST)\s*\(/gi)) out.push(`${path}:${line(m.index!)}: ${m[1]}(`);
  return out;
}

describe('no two-argument MAX or MIN in src, and GREATEST or LEAST only in Postgres-only code (S2.7)', () => {
  it('none, beyond lane B’s pending sites', () => {
    const wrong: string[] = [];
    for (const f of files(SRC)) {
      const found = offences(f, readFileSync(join(SRC, f), 'utf8'));
      if (found.length > (PENDING[f] ?? 0)) wrong.push(...found);
    }
    expect(wrong).toEqual([]);
  });

  it('catches MAX(a, b), MIN(a, b), behind a call too, and GREATEST/LEAST; passes aggregates, JS and comments', () => {
    for (const bad of [
      "x = MAX(COALESCE(last_reminder_on, ''), @onDate)", 'SET attempts = MIN(attempts, 1)', 'max(a, b, c)', "MIN(lower(x), 'z')",
      'SELECT GREATEST(a, b)', 'least(a, 1)',
    ]) expect(offences('x.ts', bad), bad).not.toEqual([]);
    for (const fine of [
      'SELECT MAX(ts) AS last', 'MIN(at)', "MAX(COALESCE(a, b))", 'MAX(CASE WHEN a > b THEN a ELSE b END)', 'Math.max(a, b)', 'z.string().max(80)',
      ' * min(size bound, STT_MAX_SECONDS + tolerance)', '// MAX(a, b) in a comment', "COUNT(CASE WHEN x = 'a, b' THEN 1 END)", "MAX(',')",
    ]) expect(offences('x.ts', fine), fine).toEqual([]);
    expect(offences('migrate/target.ts', 'SELECT setval(s, GREATEST(a, 1))')).toEqual([]);
    expect(offences('store/clients.ts', 'SELECT GREATEST(a, 1)')).not.toEqual([]);
  });
});
