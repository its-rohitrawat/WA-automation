import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senderSessionDbPath, sessionDbPath, trackerDbPath } from '../../src/config/paths.ts';
import { tableChecksum } from '../../src/migrate/canonical.ts';
import { copyToPostgres } from '../../src/migrate/copy.ts';
import { exportToSqlite } from '../../src/migrate/exportBack.ts';
import { copyPlan } from '../../src/migrate/plan.ts';
import { FOUNDER_TENANT_ID } from '../../src/platform/store.ts';
import { SqliteDb } from '../../src/store/engine/sqlite.ts';
import { acquireLock } from '../../src/util/lock.ts';
import { FakeTarget } from './fakeTarget.ts';
import { fixture, type Fixture } from './fixture.ts';
import { onSqlite } from '../helpers/db.ts';

// export-to-sqlite against the SQLite stand-in for Postgres: a round trip SQLite -> "Postgres" -> new SQLite files gives
// the same tables back, plus what was added on the Postgres side. The real-server version is copyPg.test.ts.

let f: Fixture;
let pg: FakeTarget;

beforeEach(async () => {
  f = await fixture({ sender: true });
  pg = await FakeTarget.open();
  const r = await copyToPostgres({ dataDir: f.data, tenantId: FOUNDER_TENANT_ID, apply: true, backupDir: join(f.dir, 'backup') }, pg);
  expect(r.ok).toBe(true);
});
afterEach(async () => {
  await pg.close();
});

const refusal = (p: Promise<unknown>) => p.then(() => { throw new Error('expected a refusal'); }, (e: unknown) => e as Error);

/** Each table's checksum in a tracker.db, for comparing two of them. */
async function sums(file: string): Promise<Record<string, string>> {
  const db = SqliteDb.open(file, { readonly: true });
  try {
    const out: Record<string, string> = {};
    for (const p of await copyPlan(db)) out[p.table] = tableChecksum(p.columns, await db.all(`SELECT ${p.columns.join(', ')} FROM ${p.table}`)).sha256;
    return out;
  } finally {
    await db.close();
  }
}

// SQLite only (the describe): new SQLite files from a SQLite stand-in, so a test:pg run would only repeat it; the real
// server is copyPg.test.ts.
describe.runIf(onSqlite)('export-to-sqlite', () => {
  it('writes new files in a new folder that hold exactly what the original files held', async () => {
    const out = join(f.dir, 'from-postgres');
    const before = f.hashes();
    const r = await exportToSqlite({ dataDir: f.data, tenantId: FOUNDER_TENANT_ID, out }, pg);
    expect(r).toMatchObject({ ok: true, applied: true });
    expect(r.tables.every((t) => t.match)).toBe(true);
    expect(readdirSync(out).filter((n) => n.endsWith('.db')).sort()).toEqual(['sender-session.db', 'session.db', 'tracker.db']);
    expect(await sums(join(out, 'tracker.db'))).toEqual(await sums(trackerDbPath(f.data)));
    for (const [file, original] of [['session.db', sessionDbPath(f.data)], ['sender-session.db', senderSessionDbPath(f.data)]] as const) {
      const a = SqliteDb.open(join(out, file), { readonly: true });
      const b = SqliteDb.open(original, { readonly: true });
      for (const t of ['auth', 'auth_backup']) expect(await a.all(`SELECT k, v FROM ${t} ORDER BY k`), `${file} ${t}`).toEqual(await b.all(`SELECT k, v FROM ${t} ORDER BY k`));
      await a.close();
      await b.close();
    }
    expect(f.hashes()).toEqual(before); // data/ is never written
  });

  it('brings back what was added on the Postgres side, keeping its ids', async () => {
    await pg.db.run("INSERT INTO kv (k, v) VALUES ('after.cutover', '1')");
    const out = join(f.dir, 'from-postgres');
    expect((await exportToSqlite({ dataDir: f.data, tenantId: FOUNDER_TENANT_ID, out }, pg)).ok).toBe(true);
    const back = SqliteDb.open(join(out, 'tracker.db'), { readonly: true });
    expect(await back.get("SELECT v FROM kv WHERE k = 'after.cutover'")).toEqual({ v: '1' });
    expect(await back.all('SELECT id, wa_id FROM messages ORDER BY id')).toEqual(await pg.db.all('SELECT id, wa_id FROM messages ORDER BY id'));
    await back.close();
  });

  it('makes no sender-session.db when there are no spare-phone keys', async () => {
    await pg.db.run("DELETE FROM wa_auth WHERE phone = 'spare'");
    const out = join(f.dir, 'from-postgres');
    expect((await exportToSqlite({ dataDir: f.data, tenantId: FOUNDER_TENANT_ID, out }, pg)).ok).toBe(true);
    expect(existsSync(join(out, 'sender-session.db'))).toBe(false);
  });

  it('refuses a folder that exists, and a running agent; writes nothing to Postgres', async () => {
    const there = join(f.dir, 'there');
    mkdirSync(there);
    expect((await refusal(exportToSqlite({ dataDir: f.data, tenantId: FOUNDER_TENANT_ID, out: there }, pg))).message).toMatch(/already exists/);
    const lock = await acquireLock(f.data);
    try {
      expect((await refusal(exportToSqlite({ dataDir: f.data, tenantId: FOUNDER_TENANT_ID, out: join(f.dir, 'x') }, pg))).message).toMatch(/The agent is running/);
    } finally {
      await lock.release();
    }
    expect(await pg.count('messages')).toBe(5);
  });

  it('a mismatch says so: the files are left, marked not to be used', async () => {
    const out = join(f.dir, 'from-postgres');
    const r = await exportToSqlite({ dataDir: f.data, tenantId: FOUNDER_TENANT_ID, out, afterWrite: async (files) => {
      await files.tracker.run("UPDATE clients SET name = 'changed' WHERE code = 'SHA'");
    } }, pg);
    expect(r.ok).toBe(false);
    expect(r.tables.filter((t) => !t.match).map((t) => t.table)).toEqual(['tracker:clients']);
    expect(existsSync(join(out, 'DO-NOT-USE.txt'))).toBe(true);
  });
});
