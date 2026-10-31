import { randomUUID } from 'node:crypto';
import { openPgPool, PgPlatformDb, PgTenantDb, type PgPool } from '../../src/store/engine/pg.ts';

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

// One small pool per role for each test file (the first test:pg run: a pool per test ran the server out of its
// connections). Each test still gets its own customer, so RLS keeps every test's rows apart. The setup file
// (tests/setup/pgPools.ts) ends the pools after the file. A Db handed out here never ends its pool: closing it is free.
const pools: { app?: PgPool; owner?: PgPool; platform?: PgPool } = {};
const pool = (role: keyof typeof pools, url: (t: TestPg) => string): PgPool => (pools[role] ??= openPgPool(url(requireTestPg()), { max: 2 }));
/** The pool behind a Db that must not end it (PgPlatformDb ends its pool on close). */
const borrowed = (p: PgPool): PgPool => ({ connect: () => p.connect(), end: async () => {} });

/** Ends this file's pools (the setup file, after each test file). Nothing to do on SQLite. */
export async function closeTestPools(): Promise<void> {
  const open = Object.values(pools);
  for (const k of Object.keys(pools) as (keyof typeof pools)[]) delete pools[k];
  await Promise.all(open.map((p) => p!.end().catch(() => undefined)));
}

/** A new customer on the test server and its Db as wa_app, on this file's pool. Each call is another customer. */
export async function openTestTenantDb(name = 'test'): Promise<PgTenantDb> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const c = await pool('owner', (t) => t.ownerUrl).connect();
  try {
    await c.query("INSERT INTO tenants (id, name, status, created_at, updated_at) VALUES ($1, $2, 'active', $3, $3)", [id, name, now]);
  } finally {
    c.release();
  }
  return new PgTenantDb(pool('app', (t) => t.appUrl), id, { ownsPool: false });
}

/** The platform tables as wa_platform, on this file's pool. */
export function openTestPlatformDb(): PgPlatformDb {
  return new PgPlatformDb(borrowed(pool('platform', (t) => t.platformUrl)));
}
