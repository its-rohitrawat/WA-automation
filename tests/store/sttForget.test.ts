import { describe, expect, it } from 'vitest';
import { addSttForget, insertFound, pendingSttForgets } from '../../src/store/meetings.ts';
import { seeded } from '../helpers/db.ts';
import { queuedMeeting } from '../helpers/meetingPipeline.ts';

const NOW = '2026-11-01T12:00:00.000Z';

describe('addSttForget', () => {
  it('stores a copy to delete once, even when added twice', async () => {
    const { db, ids } = await seeded();
    const id = (await insertFound(db, queuedMeeting({ clientId: ids.sharma })))!;
    await addSttForget(db, { meetingId: id, provider: 'elevenlabs', ref: 'tr-1', at: NOW });
    await addSttForget(db, { meetingId: id, provider: 'elevenlabs', ref: 'tr-1', at: NOW });
    expect(await pendingSttForgets(db, { nowIso: NOW, maxAttempts: 5 })).toHaveLength(1);
  });

  it('throws for a ref the table refuses instead of dropping it silently', async () => {
    const { db, ids } = await seeded();
    const id = (await insertFound(db, queuedMeeting({ clientId: ids.sharma })))!;
    await expect(addSttForget(db, { meetingId: id, provider: 'elevenlabs', ref: '', at: NOW })).rejects.toThrow();
    await expect(addSttForget(db, { meetingId: id, provider: 'elevenlabs', ref: 'x'.repeat(201), at: NOW })).rejects.toThrow();
    expect(await pendingSttForgets(db, { nowIso: NOW, maxAttempts: 5 })).toHaveLength(0);
  });
});

describe('pendingSttForgets', () => {
  it('lists every meeting’s copies, or one meeting’s only (the filter is added only when given: S2.5)', async () => {
    const { db, ids } = await seeded();
    const a = (await insertFound(db, queuedMeeting({ clientId: ids.sharma, driveFileId: 'file-a' })))!;
    const b = (await insertFound(db, queuedMeeting({ clientId: ids.sharma, driveFileId: 'file-b' })))!;
    await addSttForget(db, { meetingId: a, provider: 'elevenlabs', ref: 'tr-a', at: NOW });
    await addSttForget(db, { meetingId: b, provider: 'elevenlabs', ref: 'tr-b', at: NOW });
    expect((await pendingSttForgets(db, { nowIso: NOW, maxAttempts: 5 })).map((f) => f.ref)).toEqual(['tr-a', 'tr-b']);
    expect((await pendingSttForgets(db, { nowIso: NOW, maxAttempts: 5, meetingId: b })).map((f) => f.ref)).toEqual(['tr-b']);
    expect(await pendingSttForgets(db, { nowIso: NOW, maxAttempts: 5, meetingId: b + 100 })).toEqual([]);
  });
});
