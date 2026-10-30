import type { Env } from '../config/env.ts';
import { trackerDbPath } from '../config/paths.ts';
import { openDb, type Db } from './db.ts';
import { openPgPool, PgPlatformDb, PgTenantDb, type PgPool } from './engine/pg.ts';
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

/** The start-up warning for the engine, if any. Until S2.6c2 (wa_auth), Postgres keeps the WhatsApp sessions in files. */
export function storeWarning(env: Env): string | undefined {
  if (env.DB_ENGINE !== 'postgres') return undefined;
  return 'DB_ENGINE=postgres: the tracker is on Postgres, but the WhatsApp sessions are still in data/session.db and data/sender-session.db until wa_auth (S2.6c2)';
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
