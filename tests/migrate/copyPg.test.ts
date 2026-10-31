import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { trackerDbPath } from '../../src/config/paths.ts';
import { tableChecksum } from '../../src/migrate/canonical.ts';
import { copyToPostgres } from '../../src/migrate/copy.ts';
import { exportToSqlite } from '../../src/migrate/exportBack.ts';
import { copyPlan } from '../../src/migrate/plan.ts';
import { postgresTarget } from '../../src/migrate/target.ts';
import { openAdminConnection, openPgPool, PgTenantDb } from '../../src/store/engine/pg.ts';
import { SqliteDb } from '../../src/store/engine/sqlite.ts';
import { onPg } from '../helpers/pg.ts';
import { fixture } from './fixture.ts';
import { freshPg, type FreshPg } from './freshPg.ts';

// The copy and the export back on a real Postgres 17 (npm run test:pg; skipped otherwise). The copy keeps every id, so
// it goes only into a fresh database (docs/GO-LIVE-postgres.md, part 4): each test gets a database of its own, made and
// migrated as the real one is, and dropped after it. The fixture has no platform rows.

async function newTenant(ownerUrl: string): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const owner = await openAdminConnection(ownerUrl);
  try {
    await owner.sql("INSERT INTO tenants (id, name, status, created_at, updated_at) VALUES ($1, 'copy test', 'active', $2, $2)", [id, now]);
  } finally {
    await owner.end();
  }
  return id;
}

/** Each customer table's checksum in a tracker.db. */
async function customerSums(file: string): Promise<Record<string, string>> {
  const db = SqliteDb.open(file, { readonly: true });
  try {
    const out: Record<string, string> = {};
    for (const p of (await copyPlan(db)).filter((x) => !x.platform)) out[p.table] = tableChecksum(p.columns, await db.all(`SELECT ${p.columns.join(', ')} FROM ${p.table}`)).sha256;
    return out;
  } finally {
    await db.close();
  }
}

describe.runIf(onPg)('migrate-to-postgres and export-to-sqlite on a real Postgres', () => {
  let pg: FreshPg;
  beforeEach(async () => {
    pg = await freshPg();
  });
  afterEach(async () => {
    await pg.drop();
  });

  it('a dry run keeps nothing; --apply keeps every id; the export gives the same tables back; new ids come after', async () => {
    const t = pg.urls;
    const tenantId = await newTenant(t.ownerUrl);
    const f = await fixture({ sender: true, platform: false });
    const target = postgresTarget(t.ownerUrl);
    const app = new PgTenantDb(openPgPool(t.appUrl, { max: 2 }), tenantId);
    try {
      const dry = await copyToPostgres({ dataDir: f.data, tenantId, apply: false }, target);
      expect(dry).toMatchObject({ ok: true, applied: false });
      expect(await app.get('SELECT count(*) AS n FROM messages')).toEqual({ n: 0 });

      const before = f.hashes();
      const r = await copyToPostgres({ dataDir: f.data, tenantId, apply: true, backupDir: join(f.dir, 'backup') }, target);
      expect(r).toMatchObject({ ok: true, applied: true });
      expect(r.tables.every((x) => x.match)).toBe(true);
      expect(f.hashes()).toEqual(before);
      const src = SqliteDb.open(trackerDbPath(f.data), { readonly: true });
      try {
        expect(await app.all('SELECT id, wa_id FROM messages ORDER BY id')).toEqual(await src.all('SELECT id, wa_id FROM messages ORDER BY id'));
        expect(await app.all('SELECT id, ref_enc FROM media')).toEqual(await src.all('SELECT id, ref_enc FROM media'));
        expect(await app.get("SELECT count(*) AS n FROM wa_auth WHERE phone = 'founder'")).toEqual({ n: 3 });

        const out = join(f.dir, 'from-postgres');
        const back = await exportToSqlite({ dataDir: f.data, tenantId, out, platform: false }, target);
        expect(back.ok).toBe(true);
        expect(await customerSums(join(out, 'tracker.db'))).toEqual(await customerSums(trackerDbPath(f.data)));

        // The sequence moved on: a new row gets an id above every copied one, with no clash.
        const maxClient = (await src.get<{ m: number }>('SELECT max(id) AS m FROM clients'))!.m;
        const made = await app.get<{ id: number }>("INSERT INTO clients (code, name, group_id, phases) VALUES ('NEW', 'New', 'new@g.us', '[]') RETURNING id");
        expect(made!.id).toBeGreaterThan(maxClient);
      } finally {
        await src.close();
      }
    } finally {
      await app.close();
      await target.close();
    }
  });

  it("another customer sees none of the copied rows; copying twice, or a second customer's copy, is refused", async () => {
    const t = pg.urls;
    const a = await newTenant(t.ownerUrl);
    const b = await newTenant(t.ownerUrl);
    const f = await fixture({ platform: false });
    const target = postgresTarget(t.ownerUrl);
    const other = new PgTenantDb(openPgPool(t.appUrl, { max: 2 }), b);
    try {
      expect((await copyToPostgres({ dataDir: f.data, tenantId: a, apply: true, backupDir: join(f.dir, 'b1') }, target)).applied).toBe(true);
      expect(await other.get('SELECT count(*) AS n FROM messages')).toEqual({ n: 0 });
      expect(await other.get('SELECT count(*) AS n FROM wa_auth')).toEqual({ n: 0 });
      await expect(copyToPostgres({ dataDir: f.data, tenantId: a, apply: true, backupDir: join(f.dir, 'b2') }, target)).rejects.toThrow(/already has data in clients/);
      // Another customer's copy into the same database: its ids would clash with A's, so it is refused, plainly.
      await expect(copyToPostgres({ dataDir: f.data, tenantId: b, apply: true, backupDir: join(f.dir, 'b3') }, target)).rejects.toThrow(/already given out ids in \w+ .*fresh database, before any customer exists/);
      expect(await other.get('SELECT count(*) AS n FROM messages')).toEqual({ n: 0 });
    } finally {
      await other.close();
      await target.close();
    }
  });
});
