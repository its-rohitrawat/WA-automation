import { describe, expect, it } from 'vitest';
import type { ClientConfig } from '../../src/config/groups.ts';
import { clientCards, clientDetail, MEETINGS_LIMIT } from '../../src/control/clientQueries.ts';
import { finishBatch, startBatch } from '../../src/store/batches.ts';
import { setPhase, syncClients } from '../../src/store/clients.ts';
import type { Db } from '../../src/store/db.ts';
import { insertFound } from '../../src/store/meetings.ts';
import { insertMessage } from '../../src/store/messages.ts';
import { createTask, setTaskStatus, type Status } from '../../src/store/tasks.ts';
import { MEHTA, seededDb, SHARMA } from '../helpers/db.ts';

// Wednesday 28 Oct 2026, 11:30 IST: today is 2026-10-28 and the week started on Monday 2026-10-26.
const NOW = new Date('2026-10-28T06:00:00.000Z');
const QUOTE = 'QUOTE-TEXT-never-sent';
const MESSAGE = 'MESSAGE-TEXT-never-sent';

function task(db: Db, clientId: number, o: { title?: string; deadline?: string | null; status?: Status; closedOn?: string; assignedTo?: string | null }) {
  const t = createTask(
    db,
    {
      clientId, side: 'us', title: o.title ?? 'A task', category: 'design', priority: 'medium', assignedTo: o.assignedTo ?? null, askedBy: null,
      raisedOn: '2026-10-01', deadline: o.deadline ?? null, latestProgress: 'progress words', sourceQuote: QUOTE, sourceDate: '2026-10-01',
      sourceWaId: 'W1', origin: 'whatsapp',
    },
    '2026-10-01T05:00:00.000Z',
  );
  if (o.status && o.status !== 'open') setTaskStatus(db, t.id, o.status, o.closedOn ?? '2026-10-27', '2026-10-27T05:00:00.000Z', 'human');
  return t;
}

function meeting(db: Db, n: number, clientId: number | null, title: string, startedAt: string) {
  return insertFound(db, {
    recording: `conferenceRecords/c${n}/recordings/r${n}`, conference: `conferenceRecords/c${n}`, driveFileId: `drive${n}`, meetingCode: null, title,
    startedAt, endedAt: null, attendees: [{ email: 'a@client.com', name: 'Attendee Name', team: false }], participants: ['Participant Name'],
    clientId, matchKind: clientId === null ? null : 'title', status: clientId === null ? 'unassigned' : 'queued', driveSeconds: 600,
    createdAt: startedAt,
  })!;
}

function message(db: Db, clientId: number, waId: string, ts: string) {
  insertMessage(db, {
    waId, clientId, senderJid: '919800000001@s.whatsapp.net', senderNumber: '919800000001', senderName: 'Sender', fromMe: false, ts, text: MESSAGE,
    quotedWaId: null, mediaType: null,
  });
}

/** Sharma (1): 3 open (2 overdue, 1 in review), 1 done this week, 1 done last week. Mehta (2): one done task. */
function world(): Db {
  const db = seededDb();
  task(db, 1, { title: 'Overdue open', deadline: '2026-10-27', assignedTo: 'Ravi' });
  task(db, 1, { title: 'Due today', deadline: '2026-10-28' });
  task(db, 1, { title: 'In review, overdue', deadline: '2026-10-20', status: 'maybe_done' });
  task(db, 1, { title: 'Done Monday', deadline: '2026-10-01', status: 'done', closedOn: '2026-10-26' });
  task(db, 1, { title: 'Done Sunday', status: 'done', closedOn: '2026-10-25' });
  task(db, 2, { title: 'Mehta done', status: 'done', closedOn: '2026-10-28' });
  message(db, 1, 'M1', '2026-10-27T10:00:00.000Z');
  message(db, 1, 'M2', '2026-10-28T04:00:00.000Z');
  message(db, 2, 'M3', '2026-10-20T04:00:00.000Z');
  setPhase(db, 1, 'Design', 'ai');
  return db;
}

describe('clientCards', () => {
  it('counts open, overdue, review and done this week per active client, with phases, last activity and sheet name', () => {
    const db = world();
    const cards = clientCards(db, NOW);
    expect(cards.map((c) => c.code)).toEqual(['MEH', 'SHA']);
    expect(cards[1]).toEqual({
      code: 'SHA', name: 'Sharma Interiors', groupName: 'Sharma Interiors',
      counts: { open: 3, overdue: 2, review: 1, doneThisWeek: 1 },
      phases: SHARMA.phases, currentPhase: 'Design',
      lastActivity: '2026-10-28T04:00:00.000Z', sheetName: 'Sharma Interiors',
      // seededDb approves the group with the real clock: its earlier messages are waiting to be read.
      history: { state: 'waiting', found: expect.any(Number) },
    });
    expect(cards[0]).toMatchObject({ code: 'MEH', counts: { open: 0, overdue: 0, review: 0, doneThisWeek: 1 }, currentPhase: null, lastActivity: '2026-10-20T04:00:00.000Z' });
  });

  it('a client with no tasks or messages has zero counts and no last activity', () => {
    const cards = clientCards(seededDb(), NOW);
    expect(cards.every((c) => c.lastActivity === null && Object.values(c.counts).every((n) => n === 0))).toBe(true);
  });

  it('the week starts on Monday in India, not in UTC', () => {
    const db = seededDb();
    task(db, 1, { status: 'done', closedOn: '2026-10-25' });
    task(db, 1, { status: 'done', closedOn: '2026-10-26' });
    // 00:10 IST on Monday 26 Oct is still Sunday in UTC.
    expect(clientCards(db, new Date('2026-10-25T18:40:00.000Z')).find((c) => c.code === 'SHA')!.counts.doneThisWeek).toBe(1);
    // 23:50 IST on Sunday 25 Oct: the week began on Monday 19 Oct.
    expect(clientCards(db, new Date('2026-10-25T18:20:00.000Z')).find((c) => c.code === 'SHA')!.counts.doneThisWeek).toBe(2);
  });

  it('overdue uses the date in India: a deadline of yesterday IST is overdue just after midnight IST', () => {
    const db = seededDb();
    task(db, 1, { deadline: '2026-10-27' });
    expect(clientCards(db, new Date('2026-10-27T18:29:00.000Z')).find((c) => c.code === 'SHA')!.counts.overdue).toBe(0);
    expect(clientCards(db, new Date('2026-10-27T18:31:00.000Z')).find((c) => c.code === 'SHA')!.counts.overdue).toBe(1);
  });

  it('leaves out inactive clients; the group name comes from the live list when given', () => {
    const db = seededDb();
    const desai: ClientConfig = { ...MEHTA, groupId: '120363000000000003@g.us', name: 'Desai Foods', code: 'DES' };
    syncClients(db, [SHARMA, MEHTA, desai]);
    syncClients(db, [SHARMA, MEHTA]);
    const cards = clientCards(db, NOW, new Map([[SHARMA.groupId, 'Sharma x Studio']]));
    expect(cards.map((c) => c.code)).toEqual(['MEH', 'SHA']);
    expect(cards.find((c) => c.code === 'SHA')!.groupName).toBe('Sharma x Studio');
    expect(cards.find((c) => c.code === 'MEH')!.groupName).toBe('Mehta Foods');
  });

  it('sheet names match the tracker: assigned in id order over every client, so a later duplicate gets the suffix', () => {
    const db = seededDb();
    const twin: ClientConfig = { ...MEHTA, groupId: '120363000000000004@g.us', name: 'Sharma Interiors', code: 'SHI' };
    const long: ClientConfig = { ...MEHTA, groupId: '120363000000000005@g.us', name: 'A very long client name: over thirty-one characters', code: 'LON' };
    syncClients(db, [SHARMA, MEHTA, twin, long]);
    const byCode = new Map(clientCards(db, NOW).map((c) => [c.code, c.sheetName]));
    expect(byCode.get('SHA')).toBe('Sharma Interiors');
    expect(byCode.get('SHI')).toBe('Sharma Interiors (2)');
    expect(byCode.get('LON')).toBe('A very long client name over th');
  });
});

describe('clientDetail', () => {
  it('lists open tasks (deadline first), the matched meetings (newest first) and the last sync time; counts match the card', () => {
    const db = world();
    const m1 = meeting(db, 1, 1, 'Sharma weekly', '2026-10-20T06:00:00.000Z');
    const m2 = meeting(db, 2, 1, 'Sharma design review', '2026-10-27T06:00:00.000Z');
    meeting(db, 3, 2, 'Mehta call', '2026-10-27T07:00:00.000Z');
    meeting(db, 4, null, 'Unassigned call', '2026-10-27T08:00:00.000Z');
    const b1 = startBatch(db, 1, 3, '2026-10-27T09:00:00.000Z');
    finishBatch(db, b1, { status: 'ok', errorCode: null, accepted: 1, rejected: 0, at: '2026-10-27T09:00:30.000Z' });
    const b2 = startBatch(db, 1, 2, '2026-10-28T05:00:00.000Z');
    finishBatch(db, b2, { status: 'ok', errorCode: null, accepted: 1, rejected: 0, at: '2026-10-28T05:00:40.000Z' });
    startBatch(db, 2, 1, '2026-10-28T05:30:00.000Z');

    const d = clientDetail(db, 'SHA', NOW)!;
    const card = clientCards(db, NOW).find((c) => c.code === 'SHA')!;
    expect(d.counts).toEqual(card.counts);
    expect(d.openTasks).toHaveLength(d.counts.open);
    expect(d.openTasks.filter((t) => t.status === 'maybe_done')).toHaveLength(d.counts.review);
    expect(d.openTasks).toEqual([
      { code: 'SHA-003', title: 'In review, overdue', assignedTo: null, deadline: '2026-10-20', status: 'maybe_done' },
      { code: 'SHA-001', title: 'Overdue open', assignedTo: 'Ravi', deadline: '2026-10-27', status: 'open' },
      { code: 'SHA-002', title: 'Due today', assignedTo: null, deadline: '2026-10-28', status: 'open' },
    ]);
    expect(d.meetings).toEqual([
      { id: m2, startedAt: '2026-10-27T06:00:00.000Z', title: 'Sharma design review', status: 'queued' },
      { id: m1, startedAt: '2026-10-20T06:00:00.000Z', title: 'Sharma weekly', status: 'queued' },
    ]);
    expect(d.lastSyncAt).toBe('2026-10-28T05:00:40.000Z');
    expect(d).toMatchObject({ code: 'SHA', name: 'Sharma Interiors', sheetName: card.sheetName, lastActivity: card.lastActivity });
    // A batch still running gives its start time.
    expect(clientDetail(db, 'MEH', NOW)!.lastSyncAt).toBe('2026-10-28T05:30:00.000Z');
  });

  it('no batch gives no sync time; an unknown or inactive code gives null', () => {
    const db = seededDb();
    expect(clientDetail(db, 'SHA', NOW)!.lastSyncAt).toBeNull();
    expect(clientDetail(db, 'ZZZ', NOW)).toBeNull();
    syncClients(db, [MEHTA]);
    expect(clientDetail(db, 'SHA', NOW)).toBeNull();
  });

  it('the last sync time ignores failed batches', () => {
    const db = seededDb();
    const ok = startBatch(db, 1, 2, '2026-10-27T09:00:00.000Z');
    finishBatch(db, ok, { status: 'ok', errorCode: null, accepted: 1, rejected: 0, at: '2026-10-27T09:00:30.000Z' });
    const bad = startBatch(db, 1, 2, '2026-10-28T05:00:00.000Z');
    finishBatch(db, bad, { status: 'failed', errorCode: 'ai_error', accepted: null, rejected: null, at: '2026-10-28T05:00:10.000Z' });
    expect(clientDetail(db, 'SHA', NOW)!.lastSyncAt).toBe('2026-10-27T09:00:30.000Z');
    const onlyFailed = startBatch(db, 2, 1, '2026-10-28T05:00:00.000Z');
    finishBatch(db, onlyFailed, { status: 'failed', errorCode: 'ai_error', accepted: null, rejected: null, at: '2026-10-28T05:00:10.000Z' });
    expect(clientDetail(db, 'MEH', NOW)!.lastSyncAt).toBeNull();
  });

  it(`lists at most MEETINGS_LIMIT (${MEETINGS_LIMIT}) meetings, the newest`, () => {
    expect(MEETINGS_LIMIT).toBe(50);
    const db = seededDb();
    const ids = Array.from({ length: 51 }, (_, i) => meeting(db, i + 1, 1, `Call ${i}`, new Date(Date.parse('2026-09-01T06:00:00.000Z') + i * 86_400_000).toISOString()));
    const d = clientDetail(db, 'SHA', NOW)!;
    expect(d.meetings).toHaveLength(50);
    expect(d.meetings[0]!.id).toBe(ids[50]);
    expect(d.meetings.map((m) => m.id)).not.toContain(ids[0]);
  });

  it('never carries message text, quotes, progress notes, attendees or participant names', () => {
    const db = world();
    meeting(db, 1, 1, 'Sharma weekly', '2026-10-20T06:00:00.000Z');
    const all = JSON.stringify([clientCards(db, NOW), clientDetail(db, 'SHA', NOW)]);
    for (const s of [MESSAGE, QUOTE, 'progress words', 'Attendee Name', 'Participant Name', 'a@client.com', '919800000001']) expect(all).not.toContain(s);
  });
});
