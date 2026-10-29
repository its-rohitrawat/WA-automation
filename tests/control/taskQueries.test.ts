import { describe, expect, it } from 'vitest';
import { closeTask, editTask, reopenTask, unlockTask } from '../../src/cli/corrections.ts';
import { ControlError } from '../../src/control/errors.ts';
import { overview } from '../../src/control/queries.ts';
import { listDashboardTasks, parseTaskQuery, taskDetail, TASK_LIMIT_MAX } from '../../src/control/taskQueries.ts';
import type { Db } from '../../src/store/db.ts';
import { insertMedia, messageRowId } from '../../src/store/media.ts';
import { insertFound } from '../../src/store/meetings.ts';
import { insertMessage } from '../../src/store/messages.ts';
import { createTask, recordEvent, type NewTask } from '../../src/store/tasks.ts';
import { NOW, seededDb } from '../helpers/db.ts';

// 2026-10-19 08:00 UTC is 13:30 IST on Monday 19 Oct.
const now = new Date(NOW);

function task(db: Db, over: Partial<NewTask> & { status?: 'open' | 'maybe_done' | 'done'; updatedAt?: string } = {}): string {
  const { status, updatedAt, ...rest } = over;
  const t = createTask(db, {
    clientId: 1, side: 'us', title: 'Banner', category: 'design', priority: 'medium', assignedTo: null, askedBy: null, raisedOn: '2026-10-10',
    deadline: null, latestProgress: null, sourceQuote: null, sourceDate: null, sourceWaId: null, origin: 'whatsapp', ...rest,
  }, NOW);
  if (status) db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, t.id);
  if (updatedAt) db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(updatedAt, t.id);
  return t.code;
}

const codes = (r: { rows: { code: string }[] }) => r.rows.map((x) => x.code);
const q = (o: Record<string, string>) => parseTaskQuery(new URLSearchParams(o));

describe('parseTaskQuery', () => {
  it('takes defaults', () => {
    expect(q({})).toEqual({ sort: 'deadline', dir: 'asc', limit: 100, offset: 0 });
  });

  it('refuses unknown values with the field named, and caps limit', () => {
    for (const [field, value] of [['status', 'late'], ['deadline', 'soon'], ['priority', 'urgent'], ['sort', 'title'], ['dir', 'up'],
      ['limit', '0'], ['limit', 'x'], ['offset', '-1'], ['offset', '1.5'], ['client', 'sh'], ['client', 'SHA1']] as const) {
      let err: unknown;
      try {
        q({ [field]: value });
      } catch (e) {
        err = e;
      }
      expect(err, `${field}=${value}`).toBeInstanceOf(ControlError);
      expect(err).toMatchObject({ status: 400, field });
    }
    expect(q({ limit: '9999' }).limit).toBe(TASK_LIMIT_MAX);
    expect(q({ client: 'sha', q: '  x  ', owner: ' Rahul ' })).toMatchObject({ client: 'SHA', q: 'x', owner: 'Rahul' });
    expect(q({ q: '   ' }).q).toBeUndefined();
  });

  it('refuses a search or owner longer than 200 characters', () => {
    expect(() => q({ q: 'a'.repeat(201) })).toThrowError(ControlError);
    expect(() => q({ owner: 'a'.repeat(201) })).toThrowError(ControlError);
  });
});

describe('listDashboardTasks', () => {
  it('returns the row shape, with the client and plain status', () => {
    const db = seededDb();
    task(db, { title: 'Logo', assignedTo: 'Rahul', askedBy: 'Mr Sharma', deadline: '2026-10-25', priority: 'high' });
    expect(listDashboardTasks(db, q({}), now)).toEqual({
      total: 1,
      rows: [{
        code: 'SHA-001', title: 'Logo', client: { code: 'SHA', name: 'Sharma Interiors' }, side: 'us', owner: 'Rahul', askedBy: 'Mr Sharma',
        deadline: '2026-10-25', status: 'open', overdue: false, priority: 'high', category: 'design', source: 'whatsapp', updatedAt: NOW,
      }],
    });
  });

  it('splits statuses: overdue first, then open, review (maybe done) and done, each excluding the ones before', () => {
    const db = seededDb();
    const late = task(db, { deadline: '2026-10-18' });
    const lateReview = task(db, { deadline: '2026-10-18', status: 'maybe_done' });
    const open = task(db, { deadline: '2026-10-19' }); // due today: not overdue
    const review = task(db, { status: 'maybe_done' });
    const done = task(db, { deadline: '2026-10-01', status: 'done' }); // a done task is never overdue
    expect(codes(listDashboardTasks(db, q({ status: 'overdue' }), now))).toEqual([late, lateReview]);
    expect(codes(listDashboardTasks(db, q({ status: 'open' }), now))).toEqual([open]);
    expect(codes(listDashboardTasks(db, q({ status: 'review' }), now))).toEqual([review]);
    expect(codes(listDashboardTasks(db, q({ status: 'done' }), now))).toEqual([done]);
    const all = listDashboardTasks(db, q({ sort: 'code' }), now).rows;
    expect(all.map((r) => [r.code, r.status, r.overdue])).toEqual([
      [late, 'overdue', true], [lateReview, 'overdue', true], [open, 'open', false], [review, 'review', false], [done, 'done', false],
    ]);
  });

  it('dates overdue by the IST day, not the UTC one', () => {
    const db = seededDb();
    const code = task(db, { deadline: '2026-10-19' });
    // 23:30 IST on the 19th: still due today.
    expect(codes(listDashboardTasks(db, q({ status: 'overdue' }), new Date('2026-10-19T18:00:00Z')))).toEqual([]);
    // 00:15 IST on the 20th (still the 19th in UTC): overdue.
    expect(codes(listDashboardTasks(db, q({ status: 'overdue' }), new Date('2026-10-19T18:45:00Z')))).toEqual([code]);
  });

  it('filters deadlines: past, this week (today to today + 6, IST) and none', () => {
    const db = seededDb();
    const past = task(db, { deadline: '2026-10-18' });
    const today = task(db, { deadline: '2026-10-19' });
    const sixth = task(db, { deadline: '2026-10-25' });
    const later = task(db, { deadline: '2026-10-26' });
    const none = task(db);
    expect(codes(listDashboardTasks(db, q({ deadline: 'past' }), now))).toEqual([past]);
    expect(codes(listDashboardTasks(db, q({ deadline: 'week' }), now))).toEqual([today, sixth]);
    expect(codes(listDashboardTasks(db, q({ deadline: 'none' }), now))).toEqual([none]);
    // Late on the 25th IST the week runs to the 31st.
    expect(codes(listDashboardTasks(db, q({ deadline: 'week' }), new Date('2026-10-24T19:00:00Z')))).toEqual([sixth, later]);
  });

  it('filters by client, owner (any case) and priority', () => {
    const db = seededDb();
    const a = task(db, { assignedTo: 'Rahul', priority: 'high' });
    const b = task(db, { clientId: 2, assignedTo: 'rahul' });
    task(db, { assignedTo: 'Priya' });
    expect(codes(listDashboardTasks(db, q({ client: 'MEH' }), now))).toEqual([b]);
    expect(codes(listDashboardTasks(db, q({ owner: 'RAHUL', sort: 'code' }), now))).toEqual([b, a]);
    expect(codes(listDashboardTasks(db, q({ priority: 'high' }), now))).toEqual([a]);
    expect(listDashboardTasks(db, q({ client: 'XYZ' }), now)).toEqual({ total: 0, rows: [] });
  });

  it('searches code, title, client name and owner, any case', () => {
    const db = seededDb();
    const a = task(db, { title: 'New LOGO' });
    const b = task(db, { clientId: 2, title: 'Menu' });
    const c = task(db, { title: 'Brochure', assignedTo: 'Rahul' });
    expect(codes(listDashboardTasks(db, q({ q: 'logo' }), now))).toEqual([a]);
    expect(codes(listDashboardTasks(db, q({ q: 'mehta' }), now))).toEqual([b]);
    expect(codes(listDashboardTasks(db, q({ q: 'rah' }), now))).toEqual([c]);
    expect(codes(listDashboardTasks(db, q({ q: 'sha-002' }), now))).toEqual([c]);
  });

  it('treats % _ and \\ in the search as plain characters', () => {
    const db = seededDb();
    task(db, { title: 'Banner' });
    const pct = task(db, { title: '50% off' });
    const und = task(db, { title: 'file_v2' });
    const back = task(db, { title: 'a\\b' });
    expect(codes(listDashboardTasks(db, q({ q: '%' }), now))).toEqual([pct]);
    expect(codes(listDashboardTasks(db, q({ q: '_' }), now))).toEqual([und]);
    expect(codes(listDashboardTasks(db, q({ q: '\\' }), now))).toEqual([back]);
    expect(codes(listDashboardTasks(db, q({ q: "'; DROP TABLE tasks; --" }), now))).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 4 });
  });

  it('sorts by deadline (none last), code, client, owner (none last) and status, either way', () => {
    const db = seededDb();
    const a = task(db, { deadline: '2026-10-30', assignedTo: 'Zed' }); // SHA-001
    const b = task(db, { clientId: 2, deadline: '2026-10-21' }); // MEH-001
    const c = task(db, { assignedTo: 'Amit', status: 'done' }); // SHA-002
    const d = task(db, { deadline: '2026-10-01', assignedTo: 'Ben' }); // SHA-003, overdue
    const sort = (s: string, dir = 'asc') => codes(listDashboardTasks(db, q({ sort: s, dir }), now));
    expect(sort('deadline')).toEqual([d, b, a, c]);
    expect(sort('deadline', 'desc')).toEqual([a, b, d, c]);
    expect(sort('code')).toEqual([b, a, c, d]);
    expect(sort('code', 'desc')).toEqual([d, c, a, b]);
    expect(sort('client')).toEqual([b, a, c, d]); // Mehta before Sharma, then the code
    expect(sort('owner')).toEqual([c, d, a, b]);
    expect(sort('owner', 'desc')).toEqual([a, d, c, b]);
    expect(sort('status')).toEqual([d, b, a, c]); // overdue, open (code order), done
    expect(sort('status', 'desc')).toEqual([c, b, a, d]);
  });

  it('sorts codes by their number, so SHA-1000 comes after SHA-999', () => {
    const db = seededDb();
    db.prepare('UPDATE clients SET next_task_seq = 999 WHERE id = 1').run();
    const a = task(db);
    const b = task(db);
    expect([a, b]).toEqual(['SHA-999', 'SHA-1000']);
    expect(codes(listDashboardTasks(db, q({ sort: 'code' }), now))).toEqual([a, b]);
  });

  it('pages with limit and offset, and counts the total before paging', () => {
    const db = seededDb();
    const all = Array.from({ length: 5 }, () => task(db));
    expect(listDashboardTasks(db, q({ sort: 'code', limit: '2', offset: '2' }), now)).toMatchObject({ total: 5, rows: [{ code: all[2] }, { code: all[3] }] });
    expect(listDashboardTasks(db, q({ sort: 'code', limit: '2', offset: '9' }), now)).toEqual({ total: 5, rows: [] });
  });

  it('names the source: a meeting, a voice note, or WhatsApp', () => {
    const db = seededDb();
    const meetingId = insertFound(db, {
      recording: 'conferenceRecords/a/recordings/b', conference: 'conferenceRecords/a', driveFileId: 'd1', meetingCode: null, title: 'Sync',
      startedAt: NOW, endedAt: null, attendees: [], participants: [], clientId: 1, matchKind: 'title', status: 'done', driveSeconds: 60, createdAt: NOW,
    })!;
    const fromMeeting = task(db, { origin: 'meeting', meetingId });
    insertMessage(db, { waId: 'V1', clientId: 1, senderJid: 'x', senderNumber: null, senderName: null, fromMe: false, ts: NOW, text: null, quotedWaId: null, mediaType: 'audio' });
    insertMedia(db, { messageId: messageRowId(db, 1, 'V1')!, clientId: 1, kind: 'voice', status: 'done', mimeType: 'audio/ogg', fileName: null, fileSize: 1, seconds: 4,
      forwarded: false, refEnc: null, errorCode: null, createdAt: NOW });
    const fromVoice = task(db, { sourceWaId: 'V1' });
    insertMessage(db, { waId: 'T1', clientId: 1, senderJid: 'x', senderNumber: null, senderName: null, fromMe: false, ts: NOW, text: 'hi', quotedWaId: null, mediaType: null });
    const fromText = task(db, { sourceWaId: 'T1' });
    // The same message id in another client's group is not this task's source.
    insertMessage(db, { waId: 'V2', clientId: 2, senderJid: 'x', senderNumber: null, senderName: null, fromMe: false, ts: NOW, text: null, quotedWaId: null, mediaType: 'audio' });
    insertMedia(db, { messageId: messageRowId(db, 2, 'V2')!, clientId: 2, kind: 'voice', status: 'done', mimeType: 'audio/ogg', fileName: null, fileSize: 1, seconds: 4,
      forwarded: false, refEnc: null, errorCode: null, createdAt: NOW });
    const otherGroup = task(db, { sourceWaId: 'V2' });
    const sources = Object.fromEntries(listDashboardTasks(db, q({}), now).rows.map((r) => [r.code, r.source]));
    expect(sources).toEqual({ [fromMeeting]: 'meeting', [fromVoice]: 'voice', [fromText]: 'whatsapp', [otherGroup]: 'whatsapp' });
  });
});

describe('taskDetail', () => {
  it('returns undefined for an unknown or badly formed code', () => {
    const db = seededDb();
    task(db);
    expect(taskDetail(db, 'SHA-999', now)).toBeUndefined();
    expect(taskDetail(db, "x' OR 1=1 --", now)).toBeUndefined();
  });

  it('adds the source quote, progress, reminders and history in plain words', () => {
    const db = seededDb();
    const code = task(db, { sourceQuote: 'Please send the <b>logo</b>', sourceDate: '2026-10-10', latestProgress: 'Draft sent' });
    db.prepare("UPDATE tasks SET reminder_count = 2, source_revoked = 1 WHERE code = ?").run(code);
    const ai = (op: string, detail: object, at: string) =>
      recordEvent(db, { taskId: 1, clientId: 1, actor: 'ai', op, detail, reason: 'x', sourceIds: ['W1'], at });
    ai('add_task', { code, title: 'secret words from chat', side: 'us', status: 'open' }, '2026-10-10T05:00:00.000Z');
    ai('log_reminder', {}, '2026-10-11T05:00:00.000Z');
    ai('update_task', { latestProgress: 'secret words from chat' }, '2026-10-12T05:00:00.000Z');
    ai('mark_maybe_done', { status: 'maybe_done' }, '2026-10-13T05:00:00.000Z');
    closeTask(db, code, new Date('2026-10-14T05:00:00.000Z'));
    reopenTask(db, code, new Date('2026-10-15T05:00:00.000Z'));
    editTask(db, code, { deadline: '2026-10-30', assignedTo: 'Rahul' }, new Date('2026-10-16T05:00:00.000Z'));
    unlockTask(db, code, new Date('2026-10-17T05:00:00.000Z'));
    ai('close_task', { status: 'done' }, '2026-10-18T05:00:00.000Z');
    ai('reopen_task', { status: 'open' }, '2026-10-18T06:00:00.000Z');
    ai('some_new_op', { text: 'secret words from chat' }, '2026-10-18T07:00:00.000Z');
    const d = taskDetail(db, code.toLowerCase(), now)!;
    expect(d).toMatchObject({
      code, sourceQuote: 'Please send the <b>logo</b>', sourceDate: '2026-10-10', sourceRevoked: true, latestProgress: 'Draft sent', remindedCount: 2,
    });
    expect(d.history).toEqual([
      { at: '2026-10-10T05:00:00.000Z', actor: 'agent', what: 'Created from WhatsApp' },
      { at: '2026-10-11T05:00:00.000Z', actor: 'agent', what: 'Reminder noted' },
      { at: '2026-10-12T05:00:00.000Z', actor: 'agent', what: 'Updated (progress)' },
      { at: '2026-10-13T05:00:00.000Z', actor: 'agent', what: 'Marked maybe done' },
      { at: '2026-10-14T05:00:00.000Z', actor: 'owner', what: 'Marked done by the owner' },
      { at: '2026-10-15T05:00:00.000Z', actor: 'owner', what: 'Reopened by the owner' },
      { at: '2026-10-16T05:00:00.000Z', actor: 'owner', what: 'Edited by the owner (owner, deadline)' },
      { at: '2026-10-17T05:00:00.000Z', actor: 'owner', what: 'Handed back to the agent by the owner' },
      { at: '2026-10-18T05:00:00.000Z', actor: 'agent', what: 'Marked done' },
      { at: '2026-10-18T06:00:00.000Z', actor: 'agent', what: 'Reopened' },
      { at: '2026-10-18T07:00:00.000Z', actor: 'agent', what: 'Changed by the agent' },
    ]);
    expect(JSON.stringify(d.history)).not.toContain('secret');
  });

  it('says where a task was created from, and survives a bad stored detail', () => {
    const db = seededDb();
    const code = task(db, { origin: 'meeting' });
    recordEvent(db, { taskId: 1, clientId: 1, actor: 'ai', op: 'add_task', detail: {}, reason: null, sourceIds: [], at: NOW });
    recordEvent(db, { taskId: 1, clientId: 1, actor: 'ai', op: 'update_task', detail: {}, reason: null, sourceIds: [], at: NOW });
    db.prepare("INSERT INTO task_events (task_id, client_id, actor, op, detail, at) VALUES (1, 1, 'human', 'update_task', 'not json', ?)").run(NOW);
    expect(taskDetail(db, code, now)!.history.map((h) => h.what)).toEqual(['Created from a meeting', 'Updated', 'Edited by the owner']);
  });
});

describe('listDashboardTasks review fixes', () => {
  it('sorts by status as overdue, open, review, done', () => {
    const db = seededDb();
    const done = task(db, { status: 'done' });
    const review = task(db, { status: 'maybe_done' });
    const open = task(db);
    const late = task(db, { deadline: '2026-10-01' });
    expect(codes(listDashboardTasks(db, q({ sort: 'status' }), now))).toEqual([late, open, review, done]);
    expect(codes(listDashboardTasks(db, q({ sort: 'status', dir: 'desc' }), now))).toEqual([done, review, open, late]);
  });

  it('sorts client names without regard to case', () => {
    const db = seededDb();
    db.prepare("UPDATE clients SET name = 'mehta foods' WHERE id = 2").run();
    const sharma = task(db);
    const mehta = task(db, { clientId: 2 });
    expect(codes(listDashboardTasks(db, q({ sort: 'client' }), now))).toEqual([mehta, sharma]);
  });

  it('counts done tasks with an old deadline under deadline=past', () => {
    const db = seededDb();
    const done = task(db, { deadline: '2026-10-01', status: 'done' });
    expect(codes(listDashboardTasks(db, q({ deadline: 'past' }), now))).toEqual([done]);
    expect(codes(listDashboardTasks(db, q({ status: 'overdue' }), now))).toEqual([]);
  });

  it('closed=7d lists the done tasks closed today and the six days before (IST): the Overview\'s Done count, task for task', () => {
    const db = seededDb();
    const closedOn = (code: string, day: string) => db.prepare("UPDATE tasks SET status = 'done', closed_on = ? WHERE code = ?").run(day, code);
    const today = task(db);
    const sixth = task(db);
    const older = task(db);
    const reopened = task(db); // closed in the week, then reopened: not done, so not counted
    task(db); // open
    closedOn(today, '2026-10-19');
    closedOn(sixth, '2026-10-13');
    closedOn(older, '2026-10-12');
    closedOn(reopened, '2026-10-15');
    db.prepare("UPDATE tasks SET status = 'open' WHERE code = ?").run(reopened);
    const r = listDashboardTasks(db, q({ status: 'done', closed: '7d' }), now);
    expect(codes(r).sort()).toEqual([today, sixth].sort());
    expect(r.total).toBe(overview(db, now).tasks.doneThisWeek);
    expect(listDashboardTasks(db, q({ closed: '7d' }), now).total).toBe(2);
    expect(() => q({ closed: '30d' })).toThrowError(ControlError);
  });
});
