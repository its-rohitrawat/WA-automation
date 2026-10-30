import { randomUUID } from 'node:crypto';
import { openAdminConnection, openPgPool, PgPlatformDb, PgTenantDb } from '../../src/store/engine/pg.ts';

// The Postgres test server (S2.7), when scripts/test-pg.ts started one. Its URLs come only from the TEST_ variables
// that script sets for vitest, with passwords made at run time: never in .env, a file, a log or a commit. Without them
// (plain npm test), every Postgres-only test is skipped.

export interface TestPg {
  /** wa_app: the customer tables, under RLS. */
  appUrl: string;
  /** wa_owner: owns the schema; inserts each test's customer. */
  ownerUrl: string;
  /** wa_platform: the platform tables only. */
  platformUrl: string;
  /** wa_backup: reads everything, writes nothing (S2.9). */
  backupUrl: string;
}

export function testPg(): TestPg | undefined {
  const e = process.env;
  if (e.TEST_DB_ENGINE !== 'postgres') return undefined;
  const { TEST_PG_APP_URL: appUrl, TEST_PG_OWNER_URL: ownerUrl, TEST_PG_PLATFORM_URL: platformUrl, TEST_PG_BACKUP_URL: backupUrl } = e;
  if (!appUrl || !ownerUrl || !platformUrl || !backupUrl) throw new Error('TEST_DB_ENGINE=postgres needs the TEST_PG_ URLs: run npm run test:pg');
  return { appUrl, ownerUrl, platformUrl, backupUrl };
}

/** For describe.runIf: true only inside npm run test:pg. */
export const onPg = testPg() !== undefined;

function requireTestPg(): TestPg {
  const t = testPg();
  if (!t) throw new Error('this test needs the Postgres test server: run npm run test:pg');
  return t;
}

/**
 * A new customer on the test server and its Db as wa_app, on a small pool of its own (closing the Db ends it). Each
 * call is another customer, so RLS keeps every test's rows apart.
 */
export async function openTestTenantDb(name = 'test'): Promise<PgTenantDb> {
  const t = requireTestPg();
  const id = randomUUID();
  const now = new Date().toISOString();
  const owner = await openAdminConnection(t.ownerUrl);
  try {
    await owner.sql("INSERT INTO tenants (id, name, status, created_at, updated_at) VALUES ($1, $2, 'active', $3, $3)", [id, name, now]);
  } finally {
    await owner.end();
  }
  return new PgTenantDb(openPgPool(t.appUrl, { max: 2 }), id);
}

/** The platform tables as wa_platform, on a small pool of its own. */
export function openTestPlatformDb(): PgPlatformDb {
  return new PgPlatformDb(openPgPool(requireTestPg().platformUrl, { max: 2 }));
}
