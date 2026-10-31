import { afterAll, beforeAll } from 'vitest';
import { ensurePlatformSchema } from '../../src/platform/schema.ts';
import { openDb, type Db } from '../../src/store/db.ts';
import { SqliteDb } from '../../src/store/engine/sqlite.ts';
import { onSqlite } from './db.ts';
import { freshPg, type FreshPg } from './freshPg.ts';

// The platform tables for one test, where the app keeps them:
// - on SQLite, a new in-memory store with them (ensurePlatformSchema), and nothing else in tenants;
// - on Postgres, the platform Db of a database of this test FILE's own (freshPg, made once per file: making one per test
//   ran the server's database creation into the hook limits), set back before each test to what P1 to P4 left: the
//   platform rows are deleted, and the earlier tests' customers are marked removed (their own tables still point at
//   them), which the Supervisor and every customer list skip, as for a real removed customer. So a test that counts
//   every customer sees its own only, and the founder's row is the one P1 seeded.
// `tracker`: the store also holds a customer's own tables (SQLite: the tracker's, in the same store; Postgres: that
// customer's Db, through customerDb).

export interface PlatformTestDb {
  /** The platform tables. */
  db: Db;
  /** A customer's own tables (SQLite: the same store, opened with `tracker`). */
  customerDb(tenantId: string): Db;
  /** Closes the store (SQLite); on Postgres the file's database stays for the next test, and is dropped after the file. */
  close(): Promise<void>;
}

/** This file's database on Postgres: made before its first test (a creation can wait behind other files'), dropped after its last. */
let fileDb: FreshPg | undefined;
if (!onSqlite) {
  beforeAll(async () => {
    fileDb = await freshPg();
  }, 60_000);
  afterAll(async () => {
    await fileDb?.drop();
    fileDb = undefined;
  }, 60_000);
}

/** The platform rows a test leaves, deleted in an order their references allow; the customers marked removed. */
const RESET = [
  'DELETE FROM web_sessions',
  'DELETE FROM memberships',
  'DELETE FROM invites',
  'DELETE FROM platform_audit',
  'DELETE FROM tenant_keys',
  'DELETE FROM users',
  "UPDATE tenants SET status = 'removed' WHERE kind <> 'founder' AND status <> 'removed'",
  "UPDATE tenants SET status = 'active' WHERE kind = 'founder'",
];

export async function platformTestDb(o: { tracker?: boolean } = {}): Promise<PlatformTestDb> {
  if (onSqlite) {
    const db: Db = o.tracker ? openDb(':memory:') : SqliteDb.open(':memory:');
    await ensurePlatformSchema(db);
    return { db, customerDb: () => db, close: () => db.close() };
  }
  const f = fileDb;
  if (!f) throw new Error("platformTestDb: this file's Postgres database is not made (import this helper at the top of the test file)");
  const db = f.platformDb();
  await db.tx(async (q) => {
    for (const sql of RESET) await q.run(sql);
  });
  return { db, customerDb: (id) => f.tenantDb(id), close: async () => {} };
}
