import { ensurePlatformSchema } from '../../src/platform/schema.ts';
import { openDb, type Db } from '../../src/store/db.ts';
import { SqliteDb } from '../../src/store/engine/sqlite.ts';
import { onSqlite } from './db.ts';
import { freshPg } from './freshPg.ts';

// The platform tables for one test, where the app keeps them:
// - on SQLite, a new in-memory store with them (ensurePlatformSchema), and nothing else in tenants;
// - on Postgres, the platform Db of a database of the test's own (freshPg), as P1 to P4 made it: its tenants table holds
//   only the founder's row (P1 seeds it), so a test that counts every customer sees its own only.
// `tracker`: the store also holds a customer's own tables (SQLite: the tracker's, in the same store; Postgres: that
// customer's Db, through customerDb).

export interface PlatformTestDb {
  /** The platform tables. */
  db: Db;
  /** A customer's own tables (SQLite: the same store, opened with `tracker`). */
  customerDb(tenantId: string): Db;
  /** Closes the store (SQLite) or drops the database (Postgres). */
  close(): Promise<void>;
}

export async function platformTestDb(o: { tracker?: boolean } = {}): Promise<PlatformTestDb> {
  if (onSqlite) {
    const db: Db = o.tracker ? openDb(':memory:') : SqliteDb.open(':memory:');
    await ensurePlatformSchema(db);
    return { db, customerDb: () => db, close: () => db.close() };
  }
  const f = await freshPg();
  return { db: f.platformDb(), customerDb: (id) => f.tenantDb(id), close: () => f.drop() };
}
