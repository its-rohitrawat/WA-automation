import { describe, expect, it } from 'vitest';
import { setKv } from '../../src/store/kv.ts';
import { listBackfills, queueBackfill } from '../../src/store/historyBackfill.ts';
import { MEHTA, seeded, SHARMA } from '../helpers/db.ts';

describe('listBackfills', () => {
  // Bug 7: a text range (k >= 'history_backfill:' AND k < 'history_backfill;') depends on the database's collation. Under a
  // locale collation Postgres ignores punctuation at first, so the range can miss every entry, or take a key it should not.
  it('lists exactly the backfill entries, whatever the database collation', async () => {
    const { db, ids } = await seeded();
    const now = new Date('2026-10-28T06:00:00.000Z');
    await queueBackfill(db, SHARMA.groupId, ids.sharma, now);
    await queueBackfill(db, MEHTA.groupId, ids.mehta, now);
    // Near misses holding a valid entry: listed by a looser match, they would show up as backfills.
    const entry = JSON.stringify({ clientId: ids.sharma, since: '2026-10-21T06:00:00.000Z', until: now.toISOString(), state: 'waiting' });
    for (const k of ['history_backfill', 'history_backfill;x@g.us', 'history-backfill:x@g.us', 'historyXbackfill:x@g.us', 'HISTORY_BACKFILL:x@g.us', 'history_backfil:x@g.us']) {
      await setKv(db, k, entry);
    }
    const listed = await listBackfills(db);
    expect(listed.map((b) => b.groupId).sort()).toEqual([SHARMA.groupId, MEHTA.groupId].sort());
    expect(listed.find((b) => b.groupId === MEHTA.groupId)).toMatchObject({ clientId: ids.mehta, state: 'waiting' });
  });
});
