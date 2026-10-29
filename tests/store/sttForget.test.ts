import { describe, expect, it } from 'vitest';
import { addSttForget, insertFound, pendingSttForgets } from '../../src/store/meetings.ts';
import { seededDb } from '../helpers/db.ts';
import { queuedMeeting } from '../helpers/meetingPipeline.ts';

const NOW = '2026-11-01T12:00:00.000Z';

describe('addSttForget', () => {
  it('stores a copy to delete once, even when added twice', async () => {
    const db = await seededDb();
    const id = (await insertFound(db, queuedMeeting()))!;
    await addSttForget(db, { meetingId: id, provider: 'elevenlabs', ref: 'tr-1', at: NOW });
    await addSttForget(db, { meetingId: id, provider: 'elevenlabs', ref: 'tr-1', at: NOW });
    expect(await pendingSttForgets(db, { nowIso: NOW, maxAttempts: 5 })).toHaveLength(1);
  });

  it('throws for a ref the table refuses instead of dropping it silently', async () => {
    const db = await seededDb();
    const id = (await insertFound(db, queuedMeeting()))!;
    await expect(addSttForget(db, { meetingId: id, provider: 'elevenlabs', ref: '', at: NOW })).rejects.toThrow();
    await expect(addSttForget(db, { meetingId: id, provider: 'elevenlabs', ref: 'x'.repeat(201), at: NOW })).rejects.toThrow();
    expect(await pendingSttForgets(db, { nowIso: NOW, maxAttempts: 5 })).toHaveLength(0);
  });
});
