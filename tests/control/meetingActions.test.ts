import { describe, expect, it } from 'vitest';
import { assignMeetingToClient, retryMeetingById, skipMeetingById } from '../../src/cli/meetings.ts';
import { ControlError, type AuditEntry } from '../../src/control/errors.ts';
import { MEETING_COST_WARNING, runMeetingAction } from '../../src/control/meetingActions.ts';
import type { Db } from '../../src/store/db.ts';
import { getKv } from '../../src/store/kv.ts';
import { insertFound, type MeetingStatus } from '../../src/store/meetings.ts';
import { NOW, seededDb } from '../helpers/db.ts';

const now = new Date('2026-10-19T08:00:00Z');
const OWNER = 'owner@example.com';

async function withMeeting(status: MeetingStatus, clientId: number | null = null): Promise<Db> {
  const db = await seededDb();
  await insertFound(db, {
    recording: 'conferenceRecords/a/recordings/b', conference: 'conferenceRecords/a', driveFileId: 'drive1', meetingCode: null,
    title: status === 'internal' ? '' : 'Weekly sync', startedAt: NOW, endedAt: null, attendees: [], participants: [], clientId,
    matchKind: clientId === null ? null : 'title', status, driveSeconds: 1800, errorCode: status === 'failed' ? 'stt_failed' : null, createdAt: NOW,
  });
  return db;
}

async function state(db: Db) {
  return {
    meetings: db.raw.prepare('SELECT * FROM meetings').all(),
    events: db.raw.prepare('SELECT task_id, client_id, actor, op, detail, reason, at FROM task_events ORDER BY id').all(),
    rebuild: await getKv(db, 'rebuild_requested'),
  };
}

const notPaused = { isPaused: () => false };
const paused = { isPaused: () => true };

async function run(db: Db, id: string, action: string, body?: unknown, spend = notPaused) {
  const audits: AuditEntry[] = [];
  const result = await runMeetingAction(db, { id, action, body }, { actor: OWNER, now, audit: (e) => audits.push(e), spend });
  return { result, audits };
}

async function refusal(fn: () => unknown): Promise<ControlError> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof ControlError) return e;
    throw e;
  }
  throw new Error('expected a ControlError');
}

describe('runMeetingAction matches the CLI', () => {
  it('assign', async () => {
    const web = await withMeeting('unassigned');
    const cli = await withMeeting('unassigned');
    const { result, audits } = await run(web, '1', 'assign', { client: 'sha' });
    await assignMeetingToClient(cli, '1', 'SHA', now);
    expect(await state(web)).toEqual(await state(cli));
    expect(result.meeting).toMatchObject({ id: 1, status: 'queued', client: { code: 'SHA' } });
    expect(result.warning).toBe(MEETING_COST_WARNING); // assigning queues the meeting for paid processing
    expect(audits).toEqual([{ actor: OWNER, event: 'meeting.assign', kind: 'meeting', detail: 'Meeting 1 assigned to SHA' }]);
  });

  it('skip', async () => {
    const web = await withMeeting('unassigned');
    const cli = await withMeeting('unassigned');
    const { result, audits } = await run(web, '1', 'skip');
    await skipMeetingById(cli, '1', now);
    expect(await state(web)).toEqual(await state(cli));
    expect(result.meeting.status).toBe('skipped');
    expect(audits).toEqual([{ actor: OWNER, event: 'meeting.skip', kind: 'meeting', detail: 'Meeting 1 skipped' }]);
  });

  it('retry, with the cost warning', async () => {
    const web = await withMeeting('failed', 1);
    const cli = await withMeeting('failed', 1);
    const { result, audits } = await run(web, '1', 'retry');
    await retryMeetingById(cli, '1', now);
    expect(await state(web)).toEqual(await state(cli));
    expect(result).toMatchObject({ meeting: { status: 'queued' }, warning: MEETING_COST_WARNING });
    expect(MEETING_COST_WARNING).toBe('Processing a meeting costs money');
    expect(audits).toEqual([{ actor: OWNER, event: 'meeting.retry', kind: 'meeting', detail: 'Meeting 1 queued again' }]);
  });

  it('retry of a meeting without a client puts it back to unassigned, as the CLI does', async () => {
    const web = await withMeeting('no_access');
    const cli = await withMeeting('no_access');
    const { result, audits } = await run(web, '1', 'retry');
    await retryMeetingById(cli, '1', now);
    expect(await state(web)).toEqual(await state(cli));
    expect(result.meeting.status).toBe('unassigned');
    expect(audits[0]!.detail).toBe('Meeting 1 has no client, so it is unassigned again');
  });

  it('never puts the title in the audit line', async () => {
    const { audits } = await run(await withMeeting('unassigned'), '1', 'assign', { client: 'SHA' });
    expect(JSON.stringify(audits)).not.toContain('Weekly');
  });
});

describe('runMeetingAction refusals', () => {
  it('refuses a retry while the daily spend cap is reached, changing and auditing nothing', async () => {
    const db = await withMeeting('failed', 1);
    const before = await state(db);
    const audits: AuditEntry[] = [];
    const e = await refusal(async () => await runMeetingAction(db, { id: '1', action: 'retry' }, { actor: OWNER, now, audit: (x) => audits.push(x), spend: paused }));
    expect(e).toMatchObject({ status: 409, message: "Today's AI spending limit is reached. Try again after midnight IST." });
    expect(await state(db)).toEqual(before);
    expect(audits).toEqual([]);
  });

  it('assign and skip still work at the cap: the pipeline itself waits for the budget', async () => {
    expect((await run(await withMeeting('unassigned'), '1', 'skip', undefined, paused)).result.meeting.status).toBe('skipped');
    expect((await run(await withMeeting('unassigned'), '1', 'assign', { client: 'SHA' }, paused)).result.meeting.status).toBe('queued');
  });

  it('404 for an unknown or badly formed id', async () => {
    const db = await withMeeting('unassigned');
    expect(await refusal(async () => await run(db, '9', 'skip'))).toMatchObject({ status: 404, message: 'No meeting 9' });
    for (const bad of ['0', 'x', '1 OR 1=1', '']) expect((await refusal(async () => await run(db, bad, 'skip'))).status, bad).toBe(404);
  });

  it('400 for an unknown action', async () => {
    const db = await withMeeting('unassigned');
    expect(await refusal(async () => await run(db, '1', 'delete'))).toMatchObject({ status: 400, field: 'action' });
  });

  it('409 when the meeting is not in a state that allows it', async () => {
    const db = await withMeeting('done', 1);
    const before = await state(db);
    expect(await refusal(async () => await run(db, '1', 'skip'))).toMatchObject({ status: 409 });
    expect(await refusal(async () => await run(db, '1', 'retry'))).toMatchObject({ status: 409 });
    expect(await refusal(async () => await run(db, '1', 'assign', { client: 'SHA' }))).toMatchObject({ status: 409 });
    expect(await state(db)).toEqual(before);
  });

  it('422 for a bad, unknown or inactive client', async () => {
    const db = await withMeeting('unassigned');
    for (const body of [undefined, null, {}, { client: 5 }, { client: 'SH' }, { client: 'SHA1' }, [], 'SHA']) {
      expect(await refusal(async () => await run(db, '1', 'assign', body)), JSON.stringify(body)).toMatchObject({ status: 422, field: 'client' });
    }
    expect(await refusal(async () => await run(db, '1', 'assign', { client: 'XYZ' }))).toMatchObject({ status: 422, field: 'client', message: 'No client with code XYZ' });
    db.raw.prepare("UPDATE clients SET active = 0 WHERE code = 'MEH'").run();
    expect(await refusal(async () => await run(db, '1', 'assign', { client: 'MEH' }))).toMatchObject({ status: 422, field: 'client' });
  });

  it('rolls the change back when the audit cannot be written', async () => {
    const db = await withMeeting('unassigned');
    const before = await state(db);
    await expect(runMeetingAction(db, { id: '1', action: 'skip' }, { actor: OWNER, now, audit: () => { throw new Error('disk full'); }, spend: notPaused }))
      .rejects.toThrowError('disk full');
    expect(await state(db)).toEqual(before);
  });
});

describe('runMeetingAction review fixes', () => {
  it('a skip carries no cost warning', async () => {
    expect((await run(await withMeeting('unassigned'), '1', 'skip')).result.warning).toBeUndefined();
  });

  it("puts a meeting that changed meanwhile in the dashboard's words", async () => {
    const db = await withMeeting('unassigned');
    // As if another writer took the meeting between the check and the change.
    db.raw.exec('CREATE TRIGGER grab BEFORE UPDATE ON meetings BEGIN SELECT RAISE(IGNORE); END');
    const e = await refusal(async () => await run(db, '1', 'skip'));
    expect(e).toMatchObject({ status: 409, message: 'Meeting 1 changed meanwhile; refresh the list and try again' });
  });
});
