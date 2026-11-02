import { describe, expect, it } from 'vitest';
import type { ClientConfig } from '../../src/config/groups.ts';
import { clientCards, clientDetail, MEETINGS_LIMIT, MESSAGE_CHARS } from '../../src/control/clientQueries.ts';
import { insertMedia } from '../../src/store/media.ts';
import { upsertPerson } from '../../src/store/people.ts';
import { finishBatch, startBatch } from '../../src/store/batches.ts';
import { setPhase, syncClients } from '../../src/store/clients.ts';
import type { Db, Sql } from '../../src/store/db.ts';
import { insertFound } from '../../src/store/meetings.ts';
import { insertMessage } from '../../src/store/messages.ts';
import { createTask, recordEvent, setTaskStatus, type Status } from '../../src/store/tasks.ts';
import { idOf, MEHTA, row, seededDb, SHARMA } from '../helpers/db.ts';

// Wednesday 28 Oct 2026, 11:30 IST: today is 2026-10-28 and the week started on Monday 2026-10-26.
const NOW = new Date('2026-10-28T06:00:00.000Z');
const QUOTE = 'QUOTE-TEXT-never-sent';
const MESSAGE = 'MESSAGE-TEXT-never-sent';

/** A seeded client by its place (1 Sharma, 2 Mehta), as its real id: on Postgres the ids are not 1 and 2. */
const seat = (db: Db, n: number) => idOf(db, n === 1 ? SHARMA.code : MEHTA.code);

async function task(db: Db, clientId: number, o: { title?: string; deadline?: string | null; status?: Status; closedOn?: string; assignedTo?: string | null }) {
  const t = await createTask(
    db,
    {
      clientId: await seat(db, clientId), side: 'us', title: o.title ?? 'A task', category: 'design', priority: 'medium', assignedTo: o.assignedTo ?? null, askedBy: null,
      raisedOn: '2026-10-01', deadline: o.deadline ?? null, latestProgress: 'progress words', sourceQuote: QUOTE, sourceDate: '2026-10-01',
      sourceWaId: 'W1', origin: 'whatsapp',
    },
    '2026-10-01T05:00:00.000Z',
  );
  if (o.status && o.status !== 'open') await setTaskStatus(db, t.id, o.status, o.closedOn ?? '2026-10-27', '2026-10-27T05:00:00.000Z', 'human');
  return t;
}

/** A found meeting for a client's real id (null: unassigned). */
async function putMeeting(q: Sql, n: number, clientId: number | null, title: string, startedAt: string): Promise<number> {
  return (await insertFound(q, {
    recording: `conferenceRecords/c${n}/recordings/r${n}`, conference: `conferenceRecords/c${n}`, driveFileId: `drive${n}`, meetingCode: null, title,
    startedAt, endedAt: null, attendees: [{ email: 'a@client.com', name: 'Attendee Name', team: false }], participants: ['Participant Name'],
    clientId, matchKind: clientId === null ? null : 'title', status: clientId === null ? 'unassigned' : 'queued', driveSeconds: 600,
    createdAt: startedAt,
  }))!;
}

async function meeting(db: Db, n: number, clientId: number | null, title: string, startedAt: string): Promise<number> {
  return putMeeting(db, n, clientId === null ? null : await seat(db, clientId), title, startedAt);
}

async function message(db: Db, clientId: number, waId: string, ts: string) {
  await insertMessage(db, {
    waId, clientId: await seat(db, clientId), senderJid: '919800000001@s.whatsapp.net', senderNumber: '919800000001', senderName: 'Sender', fromMe: false, ts, text: MESSAGE,
    quotedWaId: null, mediaType: null,
  });
}

/** Sharma (1): 3 open (2 overdue, 1 in review), 1 done this week, 1 done last week. Mehta (2): one done task. */
async function world(): Promise<Db> {
  const db = await seededDb();
  await task(db, 1, { title: 'Overdue open', deadline: '2026-10-27', assignedTo: 'Ravi' });
  await task(db, 1, { title: 'Due today', deadline: '2026-10-28' });
  await task(db, 1, { title: 'In review, overdue', deadline: '2026-10-20', status: 'maybe_done' });
  await task(db, 1, { title: 'Done Monday', deadline: '2026-10-01', status: 'done', closedOn: '2026-10-26' });
  await task(db, 1, { title: 'Done Sunday', status: 'done', closedOn: '2026-10-25' });
  await task(db, 2, { title: 'Mehta done', status: 'done', closedOn: '2026-10-28' });
  await message(db, 1, 'M1', '2026-10-27T10:00:00.000Z');
  await message(db, 1, 'M2', '2026-10-28T04:00:00.000Z');
  await message(db, 2, 'M3', '2026-10-20T04:00:00.000Z');
  await setPhase(db, await seat(db, 1), 'Design', 'ai');
  return db;
}

describe('clientCards', () => {
  it('counts open, overdue, review and done this week per active client, with phases, last activity and sheet name', async () => {
    const db = await world();
    const cards = await clientCards(db, NOW);
    expect(cards.map((c) => c.code)).toEqual(['MEH', 'SHA']);
    expect(cards[1]).toEqual({
      code: 'SHA', name: 'Sharma Interiors', groupName: 'Sharma Interiors',
      counts: { open: 3, overdue: 2, review: 1, doneThisWeek: 1 },
      phases: SHARMA.phases, currentPhase: 'Design',
      lastActivity: '2026-10-28T04:00:00.000Z', sheetName: 'Sharma Interiors',
      // seededDb approves the group with the real clock: its earlier messages are waiting to be read.
      history: { state: 'waiting', found: expect.any(Number) },
      pulse: { pending: expect.any(Number), lastReadAt: null, quietMinutes: 4 },
    });
    expect(cards[0]).toMatchObject({ code: 'MEH', counts: { open: 0, overdue: 0, review: 0, doneThisWeek: 1 }, currentPhase: null, lastActivity: '2026-10-20T04:00:00.000Z' });
  });

  it('a client with no tasks or messages has zero counts and no last activity', async () => {
    const cards = await clientCards(await seededDb(), NOW);
    expect(cards.every((c) => c.lastActivity === null && Object.values(c.counts).every((n) => n === 0))).toBe(true);
  });

  it('the week starts on Monday in India, not in UTC', async () => {
    const db = await seededDb();
    await task(db, 1, { status: 'done', closedOn: '2026-10-25' });
    await task(db, 1, { status: 'done', closedOn: '2026-10-26' });
    // 00:10 IST on Monday 26 Oct is still Sunday in UTC.
    expect((await clientCards(db, new Date('2026-10-25T18:40:00.000Z'))).find((c) => c.code === 'SHA')!.counts.doneThisWeek).toBe(1);
    // 23:50 IST on Sunday 25 Oct: the week began on Monday 19 Oct.
    expect((await clientCards(db, new Date('2026-10-25T18:20:00.000Z'))).find((c) => c.code === 'SHA')!.counts.doneThisWeek).toBe(2);
  });

  it('overdue uses the date in India: a deadline of yesterday IST is overdue just after midnight IST', async () => {
    const db = await seededDb();
    await task(db, 1, { deadline: '2026-10-27' });
    expect((await clientCards(db, new Date('2026-10-27T18:29:00.000Z'))).find((c) => c.code === 'SHA')!.counts.overdue).toBe(0);
    expect((await clientCards(db, new Date('2026-10-27T18:31:00.000Z'))).find((c) => c.code === 'SHA')!.counts.overdue).toBe(1);
  });

  it('leaves out inactive clients; the group name comes from the live list when given', async () => {
    const db = await seededDb();
    const desai: ClientConfig = { ...MEHTA, groupId: '120363000000000003@g.us', name: 'Desai Foods', code: 'DES' };
    await syncClients(db, [SHARMA, MEHTA, desai]);
    await syncClients(db, [SHARMA, MEHTA]);
    const cards = await clientCards(db, NOW, new Map([[SHARMA.groupId, 'Sharma x Studio']]));
    expect(cards.map((c) => c.code)).toEqual(['MEH', 'SHA']);
    expect(cards.find((c) => c.code === 'SHA')!.groupName).toBe('Sharma x Studio');
    expect(cards.find((c) => c.code === 'MEH')!.groupName).toBe('Mehta Foods');
  });

  it('sheet names match the tracker: assigned in id order over every client, so a later duplicate gets the suffix', async () => {
    const db = await seededDb();
    const twin: ClientConfig = { ...MEHTA, groupId: '120363000000000004@g.us', name: 'Sharma Interiors', code: 'SHI' };
    const long: ClientConfig = { ...MEHTA, groupId: '120363000000000005@g.us', name: 'A very long client name: over thirty-one characters', code: 'LON' };
    await syncClients(db, [SHARMA, MEHTA, twin, long]);
    const byCode = new Map((await clientCards(db, NOW)).map((c) => [c.code, c.sheetName]));
    expect(byCode.get('SHA')).toBe('Sharma Interiors');
    expect(byCode.get('SHI')).toBe('Sharma Interiors (2)');
    expect(byCode.get('LON')).toBe('A very long client name over th');
  });
});

describe('clientDetail', () => {
  it('lists open tasks (deadline first), the matched meetings (newest first) and the last sync time; counts match the card', async () => {
    const db = await world();
    const m1 = await meeting(db, 1, 1, 'Sharma weekly', '2026-10-20T06:00:00.000Z');
    const m2 = await meeting(db, 2, 1, 'Sharma design review', '2026-10-27T06:00:00.000Z');
    await meeting(db, 3, 2, 'Mehta call', '2026-10-27T07:00:00.000Z');
    await meeting(db, 4, null, 'Unassigned call', '2026-10-27T08:00:00.000Z');
    const b1 = await startBatch(db, await seat(db, 1), 3, '2026-10-27T09:00:00.000Z');
    await finishBatch(db, b1, { status: 'ok', errorCode: null, accepted: 1, rejected: 0, at: '2026-10-27T09:00:30.000Z' });
    const b2 = await startBatch(db, await seat(db, 1), 2, '2026-10-28T05:00:00.000Z');
    await finishBatch(db, b2, { status: 'ok', errorCode: null, accepted: 1, rejected: 0, at: '2026-10-28T05:00:40.000Z' });
    await startBatch(db, await seat(db, 2), 1, '2026-10-28T05:30:00.000Z');

    const d = (await clientDetail(db, 'SHA', NOW))!;
    const card = (await clientCards(db, NOW)).find((c) => c.code === 'SHA')!;
    expect(d.counts).toEqual(card.counts);
    expect(d.openTasks).toHaveLength(d.counts.open);
    expect(d.openTasks.filter((t) => t.status === 'maybe_done')).toHaveLength(d.counts.review);
    expect(d.openTasks).toEqual([
      { code: 'SHA-003', title: 'In review, overdue', assignedTo: null, deadline: '2026-10-20', status: 'maybe_done', priority: 'medium', sentiment: null },
      { code: 'SHA-001', title: 'Overdue open', assignedTo: 'Ravi', deadline: '2026-10-27', status: 'open', priority: 'medium', sentiment: null },
      { code: 'SHA-002', title: 'Due today', assignedTo: null, deadline: '2026-10-28', status: 'open', priority: 'medium', sentiment: null },
    ]);
    expect(d.meetings).toEqual([
      { id: m2, startedAt: '2026-10-27T06:00:00.000Z', title: 'Sharma design review', status: 'queued' },
      { id: m1, startedAt: '2026-10-20T06:00:00.000Z', title: 'Sharma weekly', status: 'queued' },
    ]);
    expect(d.lastSyncAt).toBe('2026-10-28T05:00:40.000Z');
    expect(d).toMatchObject({ code: 'SHA', name: 'Sharma Interiors', sheetName: card.sheetName, lastActivity: card.lastActivity });
    // A batch still running gives its start time.
    expect((await clientDetail(db, 'MEH', NOW))!.lastSyncAt).toBe('2026-10-28T05:30:00.000Z');
  });

  it('no batch gives no sync time; an unknown or inactive code gives null', async () => {
    const db = await seededDb();
    expect((await clientDetail(db, 'SHA', NOW))!.lastSyncAt).toBeNull();
    expect(await clientDetail(db, 'ZZZ', NOW)).toBeNull();
    await syncClients(db, [MEHTA]);
    expect(await clientDetail(db, 'SHA', NOW)).toBeNull();
  });

  it('the last sync time ignores failed batches', async () => {
    const db = await seededDb();
    const ok = await startBatch(db, await seat(db, 1), 2, '2026-10-27T09:00:00.000Z');
    await finishBatch(db, ok, { status: 'ok', errorCode: null, accepted: 1, rejected: 0, at: '2026-10-27T09:00:30.000Z' });
    const bad = await startBatch(db, await seat(db, 1), 2, '2026-10-28T05:00:00.000Z');
    await finishBatch(db, bad, { status: 'failed', errorCode: 'ai_error', accepted: null, rejected: null, at: '2026-10-28T05:00:10.000Z' });
    expect((await clientDetail(db, 'SHA', NOW))!.lastSyncAt).toBe('2026-10-27T09:00:30.000Z');
    const onlyFailed = await startBatch(db, await seat(db, 2), 1, '2026-10-28T05:00:00.000Z');
    await finishBatch(db, onlyFailed, { status: 'failed', errorCode: 'ai_error', accepted: null, rejected: null, at: '2026-10-28T05:00:10.000Z' });
    expect((await clientDetail(db, 'MEH', NOW))!.lastSyncAt).toBeNull();
  });

  it(`lists at most MEETINGS_LIMIT (${MEETINGS_LIMIT}) meetings, the newest`, async () => {
    expect(MEETINGS_LIMIT).toBe(50);
    const db = await seededDb();
    // One id lookup and one transaction for the 51, not one of each per meeting (slow on Postgres).
    const sha = await seat(db, 1);
    const ids = await db.tx(async (q) => {
      const out: number[] = [];
      for (let i = 0; i < 51; i++) out.push(await putMeeting(q, i + 1, sha, `Call ${i}`, new Date(Date.parse('2026-09-01T06:00:00.000Z') + i * 86_400_000).toISOString()));
      return out;
    });
    const d = (await clientDetail(db, 'SHA', NOW))!;
    expect(d.meetings).toHaveLength(50);
    expect(d.meetings[0]!.id).toBe(ids[50]);
    expect(d.meetings.map((m) => m.id)).not.toContain(ids[0]);
  });

  it('never carries quotes, progress notes, attendees, participant names or a phone number; cards carry no message text', async () => {
    const db = await world();
    await meeting(db, 1, 1, 'Sharma weekly', '2026-10-20T06:00:00.000Z');
    const all = JSON.stringify([await clientCards(db, NOW), await clientDetail(db, 'SHA', NOW)]);
    for (const s of [QUOTE, 'progress words', 'Attendee Name', 'Participant Name', 'a@client.com', '919800000001', '@s.whatsapp.net']) expect(all).not.toContain(s);
    expect(JSON.stringify(await clientCards(db, NOW))).not.toContain(MESSAGE);
  });
});

describe('the client drawer: what the agent has seen (owner decision, 28 Oct 2026)', () => {
  const JID = (n: number) => `9198000000${String(n).padStart(2, '0')}@s.whatsapp.net`;
  async function say(db: Db, n: number, ts: string, o: { text?: string | null; person?: number; fromMe?: boolean; media?: 'image' | 'voice' | 'document'; mediaType?: string } = {}) {
    const person = o.person ?? 1;
    await insertMessage(db, {
      waId: `D${n}`, clientId: await seat(db, 1), senderJid: JID(person), senderNumber: `9198000000${String(person).padStart(2, '0')}`, senderName: 'Push Name',
      fromMe: o.fromMe ?? false, ts, text: o.text === undefined ? `message ${n}` : o.text, quotedWaId: null, mediaType: o.media ?? o.mediaType ?? null,
    });
    const id = (await row<{ id: number }>(db, 'SELECT id FROM messages WHERE wa_id = ?', [`D${n}`]))!.id;
    if (o.media) {
      await insertMedia(db, { messageId: id, clientId: await seat(db, 1), kind: o.media, status: 'done', mimeType: null, fileName: 'secret-file-name.pdf', fileSize: 10,
        seconds: o.media === 'voice' ? 42 : null, forwarded: false, refEnc: null, errorCode: null, createdAt: ts });
      if (o.media === 'voice') await db.run("UPDATE media SET text = 'TRANSCRIPT-never-sent', text_kind = 'extract' WHERE message_id = ?", [id]);
    }
    return id;
  }

  it('counts the last 7 days, names senders from the people table, and shows the last 3 messages as one line each', async () => {
    const db = await seededDb();
    await upsertPerson(db, { clientId: await seat(db, 1), jid: JID(1), number: '919800000001', name: 'Rahul', fromMe: false });
    await upsertPerson(db, { clientId: await seat(db, 1), jid: JID(2), number: '919800000002', name: '+91 98000 00002', fromMe: false });
    await say(db, 1, '2026-10-19T06:00:00.000Z'); // older than 7 days: not counted
    await say(db, 2, '2026-10-27T06:00:00.000Z', { person: 1 });
    await say(db, 3, '2026-10-27T07:00:00.000Z', { person: 2, media: 'image', text: null });
    await say(db, 4, '2026-10-27T08:00:00.000Z', { person: 3, media: 'voice', text: null });
    await say(db, 5, '2026-10-28T05:00:00.000Z', { person: 1, text: `Line one\nline two ${'x'.repeat(300)}` });
    await say(db, 6, '2026-10-28T05:30:00.000Z', { fromMe: true, person: 9, text: 'from the founder' });
    await db.run("UPDATE messages SET revoked = 1 WHERE wa_id = 'D6'");
    const a = (await clientDetail(db, 'SHA', NOW))!.activity;
    expect(a.week).toEqual({ messages: 4, people: 3, files: 1, voice: 1 });
    expect(a.latest.map((m) => [m.sender, m.kind])).toEqual([['Rahul', 'text'], ['Someone', 'voice'], ['Someone', 'image']]);
    expect(a.latest[0]!.text.startsWith('Line one line two x')).toBe(true);
    expect(Array.from(a.latest[0]!.text)).toHaveLength(MESSAGE_CHARS);
    expect(a.latest[0]!.text.endsWith('…')).toBe(true);
    expect(a.latest[1]).toMatchObject({ kind: 'voice', seconds: 42, transcribed: true, text: '' });
    const all = JSON.stringify(a);
    for (const s of ['919800000', '@s.whatsapp.net', 'Push Name', 'TRANSCRIPT-never-sent', 'secret-file-name', 'from the founder']) expect(all).not.toContain(s);
  });

  it('pending messages, the last batch (messages read, task changes), and the approval and history state', async () => {
    const db = await seededDb();
    await say(db, 1, '2026-10-28T05:00:00.000Z');
    await say(db, 2, '2026-10-28T05:10:00.000Z');
    await db.run("UPDATE messages SET processed_at = '2026-10-28T05:20:00.000Z' WHERE wa_id = 'D1'");
    const b = await startBatch(db, await seat(db, 1), 6, '2026-10-28T05:19:00.000Z');
    // Three accepted ops: two on tasks, one a decision (no task): two task changes.
    await finishBatch(db, b, { status: 'ok', errorCode: null, accepted: 3, rejected: 0, at: '2026-10-28T05:20:00.000Z' });
    const t = await task(db, 1, {});
    for (const op of ['create_task', 'update_task']) await recordEvent(db, { taskId: t.id, clientId: await seat(db, 1), actor: 'ai', op, detail: {}, reason: null, sourceIds: [], at: '2026-10-28T05:20:00.000Z' });
    await recordEvent(db, { taskId: null, clientId: await seat(db, 1), actor: 'ai', op: 'add_decision', detail: {}, reason: null, sourceIds: [], at: '2026-10-28T05:20:00.000Z' });
    const failed = await startBatch(db, await seat(db, 1), 1, '2026-10-28T05:40:00.000Z');
    await finishBatch(db, failed, { status: 'failed', errorCode: 'x', accepted: null, rejected: null, at: '2026-10-28T05:41:00.000Z' });
    const a = (await clientDetail(db, 'SHA', NOW, undefined, 5))!.activity;
    expect(a.pending).toBe(1);
    expect(a.quietMinutes).toBe(5);
    expect(a.lastBatch).toEqual({ at: '2026-10-28T05:20:00.000Z', messages: 6, taskChanges: 2 });
    expect(a.history).toMatchObject({ state: 'waiting' });
    expect(a.taskCount).toBe(1);
    expect(a.approvedAt).toEqual(expect.any(String));
    const card = (await clientCards(db, NOW, undefined, 5)).find((c) => c.code === 'SHA')!;
    expect(card.pulse).toEqual({ pending: 1, lastReadAt: '2026-10-28T05:20:00.000Z', quietMinutes: 5 });
  });

  it('keeps emoji sequences and Indic conjuncts whole, cuts by grapheme, and never shows a number hidden in a name', async () => {
    const db = await seededDb();
    await upsertPerson(db, { clientId: await seat(db, 1), jid: JID(1), number: null, name: '\u202A+91 98765 43210\u202C', fromMe: false });
    await upsertPerson(db, { clientId: await seat(db, 1), jid: JID(2), number: null, name: 'Ramesh Plumber 9876543210', fromMe: false });
    await upsertPerson(db, { clientId: await seat(db, 1), jid: JID(3), number: null, name: 'Kavya 👩‍💻', fromMe: false });
    const family = '👨‍👩‍👧';
    await say(db, 1, '2026-10-28T05:00:00.000Z', { person: 1, text: `ok ${family} क्‍ष` });
    await say(db, 2, '2026-10-28T05:01:00.000Z', { person: 2, text: family.repeat(200) });
    await say(db, 3, '2026-10-28T05:02:00.000Z', { person: 3, text: null, mediaType: 'location' });
    const [loc, long, short] = (await clientDetail(db, 'SHA', NOW))!.activity.latest;
    expect(loc).toMatchObject({ sender: 'Kavya 👩‍💻', kind: 'location', text: '' });
    expect(long!.sender).toBe('Someone');
    expect(short!.sender).toBe('Someone');
    expect(short!.text).toBe(`ok ${family} क्‍ष`);
    expect(long!.text).toBe(`${family.repeat(MESSAGE_CHARS - 1)}…`);
    expect(JSON.stringify(await clientDetail(db, 'SHA', NOW))).not.toMatch(/98765|9876543210/);
  });

  it('a group with no messages: zero numbers, nothing latest, no last batch', async () => {
    const a = (await clientDetail(await seededDb(), 'MEH', NOW))!.activity;
    expect(a).toMatchObject({ pending: 0, lastBatch: null, week: { messages: 0, people: 0, files: 0, voice: 0 }, latest: [] });
  });
});
