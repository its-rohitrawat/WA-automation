import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The end of SaaS S1 (S1.15): the agent reaches the database only through the async Db interface (src/store/engine/),
// which Postgres serves too (S2). Only src/store/engine/ may hold a better-sqlite3 handle; tests and scripts may reach
// one through rawOf, src never. tests/store/rawAllowlist.txt was S1's ratchet; it stays, and stays empty.
const SRC = join(import.meta.dirname, '../../src');
const ENGINE = 'store/engine/';
const files = readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts')).map((f) => f.replaceAll('\\', '/'));
const allowed = readFileSync(join(import.meta.dirname, 'rawAllowlist.txt'), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);

/** Code lines only: whole-line comments (// …, and the lines of a /** … *\/ block) are left out. */
const codeOf = (text: string) => text.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');

/** Each rule, and why. `prepare` needs a SQL string, so the voice engine's v.prepare({…}) (media/extract.ts) passes. */
const RULES: { name: string; re: RegExp }[] = [
  { name: 'imports better-sqlite3', re: /\bfrom\s+['"]better-sqlite3['"]|\b(?:require|import)\(\s*['"]better-sqlite3['"]\s*\)/ },
  { name: 'prepares a statement', re: /\.prepare\(\s*[`'"]/ },
  { name: 'runs a better-sqlite3 transaction', re: /\.transaction\(/ },
  { name: 'sets a pragma', re: /\.pragma\(/ },
  { name: 'uses the raw handle', re: /\.raw\.(?:prepare|exec|close|pragma|transaction)\(|\brawOf\b/ },
  { name: 'calls txSync', re: /\btxSync\(/ },
];

function offences(path: string, text: string): string[] {
  if (path.startsWith(ENGINE)) return [];
  const code = codeOf(text);
  return RULES.filter((r) => r.re.test(code)).map((r) => `${path} ${r.name}`);
}

describe('S1 done: database access goes through the Db interface', () => {
  it('only src/store/engine/ uses better-sqlite3: no import, statement, transaction, pragma, raw handle or txSync elsewhere', () => {
    expect(files.flatMap((f) => offences(f, readFileSync(join(SRC, f), 'utf8')))).toEqual([]);
  });

  it('the S1 allowlist stays empty', () => {
    expect(allowed).toEqual([]);
  });

  it('catches each rule in a planted file, and lets the look-alikes through', () => {
    for (const line of [
      "import Database from 'better-sqlite3';",
      "db.prepare('SELECT 1').get();",
      'db.prepare(`SELECT ${x}`).all();',
      'db.transaction(() => {})();',
      "db.pragma('journal_mode = WAL');",
      'db.raw.close();',
      "rawOf(db).prepare('SELECT 1');",
      'txSync(db, () => 1);',
    ]) expect(offences('somewhere/else.ts', line), line).not.toEqual([]);
    for (const line of [
      'prepared = await v.prepare({ mediaId: input.mediaId, path: input.path });',
      'const done = [...raw.values()].length;',
      'expect(r.raw).toEqual(DIARIZED);',
      '// db.prepare("x") in a comment is fine',
      " * rawOf in a doc comment is fine",
    ]) expect(offences('somewhere/else.ts', line), line).toEqual([]);
    expect(offences('store/engine/sqlite.ts', "import Database from 'better-sqlite3';")).toEqual([]);
  });
});
