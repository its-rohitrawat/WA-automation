import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// S1 ratchet: only the files on tests/store/rawAllowlist.txt may still use better-sqlite3 directly (db.raw, txSync).
// Each S1 task removes its files from the list; S1.15 deletes the list, raw and txSync.
const SRC = join(import.meta.dirname, '../../src');
const ENGINE = 'store/engine/';
const allowed = new Set(readFileSync(join(import.meta.dirname, 'rawAllowlist.txt'), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean));
const files = readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts')).map((f) => f.replaceAll('\\', '/'));
// Not every .raw: brain/validator.ts and stt/providers/elevenlabs.ts use a .raw that has nothing to do with the database.
const direct = (f: string) => /\.raw\.(?:prepare|transaction|exec|pragma)\(|\btxSync\(|\.prepare\(|\.transaction\(/.test(readFileSync(join(SRC, f), 'utf8'));

describe('S1 ratchet: database access goes through the Db interface', () => {
  it('only allowlisted files use better-sqlite3 directly', () => {
    expect(files.filter((f) => !f.startsWith(ENGINE) && direct(f) && !allowed.has(f))).toEqual([]);
  });
  it('the allowlist names only files that still need it (so it shrinks)', () => {
    expect([...allowed].filter((f) => !files.includes(f) || !direct(f))).toEqual([]);
  });
});
