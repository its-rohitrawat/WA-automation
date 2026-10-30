import type { ClientConfig } from '../../src/config/groups.ts';
import { syncClients } from '../../src/store/clients.ts';
import { openDb, type Db } from '../../src/store/db.ts';

const PHASES = ['Discovery', 'Design', 'Development', 'Review', 'Launch'];

export const SHARMA: ClientConfig = { groupId: '120363000000000001@g.us', name: 'Sharma Interiors', code: 'SHA', phases: PHASES, emailDomains: [], meetingKeywords: [] };
export const MEHTA: ClientConfig = { groupId: '120363000000000002@g.us', name: 'Mehta Foods', code: 'MEH', phases: PHASES, emailDomains: [], meetingKeywords: [] };
export const OTHER_GROUP = '120363999999999999@g.us';
export const NOW = '2026-10-19T08:00:00.000Z';
export const LATER = '2026-10-19T09:00:00.000Z';

// The engine the suite runs on (SaaS S2.7 step 2): SQLite in memory by default (npm test), or Postgres when
// npm run test:pg sets TEST_DB_ENGINE (tests/helpers/pg.ts has its server). A test of SQLite itself (its file, its
// pragmas, its migrations) runs only on SQLite: describe.runIf(onSqlite), with a one-line reason.
export const testEngine: 'sqlite' | 'postgres' = process.env.TEST_DB_ENGINE === 'postgres' ? 'postgres' : 'sqlite';
export const onSqlite = testEngine === 'sqlite';

/**
 * An empty store on the test engine: SQLite in memory, or a new customer on the Postgres test server (its own rows
 * under RLS; closing the Db ends its pool). The Postgres helper is loaded only on Postgres.
 */
export async function testDb(): Promise<Db> {
  if (onSqlite) return openDb(':memory:');
  const { openTestTenantDb } = await import('./pg.ts');
  return openTestTenantDb();
}

/**
 * A store with Sharma and Mehta. On SQLite their ids are 1 and 2. On Postgres the ids come from one identity sequence
 * shared by every customer, so they are not: read them back (getClientByCode) rather than assume them.
 */
export async function seededDb(): Promise<Db> {
  const db = await testDb();
  await syncClients(db, [SHARMA, MEHTA]);
  return db;
}
