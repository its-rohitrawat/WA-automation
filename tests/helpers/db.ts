import type { ClientConfig } from '../../src/config/groups.ts';
import { syncClients } from '../../src/store/clients.ts';
import { openDb, type Db } from '../../src/store/db.ts';

const PHASES = ['Discovery', 'Design', 'Development', 'Review', 'Launch'];

export const SHARMA: ClientConfig = { groupId: '120363000000000001@g.us', name: 'Sharma Interiors', code: 'SHA', phases: PHASES, emailDomains: [], meetingKeywords: [] };
export const MEHTA: ClientConfig = { groupId: '120363000000000002@g.us', name: 'Mehta Foods', code: 'MEH', phases: PHASES, emailDomains: [], meetingKeywords: [] };
export const OTHER_GROUP = '120363999999999999@g.us';
export const NOW = '2026-10-19T08:00:00.000Z';
export const LATER = '2026-10-19T09:00:00.000Z';

/** In-memory DB with Sharma (id 1) and Mehta (id 2). */
export async function seededDb(): Promise<Db> {
  const db = openDb(':memory:');
  syncClients(db, [SHARMA, MEHTA]);
  return db;
}
