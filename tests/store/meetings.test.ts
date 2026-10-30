import { SqliteDb, rawOf } from '../../src/store/engine/sqlite.ts';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { MeetingSummary } from '../../src/brain/meetingSchema.ts';
import { migrate, type Db } from '../../src/store/db.ts';
import {
  advanceStage, assignMeeting, claimMeeting, deferMeeting, dueMeetingIds, failMeeting, finishMeeting, FOUND_INTERNAL_NOTE, getMeeting, getMeetingState,
  insertFound, knownRecordings, lastMeetingByClient, listClientMeetings, listMeetingsByStatus, listUnassigned, meetingStats, refreshMeetingFacts, retryMeeting, setSttParts, skipMeeting,
  type MeetingStatus, type NewMeeting, type SttPartRow,
} from '../../src/store/meetings.ts';
import { MIGRATIONS } from '../../src/store/migrations.ts';
import { LATER, NOW, seededDb } from '../helpers/db.ts';

const CONF = 'conferenceRecords/c1';
const LATEST = '2026-10-19T10:00:00.000Z';

let seq = 0;
const meeting = (o: Partial<NewMeeting> = {}): NewMeeting => ({
  recording: `${CONF}/recordings/r${++seq}`,
  conference: CONF,
  driveFileId: `file${seq}`,
  meetingCode: 'abc-defg-hij',
  title: 'Sharma weekly',
  startedAt: '2026-10-18T10:00:00.000Z',
  endedAt: '2026-10-18T10:45:00.000Z',
  attendees: [{ email: 'a@sharma.example', name: 'Mr. Sharma', team: false }],
  participants: ['Mr. Sharma'],
  clientId: 1,
  matchKind: 'title',
  status: 'queued',
  driveSeconds: 2700,
  createdAt: NOW,
  ...o,
});

/** Unassigned and internal meetings have no client; internal ones also keep no title, attendees or names. */
const noClient = (status: 'unassigned' | 'internal' | 'skipped'): Partial<NewMeeting> =>
  status === 'internal'
    ? { status, clientId: null, matchKind: null, title: '', attendees: [], participants: [] }
    : { status, clientId: null, matchKind: null };

const summary = (actions: number): MeetingSummary => ({
  whatHappened: 'We met.',
  discussion: [],
  decisions: [],
  actionItems: Array.from({ length: actions }, (_, i) => ({ side: 'us' as const, task: `Task ${i}`, owner: null, deadline: null, segmentIds: ['s1'] })),
  openQuestions: [],
  conclusion: '',
  speakers: [],
});

const part = (index: number, o: Partial<SttPartRow> = {}): SttPartRow => ({
  index, provider: 'elevenlabs', file: null, offset: index * 600, seconds: 600, state: 'todo', jobId: null, booked: 'none', segments: null, billedSeconds: null, ...o,
});

async function withStatus(db: Db, status: MeetingStatus, o: Partial<NewMeeting> = {}): Promise<number> {
  const base = status === 'unassigned' || status === 'internal' || status === 'skipped' ? noClient(status) : { status };
  return (await insertFound(db, meeting({ ...base, ...o })))!;
}

/** A queued meeting taken to stage doc and finished, as the processor would. */
async function doneMeeting(db: Db, o: Partial<NewMeeting> = {}, fields: Parameters<typeof advanceStage>[3] = {}): Promise<number> {
  const id = await withStatus(db, 'queued', o);
  await advanceStage(db, id, 'doc', fields, NOW);
  await finishMeeting(db, id, { at: NOW });
  return id;
}

describe('meetings store', () => {
  it('records a recording once; the second insert returns null', async () => {
    const db = await seededDb();
    const m = meeting();
    const id = await insertFound(db, m);
    expect(id).toBeTypeOf('number');
    expect(await insertFound(db, { ...m, title: 'Other' })).toBeNull();
    expect((rawOf(db).prepare('SELECT COUNT(*) AS n FROM meetings').get() as { n: number }).n).toBe(1);
    expect(await getMeeting(db, id!)).toMatchObject({
      id, recording: m.recording, conference: CONF, driveFileId: m.driveFileId, meetingCode: 'abc-defg-hij', title: 'Sharma weekly',
      startedAt: m.startedAt, endedAt: m.endedAt, attendees: m.attendees, participants: ['Mr. Sharma'], clientId: 1, matchKind: 'title',
      status: 'queued', stage: 'found', driveSeconds: 2700, audioPath: null, audioSeconds: null, sttParts: [], transcript: null, summary: null,
      docFileId: null, note: null, errorCode: null, attempts: 0, nextAttemptAt: null, createdAt: NOW, updatedAt: NOW,
    });
    expect(await getMeeting(db, 999)).toBeUndefined();
  });

  it('stores an error code given at insert', async () => {
    const db = await seededDb();
    const id = (await insertFound(db, meeting({ status: 'no_access', errorCode: 'http_404' })))!;
    expect(await getMeeting(db, id)).toMatchObject({ status: 'no_access', errorCode: 'http_404' });
  });

  it('lists the recordings known for a conference', async () => {
    const db = await seededDb();
    const a = meeting();
    const b = meeting();
    await insertFound(db, a);
    await insertFound(db, b);
    await insertFound(db, meeting({ conference: 'conferenceRecords/c2', recording: 'conferenceRecords/c2/recordings/x' }));
    expect(await knownRecordings(db, CONF)).toEqual(new Set([a.recording, b.recording]));
    expect(await knownRecordings(db, 'conferenceRecords/none')).toEqual(new Set());
  });

  it('gives due queued meetings oldest first; deferred ones wait for their time; other statuses never', async () => {
    const db = await seededDb();
    const late = await withStatus(db, 'queued', { startedAt: '2026-10-18T12:00:00.000Z' });
    const early = await withStatus(db, 'queued', { startedAt: '2026-10-17T12:00:00.000Z' });
    const deferred = await withStatus(db, 'queued', { startedAt: '2026-10-16T12:00:00.000Z' });
    await withStatus(db, 'unassigned', { startedAt: '2026-10-15T12:00:00.000Z' });
    await withStatus(db, 'failed', { startedAt: '2026-10-15T12:00:00.000Z' });
    await deferMeeting(db, deferred, { errorCode: 'spend_cap', nextAttemptAt: LATER, at: NOW });
    expect(await dueMeetingIds(db, NOW, 10)).toEqual([early, late]);
    expect(await dueMeetingIds(db, NOW, 1)).toEqual([early]);
    expect(await dueMeetingIds(db, LATER, 10)).toEqual([deferred, early, late]);
  });

  it('stores Google times in canonical form, so an offset or a fraction of a second sorts by time', async () => {
    const db = await seededDb();
    // As text, each pair sorts the wrong way round: "10:00:00+05:30" after "05:00:00Z", "00.5Z" before "00Z".
    const ist = await withStatus(db, 'queued', { startedAt: '2026-10-18T10:00:00+05:30', endedAt: '2026-10-18T10:45:00+05:30' }); // 04:30Z
    const utc = await withStatus(db, 'queued', { startedAt: '2026-10-18T05:00:00Z', endedAt: null });
    const half = await withStatus(db, 'queued', { startedAt: '2026-10-18T03:00:00.5Z' });
    const whole = await withStatus(db, 'queued', { startedAt: '2026-10-18T03:00:00Z' });
    const nanos = await withStatus(db, 'queued', { startedAt: '2026-10-18T03:00:00.123456789Z' });
    expect(await getMeeting(db, ist)).toMatchObject({ startedAt: '2026-10-18T04:30:00.000Z', endedAt: '2026-10-18T05:15:00.000Z' });
    expect(await getMeeting(db, utc)).toMatchObject({ startedAt: '2026-10-18T05:00:00.000Z', endedAt: null });
    expect((await getMeeting(db, nanos))!.startedAt).toBe('2026-10-18T03:00:00.123Z');
    expect(await dueMeetingIds(db, NOW, 10)).toEqual([whole, nanos, half, ist, utc]);
    await expect(insertFound(db, meeting({ startedAt: 'yesterday' }))).rejects.toThrow(/startedAt is not a time/);
    await expect(insertFound(db, meeting({ endedAt: '' }))).rejects.toThrow(/endedAt is not a time/);
    await expect(insertFound(db, meeting({ createdAt: '2026-10-19T08:00:00Z' }))).rejects.toThrow(/createdAt is not a canonical ISO time/);
  });

  it('refuses times that are not canonical where they are compared as text', async () => {
    const db = await seededDb();
    const id = await withStatus(db, 'queued');
    await expect(claimMeeting(db, id, { nextAttemptAt: '2026-10-19T09:00:00Z', at: NOW })).rejects.toThrow(/nextAttemptAt is not a canonical ISO time/);
    await expect(claimMeeting(db, id, { nextAttemptAt: LATER, at: '2026-10-19T13:30:00+05:30' })).rejects.toThrow(/at is not a canonical ISO time/);
    await expect(deferMeeting(db, id, { errorCode: 'spend_cap', nextAttemptAt: '2026-10-19 09:00:00', at: NOW })).rejects.toThrow(/nextAttemptAt/);
    await expect(deferMeeting(db, id, { errorCode: 'spend_cap', nextAttemptAt: LATER, at: 'now' })).rejects.toThrow(/at is not a canonical/);
    await expect(dueMeetingIds(db, '2026-10-19T08:00:00Z', 10)).rejects.toThrow(/nowIso/);
    await expect(meetingStats(db, '2026-10-19T08:00Z')).rejects.toThrow(/nowIso/);
    expect(await getMeetingState(db, id)).toMatchObject({ attempts: 0, errorCode: null, nextAttemptAt: null, updatedAt: NOW });
  });

  it('claims a due meeting once, counting the attempt and clearing the error code; never one not due or not queued', async () => {
    const db = await seededDb();
    const id = await withStatus(db, 'queued');
    await deferMeeting(db, id, { errorCode: 'spend_cap', nextAttemptAt: NOW, at: NOW });
    expect(await claimMeeting(db, id, { nextAttemptAt: LATER, at: NOW })).toBe(true);
    expect(await claimMeeting(db, id, { nextAttemptAt: LATER, at: NOW })).toBe(false);
    expect(await getMeetingState(db, id)).toEqual({
      id, status: 'queued', stage: 'found', attempts: 1, errorCode: null, nextAttemptAt: LATER, clientId: 1, updatedAt: NOW,
    });
    expect(await dueMeetingIds(db, NOW, 10)).toEqual([]);
    expect(await claimMeeting(db, id, { nextAttemptAt: LATEST, at: LATER })).toBe(true);
    expect(await claimMeeting(db, await withStatus(db, 'unassigned'), { nextAttemptAt: LATER, at: NOW })).toBe(false);
    expect(await getMeetingState(db, 999)).toBeUndefined();
  });

  it('a stage that never finishes runs up the attempt count, claim after claim', async () => {
    const db = await seededDb();
    const id = await withStatus(db, 'queued');
    const FAIL_AT = 3;
    let at = Date.parse(NOW);
    for (let i = 0; i < FAIL_AT; i++) {
      // Each run claims and then stops (no defer, finish or fail); the next one starts once the claim has run out.
      expect(await claimMeeting(db, id, { nextAttemptAt: new Date(at + 15 * 60_000).toISOString(), at: new Date(at).toISOString() })).toBe(true);
      at += 16 * 60_000;
    }
    expect(await getMeetingState(db, id)).toMatchObject({ status: 'queued', attempts: FAIL_AT });
    // What the processor then does with it.
    await failMeeting(db, id, { status: 'failed', errorCode: 'crashed', at: new Date(at).toISOString() });
    expect(await getMeetingState(db, id)).toMatchObject({ status: 'failed', errorCode: 'crashed' });
  });

  it('defers counting an attempt, keeping the claim’s count, or putting the count back; fails with a final status', async () => {
    const db = await seededDb();
    const id = await withStatus(db, 'queued');
    expect(await claimMeeting(db, id, { nextAttemptAt: LATER, at: NOW })).toBe(true); // attempts 1
    await deferMeeting(db, id, { errorCode: 'google_transient', nextAttemptAt: NOW, at: NOW });
    expect(await getMeetingState(db, id)).toMatchObject({ errorCode: 'google_transient', attempts: 1 });
    await deferMeeting(db, id, { errorCode: 'google_transient', nextAttemptAt: NOW, at: NOW, countAttempt: true });
    expect(await getMeetingState(db, id)).toMatchObject({ attempts: 2 });
    expect(await claimMeeting(db, id, { nextAttemptAt: LATER, at: NOW })).toBe(true); // attempts 3
    // A spend-cap deferral doesn't count: the processor passes back the count from before its claim.
    await deferMeeting(db, id, { errorCode: 'spend_cap', nextAttemptAt: LATER, at: NOW, attempts: 2 });
    expect(await getMeeting(db, id)).toMatchObject({ status: 'queued', errorCode: 'spend_cap', attempts: 2, nextAttemptAt: LATER });
    await failMeeting(db, id, { status: 'no_access', errorCode: 'drive_404', at: LATER });
    expect(await getMeeting(db, id)).toMatchObject({ status: 'no_access', errorCode: 'drive_404', nextAttemptAt: null, updatedAt: LATER });
    expect(await getMeeting(db, id)).toMatchObject({ audioPath: null, audioSeconds: null });
  });

  it('a failure can store the audio it keeps', async () => {
    const db = await seededDb();
    const id = (await insertFound(db, meeting()))!;
    await failMeeting(db, id, { status: 'too_long', errorCode: 'too_long_measured', at: LATER, audioPath: 'meetings/SHA/2026-10/1.mp3', audioSeconds: 660 });
    expect(await getMeeting(db, id)).toMatchObject({ status: 'too_long', stage: 'found', audioPath: 'meetings/SHA/2026-10/1.mp3', audioSeconds: 660 });
  });

  it('advances the stage forward only, keeping earlier results and clearing the retry state', async () => {
    const db = await seededDb();
    const id = await withStatus(db, 'queued');
    await deferMeeting(db, id, { errorCode: 'ffmpeg', nextAttemptAt: LATER, at: NOW, countAttempt: true });
    await advanceStage(db, id, 'audio', { audioPath: 'meetings/1.mp3', audioSeconds: 2650.5 }, NOW);
    expect(await getMeeting(db, id)).toMatchObject({ stage: 'audio', audioPath: 'meetings/1.mp3', audioSeconds: 2650.5, errorCode: null, attempts: 0, nextAttemptAt: null });
    const transcript = [{ start: 0, end: 2.5, speaker: 'A', text: 'Namaste' }];
    await advanceStage(db, id, 'transcribed', { transcript }, NOW);
    await advanceStage(db, id, 'summarised', { summary: summary(2), title: 'Kickoff', attendees: [], participants: ['Rohit'] }, LATER);
    expect(await getMeeting(db, id)).toMatchObject({
      stage: 'summarised', audioPath: 'meetings/1.mp3', audioSeconds: 2650.5, transcript, summary: summary(2), title: 'Kickoff', attendees: [],
      participants: ['Rohit'], updatedAt: LATER,
    });
    await expect(advanceStage(db, id, 'summarised', {}, LATER)).rejects.toThrow(/summarised/);
    await expect(advanceStage(db, id, 'audio', { audioPath: 'other.mp3' }, LATER)).rejects.toThrow(/audio/);
    expect(await getMeeting(db, id)).toMatchObject({ stage: 'summarised', audioPath: 'meetings/1.mp3' });
    await advanceStage(db, id, 'tracked', { docFileId: 'doc1', note: 'transcript_cut' }, LATER);
    expect(await getMeeting(db, id)).toMatchObject({ stage: 'tracked', docFileId: 'doc1', note: 'transcript_cut', summary: summary(2) });
    await expect(advanceStage(db, 999, 'audio', {}, LATER)).rejects.toThrow(/999/);
  });

  it('stores only a summary of the shared shape: unknown fields fail loudly', async () => {
    const db = await seededDb();
    const id = await withStatus(db, 'queued');
    const extra = { ...summary(1), mood: 'happy' } as unknown as MeetingSummary;
    await expect(advanceStage(db, id, 'summarised', { summary: extra }, NOW)).rejects.toThrow(/summary value does not have the stored shape/);
    expect(await getMeeting(db, id)).toMatchObject({ stage: 'found', summary: null });
    rawOf(db).prepare('UPDATE meetings SET summary = ? WHERE id = ?').run(JSON.stringify(extra), id);
    await expect(getMeeting(db, id)).rejects.toThrow(new RegExp(`meeting ${id}.*summary`));
  });

  it('stores the speech parts and reads them back', async () => {
    const db = await seededDb();
    const id = await withStatus(db, 'queued');
    const parts = [
      part(0, { state: 'done', booked: 'actual', jobId: 'job-1', segments: [{ start: 0, end: 1, speaker: null, text: 'hi' }], billedSeconds: 600 }),
      part(1, { state: 'inflight', booked: 'ceiling' }),
      part(2),
    ];
    await setSttParts(db, id, parts, LATER);
    expect(await getMeeting(db, id)).toMatchObject({ sttParts: parts, updatedAt: LATER, stage: 'found' });
  });

  it('finishes a queued meeting at stage doc or later as done and tracked', async () => {
    const db = await seededDb();
    const id = await withStatus(db, 'queued');
    await expect(finishMeeting(db, id, { at: LATER })).rejects.toThrow(new RegExp(`meeting ${id} is not queued at stage doc or later`));
    await advanceStage(db, id, 'doc', { docFileId: 'doc1' }, NOW);
    await deferMeeting(db, id, { errorCode: 'client_busy', nextAttemptAt: LATER, at: NOW });
    await finishMeeting(db, id, { note: 'client_inactive', at: LATER });
    expect(await getMeeting(db, id)).toMatchObject({ status: 'done', stage: 'tracked', note: 'client_inactive', errorCode: null, nextAttemptAt: null, updatedAt: LATER });
    const other = await withStatus(db, 'queued');
    await advanceStage(db, other, 'audio', { note: 'kept' }, NOW);
    await advanceStage(db, other, 'doc', {}, NOW);
    await finishMeeting(db, other, { at: LATER });
    expect(await getMeeting(db, other)).toMatchObject({ status: 'done', stage: 'tracked', note: 'kept' });
  });

  it('processor writes throw on a meeting that is not queued, and change nothing', async () => {
    const db = await seededDb();
    const done = await doneMeeting(db);
    const un = await withStatus(db, 'unassigned');
    const before = await getMeeting(db, done);
    await expect(advanceStage(db, un, 'audio', { audioSeconds: 5 }, LATER)).rejects.toThrow(new RegExp(`advanceStage: meeting ${un} is not queued`));
    await expect(deferMeeting(db, un, { errorCode: 'spend_cap', nextAttemptAt: LATER, at: LATER })).rejects.toThrow(new RegExp(`deferMeeting: meeting ${un} is not queued`));
    await expect(deferMeeting(db, 999, { errorCode: 'spend_cap', nextAttemptAt: LATER, at: LATER })).rejects.toThrow(/meeting 999 is not queued/);
    await expect(finishMeeting(db, done, { at: LATER })).rejects.toThrow(/is not queued/);
    await expect(failMeeting(db, done, { status: 'failed', errorCode: 'x', at: LATER })).rejects.toThrow(/is not queued/);
    await expect(setSttParts(db, done, [part(0)], LATER)).rejects.toThrow(/is not queued/);
    expect(await getMeeting(db, done)).toEqual(before);
    expect(await getMeeting(db, un)).toMatchObject({ status: 'unassigned', stage: 'found', audioSeconds: null, errorCode: null, updatedAt: NOW });
  });

  it('assigns only unassigned or internal meetings', async () => {
    const db = await seededDb();
    const un = await withStatus(db, 'unassigned');
    const internal = await withStatus(db, 'internal');
    const done = await withStatus(db, 'done');
    expect(await assignMeeting(db, un, 2, LATER)).toBe(true);
    expect(await getMeeting(db, un)).toMatchObject({ status: 'queued', clientId: 2, matchKind: 'human', updatedAt: LATER });
    expect(await assignMeeting(db, internal, 1, LATER)).toBe(true);
    expect(await getMeeting(db, internal)).toMatchObject({ status: 'queued', clientId: 1, matchKind: 'human', title: '', attendees: [] });
    expect(await assignMeeting(db, done, 2, LATER)).toBe(false);
    expect(await assignMeeting(db, un, 1, LATER)).toBe(false); // now queued
    expect(await getMeeting(db, done)).toMatchObject({ status: 'done', clientId: 1, matchKind: 'title' });
  });

  it('skips only unassigned meetings', async () => {
    const db = await seededDb();
    const un = await withStatus(db, 'unassigned');
    const queued = await withStatus(db, 'queued');
    expect(await skipMeeting(db, queued, LATER)).toBe(false);
    expect(await skipMeeting(db, un, LATER)).toBe(true);
    expect(await getMeeting(db, un)).toMatchObject({ status: 'skipped', updatedAt: LATER });
    expect(await getMeeting(db, queued)).toMatchObject({ status: 'queued' });
  });

  it('retries only failed or no-access meetings, at their last finished stage', async () => {
    const db = await seededDb();
    const failed = await withStatus(db, 'queued');
    await advanceStage(db, failed, 'transcribed', { transcript: [] }, NOW);
    await deferMeeting(db, failed, { errorCode: 'claude_5xx', nextAttemptAt: LATER, at: NOW, countAttempt: true });
    await failMeeting(db, failed, { status: 'failed', errorCode: 'claude_5xx', at: NOW });
    const noAccess = await withStatus(db, 'no_access');
    const tooLong = await withStatus(db, 'too_long');
    const queued = await withStatus(db, 'queued');
    expect(await retryMeeting(db, failed, LATER)).toBe('queued');
    expect(await getMeeting(db, failed)).toMatchObject({ status: 'queued', stage: 'transcribed', attempts: 0, nextAttemptAt: null, errorCode: null, updatedAt: LATER });
    expect(await retryMeeting(db, noAccess, LATER)).toBe('queued');
    expect(await retryMeeting(db, tooLong, LATER)).toBeNull();
    expect(await retryMeeting(db, queued, LATER)).toBeNull();
    expect(await getMeeting(db, tooLong)).toMatchObject({ status: 'too_long' });
  });

  it('retry puts a no-access or failed meeting without a client back to unassigned, never queued', async () => {
    const db = await seededDb();
    const internal = await withStatus(db, 'no_access', {
      clientId: null, matchKind: null, title: '', attendees: [], participants: [], errorCode: 'http_404', foundInternal: true,
    });
    const un = await withStatus(db, 'no_access', { clientId: null, matchKind: null, errorCode: 'http_403' });
    const failed = await withStatus(db, 'failed', { clientId: null, matchKind: null, errorCode: 'no_client' });
    expect((await getMeeting(db, internal))!.note).toBe(FOUND_INTERNAL_NOTE);
    for (const id of [internal, un, failed]) {
      expect(await retryMeeting(db, id, LATER)).toBe('unassigned');
      expect(await getMeeting(db, id)).toMatchObject({ status: 'unassigned', clientId: null, attempts: 0, errorCode: null, nextAttemptAt: null, updatedAt: LATER });
    }
    expect(await getMeeting(db, internal)).toMatchObject({ note: null, title: '', attendees: [] });
    expect(await retryMeeting(db, un, LATER)).toBeNull(); // now unassigned
  });

  it('assigns a no-access meeting only when it has no client, clearing the found-internal note', async () => {
    const db = await seededDb();
    const internal = await withStatus(db, 'no_access', {
      clientId: null, matchKind: null, title: '', attendees: [], participants: [], errorCode: 'http_404', foundInternal: true,
    });
    const withClient = await withStatus(db, 'no_access', { errorCode: 'http_404' });
    expect(await assignMeeting(db, withClient, 2, LATER)).toBe(false);
    expect(await assignMeeting(db, internal, 2, LATER)).toBe(true);
    expect(await getMeeting(db, internal)).toMatchObject({ status: 'queued', clientId: 2, matchKind: 'human', errorCode: null, attempts: 0, note: null });
    expect(await getMeeting(db, withClient)).toMatchObject({ status: 'no_access', clientId: 1 });
  });

  it('lists a no-access meeting found as internal with foundInternal', async () => {
    const db = await seededDb();
    const internal = await withStatus(db, 'no_access', {
      clientId: null, matchKind: null, title: '', attendees: [], participants: [], errorCode: 'http_404', foundInternal: true,
    });
    const other = await withStatus(db, 'no_access', { errorCode: 'http_404' });
    const rows = await listMeetingsByStatus(db, ['no_access']);
    expect(rows.find((r) => r.id === internal)).toMatchObject({ foundInternal: true, title: '' });
    expect(rows.find((r) => r.id === other)).toMatchObject({ foundInternal: false });
  });

  it('lists unassigned meetings newest first, with no title or attendees', async () => {
    const db = await seededDb();
    const old = await withStatus(db, 'unassigned', { startedAt: '2026-10-10T10:00:00.000Z', driveSeconds: 100 });
    const recent = await withStatus(db, 'unassigned', { startedAt: '2026-10-12T10:00:00.000Z', driveSeconds: null });
    await withStatus(db, 'internal');
    rawOf(db).prepare('UPDATE meetings SET audio_seconds = 95.5 WHERE id = ?').run(old); // the audio's length wins over Drive's
    const rows = await listUnassigned(db, 10);
    expect(rows).toEqual([
      { id: recent, startedAt: '2026-10-12T10:00:00.000Z', seconds: null },
      { id: old, startedAt: '2026-10-10T10:00:00.000Z', seconds: 95.5 },
    ]);
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(['id', 'seconds', 'startedAt']);
    expect(await listUnassigned(db, 1)).toHaveLength(1);
  });

  it('lists a client’s done meetings newest first with their action item counts', async () => {
    const db = await seededDb();
    const a = await doneMeeting(db, { startedAt: '2026-10-10T10:00:00.000Z', title: 'First' }, { summary: summary(3), docFileId: 'docA' });
    const b = await doneMeeting(db, { startedAt: '2026-10-12T10:00:00.000Z', title: 'Second', driveSeconds: null }, { audioSeconds: 600 });
    await withStatus(db, 'queued', { startedAt: '2026-10-13T10:00:00.000Z' }); // not done
    await withStatus(db, 'done', { clientId: 2, startedAt: '2026-10-14T10:00:00.000Z' }); // other client
    expect(await listClientMeetings(db, 1, 10)).toEqual([
      { id: b, startedAt: '2026-10-12T10:00:00.000Z', title: 'Second', seconds: 600, docFileId: null, actionItemCount: 0 },
      { id: a, startedAt: '2026-10-10T10:00:00.000Z', title: 'First', seconds: 2700, docFileId: 'docA', actionItemCount: 3 },
    ]);
    expect(await listClientMeetings(db, 1, 1)).toHaveLength(1);
  });

  it('gives each client’s latest done meeting', async () => {
    const db = await seededDb();
    await withStatus(db, 'done', { startedAt: '2026-10-10T10:00:00.000Z' });
    await withStatus(db, 'done', { startedAt: '2026-10-12T10:00:00.000Z' });
    await withStatus(db, 'queued', { startedAt: '2026-10-15T10:00:00.000Z' });
    await withStatus(db, 'done', { clientId: 2, startedAt: '2026-10-11T10:00:00.000Z' });
    await withStatus(db, 'skipped', { startedAt: '2026-10-16T10:00:00.000Z' });
    expect(await lastMeetingByClient(db)).toEqual(new Map([[1, '2026-10-12T10:00:00.000Z'], [2, '2026-10-11T10:00:00.000Z']]));
  });

  it('counts meetings by status, and waiting deferrals by code, never a claimed one', async () => {
    const db = await seededDb();
    await withStatus(db, 'done');
    await withStatus(db, 'done');
    await withStatus(db, 'queued');
    const capped = [await withStatus(db, 'queued'), await withStatus(db, 'queued')];
    const busy = await withStatus(db, 'queued');
    const claimed = await withStatus(db, 'queued');
    for (const id of capped) await deferMeeting(db, id, { errorCode: 'spend_cap', nextAttemptAt: LATER, at: NOW });
    await deferMeeting(db, busy, { errorCode: 'client_busy', nextAttemptAt: LATER, at: NOW });
    await deferMeeting(db, claimed, { errorCode: 'client_busy', nextAttemptAt: NOW, at: NOW });
    expect(await claimMeeting(db, claimed, { nextAttemptAt: LATER, at: NOW })).toBe(true); // running now, not deferred
    await withStatus(db, 'unassigned');
    await withStatus(db, 'failed');
    await withStatus(db, 'no_access');
    await withStatus(db, 'too_long');
    await withStatus(db, 'internal');
    await withStatus(db, 'skipped');
    expect(await meetingStats(db, NOW)).toEqual({
      done: 2, waiting: 5, unassigned: 1, failed: 1, noAccess: 1, tooLong: 1, internal: 1, deferred: { spend_cap: 2, client_busy: 1 },
    });
    // Once their time has come they are no longer waiting on a deferral.
    expect((await meetingStats(db, LATER)).deferred).toEqual({});
    expect(await meetingStats(await seededDb(), NOW)).toEqual({
      done: 0, waiting: 0, unassigned: 0, failed: 0, noAccess: 0, tooLong: 0, internal: 0, deferred: {},
    });
  });

  it('a bad JSON value fails only its own row, naming the meeting and column but not the content', async () => {
    const db = await seededDb();
    const good = await doneMeeting(db, { startedAt: '2026-10-10T10:00:00.000Z' }, { summary: summary(1) });
    const bad = await doneMeeting(db, { startedAt: '2026-10-11T10:00:00.000Z' }, { summary: summary(1) });
    const badSummary = await doneMeeting(db, { startedAt: '2026-10-12T10:00:00.000Z' }, { summary: summary(1) });
    const noList = await doneMeeting(db, { startedAt: '2026-10-13T10:00:00.000Z' }, { summary: summary(1) });
    rawOf(db).prepare("UPDATE meetings SET attendees = '[{\"email\": 42, \"secret\": \"Mr Sharma private\"}]' WHERE id = ?").run(bad);
    rawOf(db).prepare("UPDATE meetings SET summary = '{not json: private words' WHERE id = ?").run(badSummary);
    rawOf(db).prepare(`UPDATE meetings SET summary = '{"actionItems": "private"}' WHERE id = ?`).run(noList);
    await expect(getMeeting(db, bad)).rejects.toThrow(new RegExp(`meeting ${bad}.*attendees`));
    await expect(getMeeting(db, bad)).rejects.not.toThrow(/private/);
    await expect(getMeeting(db, badSummary)).rejects.toThrow(new RegExp(`meeting ${badSummary}.*summary`));
    await expect(getMeeting(db, badSummary)).rejects.not.toThrow(/private/);
    expect(await getMeeting(db, good)).toMatchObject({ id: good });
    // The light state reads no JSON, so the processor loop still sees every row.
    expect(await getMeetingState(db, badSummary)).toMatchObject({ id: badSummary, status: 'done', stage: 'tracked' });
    // The list reads only the summary's action items, so the bad attendees row is still listed; the bad summaries are
    // skipped, and the limit counts only listed rows.
    expect((await listClientMeetings(db, 1, 10)).map((m) => m.id)).toEqual([bad, good]);
    expect((await listClientMeetings(db, 1, 1)).map((m) => m.id)).toEqual([bad]);
    // The last meeting is the newest listed one, not the hidden ones of the 12th and 13th.
    expect((await lastMeetingByClient(db)).get(1)).toBe('2026-10-11T10:00:00.000Z');
  });
});

describe('migration 7', () => {
  it('upgrades a version-6 database with data in it: old rows unchanged, new columns null, links valid', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)');
    for (const m of MIGRATIONS.filter((x) => x.version <= 6)) {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(m.version);
    }
    db.prepare("INSERT INTO clients (code, name, group_id, phases) VALUES ('SHA', 'Sharma', '1@g.us', '[]')").run();
    db.prepare("INSERT INTO messages (wa_id, client_id, sender_jid, ts) VALUES ('m1', 1, 'x', '2026-10-10T00:00:00Z')").run();
    db.prepare(`INSERT INTO media (message_id, client_id, kind, status, text_kind, text, created_at, updated_at)
      VALUES (1, 1, 'image', 'done', 'description', 'A blue banner', '2026-10-10T00:00:00Z', '2026-10-10T00:01:00Z')`).run();
    db.prepare(`INSERT INTO tasks (code, client_id, side, title, category, priority, raised_on, created_at, updated_at)
      VALUES ('SHA-001', 1, 'us', 'Send logo', 'design', 'high', '2026-10-10', '2026-10-10T00:00:00Z', '2026-10-10T00:00:00Z')`).run();
    db.prepare(`INSERT INTO decisions (client_id, text, decided_on, source, created_at)
      VALUES (1, 'Blue theme', '2026-10-10', 'whatsapp', '2026-10-10T00:00:00Z')`).run();
    db.prepare(`INSERT INTO reports (date, status, attempts, created_at, updated_at)
      VALUES ('2026-10-10', 'sent', 1, '2026-10-10T00:30:00Z', '2026-10-10T00:31:00Z')`).run();
    const before = {
      tasks: db.prepare('SELECT * FROM tasks').all(),
      decisions: db.prepare('SELECT * FROM decisions').all(),
      media: db.prepare('SELECT * FROM media').all(),
      clients: db.prepare('SELECT * FROM clients').all(),
      reports: db.prepare('SELECT * FROM reports').all(),
    };
    migrate(db, MIGRATIONS.filter((x) => x.version <= 7)); // up to 7 only: v8 (Phase 2b) adds a media column
    expect((db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v).toBe(7);
    const strip = (rows: unknown[]) => rows.map((r) => {
      const { meeting_id: _m, ...rest } = r as Record<string, unknown>;
      return rest;
    });
    expect(strip(db.prepare('SELECT * FROM tasks').all())).toEqual(before.tasks);
    expect(strip(db.prepare('SELECT * FROM decisions').all())).toEqual(before.decisions);
    expect(db.prepare('SELECT * FROM media').all()).toEqual(before.media);
    expect(db.prepare('SELECT * FROM clients').all()).toEqual(before.clients);
    expect(db.prepare('SELECT * FROM reports').all()).toEqual(before.reports);
    expect(db.prepare('SELECT meeting_id FROM tasks').get()).toEqual({ meeting_id: null });
    expect(db.prepare('SELECT meeting_id FROM decisions').get()).toEqual({ meeting_id: null });
    expect((db.prepare('SELECT COUNT(*) AS n FROM meetings').get() as { n: number }).n).toBe(0);

    // The new links point at meetings, and the foreign keys hold.
    const id = (await insertFound(SqliteDb.wrap(db), meeting({ status: 'done' })))!;
    db.prepare('UPDATE tasks SET meeting_id = ?').run(id);
    db.prepare('UPDATE decisions SET meeting_id = ?').run(id);
    expect(() => db.prepare('UPDATE tasks SET meeting_id = 999').run()).toThrow(/FOREIGN KEY/);
    expect(() => db.prepare('UPDATE decisions SET meeting_id = 999').run()).toThrow(/FOREIGN KEY/);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('a fresh database has migration 7, with its indexes, and the table refuses unknown statuses and stages', async () => {
    const db = await seededDb();
    expect(rawOf(db).prepare('SELECT version FROM schema_version WHERE version = 7').get()).toEqual({ version: 7 });
    expect((rawOf(db).prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v).toBe(12); // the latest: v12 is Open chat's outbox, after v11 (priority and sentiment)
    const idx = (rawOf(db).prepare("SELECT tbl_name || '.' || name AS n FROM sqlite_master WHERE type = 'index'").all() as { n: string }[]).map((i) => i.n);
    expect(idx).toEqual(expect.arrayContaining([
      'meetings.meetings_due', 'meetings.meetings_conference', 'meetings.meetings_client', 'tasks.tasks_meeting', 'decisions.decisions_meeting',
    ]));
    expect(rawOf(db).prepare("SELECT name FROM pragma_index_info('meetings_client') ORDER BY seqno").all()).toEqual([
      { name: 'client_id' }, { name: 'status' }, { name: 'started_at' },
    ]);
    await expect(insertFound(db, meeting({ status: 'pending' as MeetingStatus }))).rejects.toThrow(/CHECK/);
    const id = await withStatus(db, 'queued');
    expect(() => rawOf(db).prepare("UPDATE meetings SET stage = 'uploaded' WHERE id = ?").run(id)).toThrow(/CHECK/);
    await expect(insertFound(db, meeting({ clientId: 999 }))).rejects.toThrow(/FOREIGN KEY/);
  });

  it('an internal meeting keeps no title, attendees or names', async () => {
    const db = await seededDb();
    const internal = { status: 'internal' as const, clientId: null, matchKind: null, title: '', attendees: [], participants: [] };
    expect(await insertFound(db, meeting(internal))).toBeTypeOf('number');
    await expect(insertFound(db, meeting({ ...internal, title: 'Team sync' }))).rejects.toThrow(/CHECK/);
    await expect(insertFound(db, meeting({ ...internal, attendees: [{ email: 'r@us.example', name: null, team: true }] }))).rejects.toThrow(/CHECK/);
    await expect(insertFound(db, meeting({ ...internal, participants: ['Rohit'] }))).rejects.toThrow(/CHECK/);
    const queued = await withStatus(db, 'queued');
    expect(() => rawOf(db).prepare("UPDATE meetings SET status = 'internal' WHERE id = ?").run(queued)).toThrow(/CHECK/);
  });
});

describe('refreshMeetingFacts', () => {
  it('stores the facts read again for a queued meeting at stage found; empty values keep the stored ones', async () => {
    const db = await seededDb();
    const id = await withStatus(db, 'queued', { title: '', attendees: [], participants: [] });
    await refreshMeetingFacts(db, id, { title: 'Brand review', attendees: [{ email: 'a@sharma.example', name: 'Asha', team: false }], participants: [] }, LATER);
    expect(await getMeeting(db, id)).toMatchObject({ title: 'Brand review', attendees: [{ email: 'a@sharma.example', name: 'Asha', team: false }], participants: [], updatedAt: LATER });
    await refreshMeetingFacts(db, id, { title: '', attendees: [], participants: ['Asha'] }, LATER);
    expect(await getMeeting(db, id)).toMatchObject({ title: 'Brand review', attendees: [{ name: 'Asha' }], participants: ['Asha'] });
  });

  it('throws, writing nothing, past stage found or when not queued', async () => {
    const db = await seededDb();
    const id = await withStatus(db, 'queued');
    await advanceStage(db, id, 'audio', { audioPath: 'meetings/1.mp3', audioSeconds: 60 }, NOW);
    await expect(refreshMeetingFacts(db, id, { title: 'x', attendees: [], participants: [] }, LATER)).rejects.toThrow(/not queued at stage found/);
    const un = await withStatus(db, 'unassigned');
    await expect(refreshMeetingFacts(db, un, { title: 'x', attendees: [], participants: [] }, LATER)).rejects.toThrow(/not queued/);
    expect((await getMeeting(db, id))!.title).toBe('Sharma weekly');
  });
});
