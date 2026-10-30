import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// The first test:pg run (S2.7): SQLite sums a comparison as 0 or 1, but Postgres has no SUM of a boolean ("function
// sum(boolean) does not exist"), so SUM(status = 'done') fails there. Counts are written SUM(CASE WHEN … THEN 1 ELSE 0
// END), which both engines run. This scan fails on any SUM( in src whose argument is, at its top level, a comparison
// or a boolean (=, <>, <, >, AND, OR, NOT, IS, IN, LIKE, BETWEEN, EXISTS) rather than a CASE or a plain value.

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

/** True for an argument that is a comparison or a boolean at its top level. */
export function booleanSum(arg: string): boolean {
  let s = arg.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g, "''").replace(/->>?/g, ' ');
  if (/^\s*CASE\b/i.test(s)) return false;
  // Nested parentheses (a function call, a sub-select) are collapsed: only the top level decides.
  for (let prev = ''; prev !== s; ) {
    prev = s;
    s = s.replace(/\([^()]*\)/g, '()');
  }
  return /<>|!=|<=|>=|=|<|>|\b(?:AND|OR|NOT|IS|IN|LIKE|ILIKE|BETWEEN|EXISTS)\b/i.test(s);
}

/** Each boolean SUM( in a file, as `path:line: SUM(…)`. Whole-line comments are left out. */
function offences(path: string, text: string): string[] {
  const out: string[] = [];
  const lines = text.split(/\r?\n/);
  const code = lines.map((l) => (/^\s*(\/\/|\/\*|\*)/.test(l) ? '' : l)).join('\n');
  for (const m of code.matchAll(/\bSUM\s*\(/gi)) {
    const at = m.index! + m[0].length;
    const arg = argument(code, at);
    if (booleanSum(arg)) out.push(`${path}:${code.slice(0, at).split('\n').length}: SUM(${arg.replace(/\s+/g, ' ').slice(0, 70)})`);
  }
  return out;
}

describe('every SUM( in src runs on both engines (S2.7, the first test:pg run)', () => {
  it('no SUM over a comparison or a boolean anywhere in src', () => {
    expect(files(SRC).flatMap((f) => offences(f, readFileSync(join(SRC, f), 'utf8')))).toEqual([]);
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
