import { sessionDbPath, trackerDbPath } from '../../src/config/paths.ts';
import { openDb, type Db } from '../../src/store/db.ts';
import { openPhoneSession, openSessionDb, sessionHomeOf, type Phone, type SessionHome } from '../../src/wa/authState.ts';
import { onSqlite, testDb } from './db.ts';

// The CLI's store in a test (S2.7). The commands open the store themselves from env (openStore), so a test seeds and
// reads the same store they reach. SQLite: the data folder's tracker.db and session files. Postgres: the test's own
// customer on the test server: DB_ENGINE, the test server's URLs (tests/helpers/pg.ts, made at run time) and that
// customer's TENANT_ID, as fe's tests/cli/meetings.test.ts sets them. No URL is ever printed: env goes to parseEnv only.

export interface CliStore {
  /** Extra settings for parseEnv: none on SQLite; the Postgres engine, URLs and customer on Postgres. */
  env: Record<string, string>;
  /** The store as the test reads and writes it. Close it when done (on Postgres that leaves the shared pool open). */
  open(): Promise<Db>;
  /** Where the commands keep the phones' sessions: the data folder's files, or the customer's wa_auth rows. */
  sessions(db: Db): SessionHome;
  /** A phone's session as the commands open it. */
  openSession(db: Db, phone: Phone): Promise<Db>;
  /** How many live session rows a phone has (the session file's auth table, or its wa_auth 'live' rows). */
  sessionRows(phone: Phone): Promise<number>;
}

export async function cliStore(dataDir: string): Promise<CliStore> {
  const pg = onSqlite ? undefined : await postgresEnv();
  const env = { DATA_DIR: dataDir, ...pg?.env };
  const open = pg ? async () => pg.db : async () => openDb(trackerDbPath(dataDir));
  const sessions = (db: Db) => sessionHomeOf(env, db);
  return {
    env: pg?.env ?? {},
    open,
    sessions,
    openSession: (db, phone) => openPhoneSession(sessions(db), phone),
    async sessionRows(phone) {
      if (onSqlite) {
        if (phone !== 'founder') throw new Error('the spare phone has its own file: count it there');
        const file = openSessionDb(sessionDbPath(dataDir));
        try {
          return (await file.get<{ n: number }>('SELECT COUNT(*) AS n FROM auth'))!.n;
        } finally {
          await file.close();
        }
      }
      const db = await open();
      return (await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM wa_auth WHERE phone = ? AND slot = 'live'", [phone]))!.n;
    },
  };
}

/** The Postgres settings for the test's own customer, and its Db. */
async function postgresEnv(): Promise<{ env: Record<string, string>; db: Db }> {
  const db = await testDb();
  const { testPg } = await import('./pg.ts');
  const pg = testPg()!;
  return { db, env: { DB_ENGINE: 'postgres', DATABASE_URL: pg.appUrl, DATABASE_PLATFORM_URL: pg.platformUrl, TENANT_ID: (db as Db & { tenantId: string }).tenantId } };
}
