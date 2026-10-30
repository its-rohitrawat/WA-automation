import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { trackerDbPath } from '../../src/config/paths.ts';
import { copyToPostgres, type CopyReport } from '../../src/migrate/copy.ts';
import { FOUNDER_TENANT_ID } from '../../src/platform/store.ts';
import { SqliteDb } from '../../src/store/engine/sqlite.ts';
import { acquireLock } from '../../src/util/lock.ts';
import { FakeTarget } from './fakeTarget.ts';
import { fixture, type Fixture } from './fixture.ts';

// The copy's whole flow against a SQLite stand-in for Postgres (fakeTarget.ts): no server needed. The same flow on a
// real Postgres is tests/migrate/copyPg.test.ts, under npm run test:pg.

let f: Fixture;
let target: FakeTarget;

beforeEach(async () => {
  f = await fixture({ sender: true });
  target = await FakeTarget.open();
});
afterEach(async () => {
  await target.close();
});

const run = (o: Partial<Parameters<typeof copyToPostgres>[0]> = {}) => copyToPostgres({ dataDir: f.data, tenantId: FOUNDER_TENANT_ID, apply: false, ...o }, target);
const refusal = (p: Promise<unknown>) => p.then(() => { throw new Error('expected a refusal'); }, (e: unknown) => e as Error);
const table = (r: CopyReport, name: string) => r.tables.find((t) => t.table === name)!;

describe('migrate-to-postgres: the dry run (the default)', () => {
  it('copies and checks every table inside one transaction, then rolls it all back', async () => {
    const before = f.hashes();
    const r = await run();
    expect(r).toMatchObject({ ok: true, applied: false, backup: null });
    expect(r.tables.length).toBeGreaterThan(20);
    expect(r.tables.every((t) => t.match && t.source.rows === t.target.rows && t.source.sha256 === t.target.sha256)).toBe(true);
    expect(table(r, 'tracker:messages').source.rows).toBe(5);
    expect(table(r, 'tracker:media').source.rows).toBe(1);
    expect(r.tables.filter((t) => t.targetTable === 'wa_auth').map((t) => [t.table, t.source.rows])).toEqual([
      ['session:auth', 2], ['session:auth_backup', 1], ['sender:auth', 1], ['sender:auth_backup', 0],
    ]);
    // Rolled back: nothing stayed, and no sequence moved.
    expect(await target.count('messages')).toBe(0);
    expect(await target.count('wa_auth')).toBe(0);
    expect(await target.count('tenants')).toBe(1); // only the founder's seeded row
    expect(target.setvals).toEqual([]);
    expect(target.tenants).toEqual([FOUNDER_TENANT_ID]);
    expect(f.hashes()).toEqual(before); // the SQLite files are byte for byte as they were
    expect(readdirSync(f.dir)).toEqual(['data']); // no backup made
  });

  it('a file whose session files are missing copies what there is', async () => {
    const g = await fixture();
    const r = await copyToPostgres({ dataDir: g.data, tenantId: FOUNDER_TENANT_ID, apply: false }, target);
    expect(r.ok).toBe(true);
    expect(r.tables.some((t) => t.table.startsWith('sender:'))).toBe(false);
  });
});

describe('migrate-to-postgres --apply', () => {
  it('makes a checked backup first, copies from it, keeps every id, moves the sequences on, and commits', async () => {
    const before = f.hashes();
    const backupDir = join(f.dir, 'backup');
    const r = await run({ apply: true, backupDir });
    expect(r).toMatchObject({ ok: true, applied: true, backup: backupDir });
    expect(readdirSync(backupDir).sort()).toEqual(['sender-session.db', 'session.db', 'tracker.db']);
    // The backup holds what the source holds.
    const b = SqliteDb.open(join(backupDir, 'tracker.db'), { readonly: true });
    expect(await b.get('SELECT count(*) AS n FROM messages')).toEqual({ n: 5 });
    await b.close();
    // Committed, with the same ids.
    const src = SqliteDb.open(trackerDbPath(f.data), { readonly: true });
    expect(await target.db.all('SELECT id, wa_id FROM messages ORDER BY id')).toEqual(await src.all('SELECT id, wa_id FROM messages ORDER BY id'));
    expect(await target.db.all('SELECT id, ref_enc FROM media')).toEqual(await src.all('SELECT id, ref_enc FROM media'));
    await src.close();
    expect(await target.db.all("SELECT phone, slot, k FROM wa_auth ORDER BY phone, slot, k")).toEqual([
      { phone: 'founder', slot: 'backup', k: 'creds' }, { phone: 'founder', slot: 'live', k: 'creds' }, { phone: 'founder', slot: 'live', k: 'pre-key-1' },
      { phone: 'spare', slot: 'live', k: 'creds' },
    ]);
    // The founder's seeded row now holds the SQLite founder's name; the customers came across too.
    expect(await target.db.get('SELECT name, kind FROM tenants WHERE id = ?', [FOUNDER_TENANT_ID])).toEqual({ name: 'Your studio', kind: 'founder' });
    expect(await target.count('tenants')).toBe(3);
    expect(target.setvals).toContain('messages');
    expect(target.setvals).toContain('platform_audit');
    expect(target.setvals).not.toContain('wa_auth');
    expect(f.hashes()).toEqual(before);
  });

  it('needs --backup-dir, and a folder that does not exist yet', async () => {
    expect((await refusal(run({ apply: true }))).message).toMatch(/--backup-dir/);
    const there = join(f.dir, 'there');
    mkdirSync(there);
    expect((await refusal(run({ apply: true, backupDir: there }))).message).toMatch(/already exists/);
    expect(await target.count('messages')).toBe(0);
  });

  it('refuses to copy twice: a target table it would write into already has rows', async () => {
    await run({ apply: true, backupDir: join(f.dir, 'b1') });
    const e = await refusal(run({ apply: true, backupDir: join(f.dir, 'b2') }));
    expect(e.message).toMatch(/already has data in clients/);
    expect(await target.count('messages')).toBe(5); // the first copy stays, untouched
  });
});

describe('what stops the copy before it writes anything', () => {
  it('the agent is running (its instance lock is held)', async () => {
    const lock = await acquireLock(f.data);
    try {
      expect((await refusal(run())).message).toMatch(/The agent is running/);
    } finally {
      await lock.release();
    }
  });

  it('tracker.db is not at the version this code copies', async () => {
    const w = SqliteDb.open(trackerDbPath(f.data));
    await w.run('DELETE FROM schema_version WHERE version = (SELECT max(version) FROM schema_version)');
    await w.close();
    expect((await refusal(run())).message).toMatch(/tracker\.db is at v\d+; this version copies v\d+/);
  });

  it('Postgres is not at the latest schema', async () => {
    target.version = 2;
    expect((await refusal(run())).message).toMatch(/Postgres is at P2; run npm run cli -- db-migrate first/);
    expect(await target.count('messages')).toBe(0);
  });

  it('there is no tracker.db', async () => {
    expect((await refusal(copyToPostgres({ dataDir: join(f.dir, 'nowhere'), tenantId: FOUNDER_TENANT_ID, apply: false }, target))).message).toMatch(/tracker\.db/);
  });
});

describe('a mismatch', () => {
  it('rolls the whole copy back, even with --apply, names the table, and writes nothing', async () => {
    target.beforeVerify = async (q) => {
      await q.run("UPDATE messages SET text = 'changed in transit' WHERE wa_id = 'WA2'");
    };
    const r = await run({ apply: true, backupDir: join(f.dir, 'backup') });
    expect(r).toMatchObject({ ok: false, applied: false });
    expect(r.tables.filter((t) => !t.match).map((t) => t.table)).toEqual(['tracker:messages']);
    expect(table(r, 'tracker:messages').source.rows).toBe(table(r, 'tracker:messages').target.rows); // same count, other content
    expect(await target.count('messages')).toBe(0);
    expect(target.setvals).toEqual([]);
    expect(existsSync(join(f.dir, 'backup', 'tracker.db'))).toBe(true); // the backup it made stays
  });
});
