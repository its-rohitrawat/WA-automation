import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// Merge-readiness R1: on SQLite (DB_ENGINE unset, the default) nothing in the service's start loads the pg package, so
// a Mac whose update skipped npm ci still starts. A fresh Node process, with a resolve hook that records every request
// for pg, imports everything main.ts imports and opens the SQLite store and platform store. Then, as the control that
// proves the hook sees pg, it makes a Postgres pool object (no connection is made: nothing reaches a server).

const SRC = join(import.meta.dirname, '../../src');
const url = (rel: string) => pathToFileURL(join(SRC, rel)).href;

/** main.ts's own imports (relative ones): the modules the service loads at start, before main() runs. */
function mainImports(): string[] {
  const text = readFileSync(join(SRC, 'main.ts'), 'utf8');
  return [...text.matchAll(/^import (?!type )[^\n]* from '(\.\/[^']+)';$/gm)].map((m) => url(m[1]!.slice(2)));
}

describe('the pg package loads only on the Postgres path (merge-readiness R1)', () => {
  it('main.ts’s modules and a SQLite store load no pg; a Postgres pool does', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wa-pglazy-'));
    try {
      const modules = mainImports();
      expect(modules.length).toBeGreaterThan(10);
      expect(modules).toContain(url('store/open.ts'));
      const child = join(dir, 'child.mjs');
      writeFileSync(child, `
import { registerHooks } from 'node:module';
const seen = [];
registerHooks({ resolve(specifier, context, next) { if (/^pg(\\/|$)/.test(specifier)) seen.push(specifier); return next(specifier, context); } });
for (const m of ${JSON.stringify(modules)}) await import(m);
const { openStore, openPlatformStore } = await import(${JSON.stringify(url('store/open.ts'))});
const db = await openStore({ DATA_DIR: ${JSON.stringify(dir)}, TENANT_ID: '00000000-0000-4000-8000-000000000001' });
const platform = openPlatformStore({}, db);
await db.get('SELECT 1 AS ok');
const sqlite = [...seen];
await db.close();
const { openPgPool } = await import(${JSON.stringify(url('store/engine/pg.ts'))});
const pool = openPgPool('postgres://wa_app@127.0.0.1:9/none');
await pool.end();
process.stdout.write(JSON.stringify({ sqlite, platformIsTracker: platform === db, afterPool: seen.length }));
`);
      const r = spawnSync(process.execPath, [child], { encoding: 'utf8', env: { ...process.env, DB_ENGINE: '' }, timeout: 60_000 });
      expect(r.status, r.stderr).toBe(0);
      const out = JSON.parse(r.stdout) as { sqlite: string[]; platformIsTracker: boolean; afterPool: number };
      expect(out.sqlite).toEqual([]); // nothing asked for pg on the SQLite path
      expect(out.platformIsTracker).toBe(true);
      expect(out.afterPool).toBeGreaterThan(0); // the control: the hook does see pg once a pool is made
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000); // a fresh Node process importing the whole app: about 4 s alone, far more on a busy full run
});
