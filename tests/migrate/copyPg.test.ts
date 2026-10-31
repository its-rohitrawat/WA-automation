import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FOUNDER_TENANT_ID } from '../../src/config/env.ts';
import { trackerDbPath } from '../../src/config/paths.ts';
import { tableChecksum, type TableSum } from '../../src/migrate/canonical.ts';
import { copyToPostgres } from '../../src/migrate/copy.ts';
import { exportToSqlite } from '../../src/migrate/exportBack.ts';
import { copyPlan } from '../../src/migrate/plan.ts';
import { postgresTarget } from '../../src/migrate/target.ts';
import { TenantKeys } from '../../src/platform/tenantKeys.ts';
import { openDb } from '../../src/store/db.ts';
import { openAdminConnection, openPgPool, PgTenantDb } from '../../src/store/engine/pg.ts';
import { SqliteDb } from '../../src/store/engine/sqlite.ts';
import { manualClock } from '../../src/util/clock.ts';
import { onPg } from '../helpers/pg.ts';
import { fixture } from './fixture.ts';
import { freshPg, type FreshPg } from '../helpers/freshPg.ts';

// The copy and the export back on a real Postgres 17 (npm run test:pg; skipped otherwise). The copy keeps every id, so
// it goes only into a fresh database (docs/GO-LIVE-postgres.md, part 4): each test gets a database of its own, made and
// migrated as the real one is, and dropped after it. The first two fixtures have no platform rows; the last one has
// them, as the founder's tracker.db does after invites made on SQLite (guide part 4).

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

  it('carries the platform tables made on SQLite: the founder updated in place, a customer, its user, membership, invites and wrapped key, which still unwraps', async () => {
    const f = await fixture({ platform: true });
    const master = randomBytes(32);
    const clock = manualClock('2026-10-30T07:00:00.000Z');
    // The customer who signed up gets its data key, wrapped with the master key, as the Supervisor makes it on SQLite.
    const lite = openDb(trackerDbPath(f.data));
    let customer: string;
    let keyOnSqlite: Buffer;
    const platformTables: { table: string; columns: string[]; sum: TableSum }[] = [];
    try {
      customer = (await lite.get<{ id: string }>("SELECT id FROM tenants WHERE name = 'Kapoor Design Studio'"))!.id;
      keyOnSqlite = await new TenantKeys({ db: lite, master, clock }).dataKey(customer);
      for (const p of (await copyPlan(lite)).filter((x) => x.platform)) {
        platformTables.push({ table: p.table, columns: p.columns, sum: tableChecksum(p.columns, await lite.all(`SELECT ${p.columns.join(', ')} FROM ${p.table}`)) });
      }
    } finally {
      await lite.close();
    }
    // The founder and two invited businesses (one signed up), its user and membership, two invites, one wrapped key.
    const rows = (table: string) => platformTables.find((x) => x.table === table)?.sum.rows;
    expect(['tenants', 'users', 'memberships', 'invites', 'tenant_keys'].map(rows)).toEqual([3, 1, 1, 2, 1]);

    const target = postgresTarget(pg.urls.ownerUrl);
    const platform = pg.platformDb();
    try {
      const r = await copyToPostgres({ dataDir: f.data, tenantId: FOUNDER_TENANT_ID, apply: true, backupDir: join(f.dir, 'backup') }, target);
      expect(r).toMatchObject({ ok: true, applied: true });
      for (const { table } of platformTables) expect(r.tables.find((x) => x.table === `tracker:${table}`)?.match, table).toBe(true);
      // The seeded founder row, updated in place: one founder, with the SQLite name.
      expect(await platform.all("SELECT id, name FROM tenants WHERE kind = 'founder'")).toEqual([{ id: FOUNDER_TENANT_ID, name: 'Your studio' }]);
      // Read again as wa_platform (not the copy's own owner check): each platform table holds exactly the SQLite rows.
      for (const { table, columns, sum } of platformTables) {
        expect(tableChecksum(columns, await platform.all(`SELECT ${columns.join(', ')} FROM ${table}`)), table).toEqual(sum);
      }
      // The wrapped key unwraps on Postgres with the same master key, to the same data key; with another, it does not.
      expect(await new TenantKeys({ db: platform, master, clock }).dataKey(customer)).toEqual(keyOnSqlite);
      await expect(new TenantKeys({ db: platform, master: randomBytes(32), clock }).dataKey(customer)).rejects.toThrow();
    } finally {
      await platform.close();
      await target.close();
    }
  });
});
