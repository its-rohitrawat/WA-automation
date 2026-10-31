import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// The second test:pg run (S2.7): Postgres cannot type a parameter that stands alone in `X IS NULL` ("could not
// determine data type of parameter $1"), so `(@client IS NULL OR c.code = @client)` fails there. An optional filter
// is added in TypeScript only when it is given. This scan fails on `@name IS NULL`, `? IS NULL` or `$n IS NULL` (and
// IS NOT NULL) anywhere in src.

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

/** Lane B's sites, which lane B fixes (the run's one real bug): at most this many each until then. A ceiling. */
const PENDING: Record<string, number> = { 'store/media.ts': 3, 'store/meetings.ts': 1 };

const BARE = /(?:@[A-Za-z_]\w*|\?|\$\d+)\s+IS\s+(?:NOT\s+)?NULL\b/gi;

/** Each bare-parameter IS NULL in a file, as `path:line: …`. Whole-line comments are left out. */
function offences(path: string, text: string): string[] {
  const out: string[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*(\/\/|\/\*|\*)/.test(line)) return;
    for (const m of line.matchAll(BARE)) out.push(`${path}:${i + 1}: ${m[0]}`);
  });
  return out;
}

describe('no bare parameter in IS NULL in src (S2.7, the second test:pg run)', () => {
  it('none, beyond lane B’s pending sites', () => {
    const wrong: string[] = [];
    for (const f of files(SRC)) {
      const found = offences(f, readFileSync(join(SRC, f), 'utf8'));
      if (found.length > (PENDING[f] ?? 0)) wrong.push(...found);
    }
    expect(wrong).toEqual([]);
  });

  it('catches @name, ? and $n with IS NULL or IS NOT NULL; passes a column, a cast and a comment', () => {
    for (const bad of ['(@client IS NULL OR c.code = @client)', 'AND (? IS NULL OR meeting_id = ?)', 'WHERE $1 IS NOT NULL', '@mediaId  is  null'])
      expect(offences('x.ts', bad), bad).not.toEqual([]);
    for (const fine of ['next_try_at IS NULL', 'm.deadline IS NOT NULL', 'CAST(@x AS text) IS NULL', '// (@client IS NULL OR …) in a comment', "const a = b ?? null;"])
      expect(offences('x.ts', fine), fine).toEqual([]);
  });
});
