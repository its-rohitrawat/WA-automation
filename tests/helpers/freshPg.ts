import { randomBytes } from 'node:crypto';
import { openAdminConnection, openPgPool, PgPlatformDb, PgTenantDb, type PgPool } from '../../src/store/engine/pg.ts';
import { databaseGrants, migrate } from '../../src/store/pg/admin.ts';
import { testPg, type TestPg } from './pg.ts';

// A database of its own for one test (npm run test:pg), where the shared test database cannot stand in:
// - the copy keeps every id, and Postgres gives ids out across all customers, so on the shared database other tests'
//   rows already hold ids 1, 2 and on: the founder's copy goes only into a fresh database (docs/GO-LIVE-postgres.md,
//   part 4), and so does each copy test;
// - the Supervisor runs every customer in the tenants table, so a runtime test needs one holding only its own.
// It is created as bootstrap creates the real one (owned by wa_owner, the same grants), migrated by db-migrate's own
// code as wa_owner (so the founder's row is there, as P1 seeds it), and dropped afterwards. The roles are the shared
// server's; no password is made, changed or written here.

export interface FreshPg {
  /** The same four roles' URLs, on this database. */
  urls: TestPg;
  /** The platform tables as wa_platform, on this database's platform pool (drop ends it). */
  platformDb(): PgPlatformDb;
  /** A customer's own tables as wa_app, for a customer already in this database's tenants (drop ends the pool). */
  tenantDb(tenantId: string): PgTenantDb;
  /** Ends this database's pools and drops it (any connection left over is ended). */
  drop(): Promise<void>;
}

const NAME = /^wa_test_fresh_[0-9a-f]{12}$/;

/** `url` on another database of the same server. */
function on(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.href;
}

function serverUrl(): string {
  const url = process.env.TEST_PG_SERVER_URL;
  if (!url) throw new Error('a fresh database needs TEST_PG_SERVER_URL (the test server\'s admin, set by npm run test:pg)');
  return url;
}

export async function freshPg(): Promise<FreshPg> {
  const t = testPg();
  if (!t) throw new Error('this test needs the Postgres test server: run npm run test:pg');
  const name = `wa_test_fresh_${randomBytes(6).toString('hex')}`;
  const server = await openAdminConnection(on(serverUrl(), 'postgres'));
  try {
    await server.sql(`CREATE DATABASE ${name} OWNER wa_owner ENCODING 'UTF8' TEMPLATE template0`);
  } finally {
    await server.end();
  }
  const pools: PgPool[] = [];
  const drop = async () => {
    if (!NAME.test(name)) throw new Error('not a fresh test database');
    for (const p of pools.splice(0)) await p.end().catch(() => undefined); // a Db's close() may have ended it already
    const s = await openAdminConnection(on(serverUrl(), 'postgres'));
    try {
      await s.sql(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } finally {
      await s.end();
    }
  };
  const urls: TestPg = { appUrl: on(t.appUrl, name), ownerUrl: on(t.ownerUrl, name), platformUrl: on(t.platformUrl, name), backupUrl: on(t.backupUrl, name) };
  try {
    const inDb = await openAdminConnection(on(serverUrl(), name));
    try {
      for (const sql of databaseGrants(name)) await inDb.sql(sql);
    } finally {
      await inDb.end();
    }
    const owner = await openAdminConnection(urls.ownerUrl);
    try {
      await migrate(owner, { now: () => new Date().toISOString(), out: () => {} });
    } finally {
      await owner.end();
    }
  } catch (e) {
    await drop(); // a half-made database is not left behind
    throw e;
  }
  let app: PgPool | undefined;
  let platform: PgPool | undefined;
  const pool = (url: string) => {
    const p = openPgPool(url, { max: 4 });
    pools.push(p);
    return p;
  };
  return {
    urls,
    platformDb: () => new PgPlatformDb((platform ??= pool(urls.platformUrl))),
    tenantDb: (tenantId) => new PgTenantDb((app ??= pool(urls.appUrl)), tenantId, { ownsPool: false }),
    drop,
  };
}
