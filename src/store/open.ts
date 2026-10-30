import type { Env } from '../config/env.ts';
import { trackerDbPath } from '../config/paths.ts';
import { openDb, type Db } from './db.ts';
import { openPgPool, PgPlatformDb, PgTenantDb, type PgPool } from './engine/pg.ts';

/**
 * Each customer's own Db on the tracker's pool (Postgres: wa_app, RLS by customer), for writes into a customer's tables made
 * outside its runtime (the sign-in's audit row, S4.8). SQLite: undefined (one customer, the founder).
 */
export function customerDbsOf(tracker: Db): ((tenantId: string) => Db) | undefined {
  return tracker instanceof PgTenantDb ? (tenantId) => tracker.forTenant(tenantId) : undefined;
}
import { PG_LATEST } from './pg/migrations.ts';

// The engine switch (SaaS S2, plan 4.7): DB_ENGINE=sqlite (the default) keeps data/tracker.db as before;
// DB_ENGINE=postgres reaches the server on this machine as wa_app, one customer per Db. In S2 there is one customer,
// so one Db goes everywhere it goes today; S4 makes one per customer runtime.

export interface StoreOptions {
  /** Told when a pooled Postgres connection fails while idle (the server restarted). Never given a URL. */
  onPoolError?: (err: Error) => void;
  /** Tests: a pool in place of one opened from the URL. */
  pool?: PgPool;
}

/** The customer's database. On Postgres, refused unless its schema is at the version this code needs. */
export async function openStore(env: Pick<Env, 'DATA_DIR' | 'DB_ENGINE' | 'DATABASE_URL' | 'TENANT_ID'>, o: StoreOptions = {}): Promise<Db> {
  // Only an explicit postgres leaves SQLite (an env built by hand in a test may not name the engine).
  if (env.DB_ENGINE !== 'postgres') return openDb(trackerDbPath(env.DATA_DIR));
  const pool = o.pool ?? openPgPool(env.DATABASE_URL!, { ...(o.onPoolError ? { onError: o.onPoolError } : {}) });
  const db = new PgTenantDb(pool, env.TENANT_ID);
  try {
    const v = (await db.get<{ v: number | null }>('SELECT wa_schema_version() AS v'))?.v ?? 0;
    if (v !== PG_LATEST) throw new Error(`Postgres is at P${v}, this version needs P${PG_LATEST}: run npm run cli -- db-migrate`);
  } catch (e) {
    await pool.end().catch(() => undefined);
    throw e;
  }
  return db;
}

/**
 * One line naming the database the agent uses (npm run cli -- status): the SQLite file, or the Postgres host, port,
 * database and role. Never the password or the full URL.
 */
export function databaseLine(env: Pick<Env, 'DATA_DIR' | 'DB_ENGINE' | 'DATABASE_URL'>): string {
  if (env.DB_ENGINE !== 'postgres' || !env.DATABASE_URL) return `Database: SQLite (${trackerDbPath(env.DATA_DIR)})`;
  const u = new URL(env.DATABASE_URL);
  return `Database: Postgres (${u.hostname}:${u.port || '5432'}${decodeURIComponent(u.pathname)} as ${decodeURIComponent(u.username)})`;
}

/**
 * The platform tables' database (decision D1). On SQLite they live in tracker.db, so it is the tracker Db itself; on
 * Postgres, wa_platform's own pool. Only src/main.ts calls this, and its Db reaches only src/platform/**,
 * src/web/routes/platform.ts and SessionStore (S2.8).
 */
export function openPlatformStore(env: Pick<Env, 'DB_ENGINE' | 'DATABASE_PLATFORM_URL'>, tracker: Db, o: StoreOptions = {}): Db {
  if (env.DB_ENGINE !== 'postgres') return tracker;
  return new PgPlatformDb(o.pool ?? openPgPool(env.DATABASE_PLATFORM_URL!, { max: 4, ...(o.onPoolError ? { onError: o.onPoolError } : {}) }));
}
