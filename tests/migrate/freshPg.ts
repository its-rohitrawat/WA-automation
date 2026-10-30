import { randomBytes } from 'node:crypto';
import { openAdminConnection } from '../../src/store/engine/pg.ts';
import { databaseGrants, migrate } from '../../src/store/pg/admin.ts';
import { testPg, type TestPg } from '../helpers/pg.ts';

// A database of its own for one copy test (npm run test:pg). The copy keeps every id, and Postgres gives ids out across
// all customers, so on the shared test database other tests' rows already hold ids 1, 2 and on: the founder's copy goes
// only into a fresh database (docs/GO-LIVE-postgres.md, part 4), and so does each test. It is created as bootstrap
// creates the real one (owned by wa_owner, the same grants), migrated by db-migrate's own code as wa_owner, and dropped
// afterwards. The roles are the shared server's; no password is made, changed or written here.

export interface FreshPg {
  /** The same four roles' URLs, on this database. */
  urls: TestPg;
  /** Drops the database (its pools must be closed first; any left over are ended). */
  drop(): Promise<void>;
}

const NAME = /^wa_test_copy_[0-9a-f]{12}$/;

/** `url` on another database of the same server. */
function on(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.href;
}

function serverUrl(): string {
  const url = process.env.TEST_PG_SERVER_URL;
  if (!url) throw new Error('the copy tests need TEST_PG_SERVER_URL (the test server\'s admin, set by npm run test:pg)');
  return url;
}

export async function freshPg(): Promise<FreshPg> {
  const t = testPg();
  if (!t) throw new Error('this test needs the Postgres test server: run npm run test:pg');
  const name = `wa_test_copy_${randomBytes(6).toString('hex')}`;
  const server = await openAdminConnection(on(serverUrl(), 'postgres'));
  try {
    await server.sql(`CREATE DATABASE ${name} OWNER wa_owner ENCODING 'UTF8' TEMPLATE template0`);
  } finally {
    await server.end();
  }
  const drop = async () => {
    if (!NAME.test(name)) throw new Error('not a copy test database');
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
  return { urls, drop };
}
