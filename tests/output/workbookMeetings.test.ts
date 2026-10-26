import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import type { MeetingSummary } from '../../src/brain/meetingSchema.ts';
import { CLIENT_MEETINGS_LIMIT, loadTrackerView, UNASSIGNED_LIMIT } from '../../src/output/view.ts';
import { buildWorkbook } from '../../src/output/workbook.ts';
import type { Db } from '../../src/store/db.ts';
import { advanceStage, finishMeeting, insertFound, type MeetingStatus } from '../../src/store/meetings.ts';
import { addDecision } from '../../src/store/tasks.ts';
import { NOW, seededDb } from '../helpers/db.ts';

const now = new Date('2026-10-26T08:00:00Z');
const healthy = { ok: true, text: '✅ Connected · waiting for new messages' };
const HINT = 'On the office PC: npm run cli -- meeting list, then meeting assign <id> <CODE>';

function summary(actionItems: number): MeetingSummary {
  return {
    whatHappened: 'We met.',
    discussion: [],
    decisions: [],
    actionItems: Array.from({ length: actionItems }, (_, i) => ({ side: 'us' as const, task: `Task ${i}`, owner: 'Rahul', deadline: null, segmentIds: ['s1'] })),
    openQuestions: [],
    conclusion: '',
    speakers: [],
  };
}

function found(db: Db, o: { startedAt: string; status: MeetingStatus; title?: string; clientId?: number | null; seconds?: number | null }): number {
  return insertFound(db, {
    recording: `conferenceRecords/c/recordings/${o.startedAt}-${o.status}-${Math.random()}`, conference: 'conferenceRecords/c', driveFileId: 'file1',
    meetingCode: null, title: o.title ?? 'Sharma weekly', startedAt: o.startedAt, endedAt: null, attendees: [], participants: [],
    clientId: o.clientId === undefined ? 1 : o.clientId, matchKind: o.clientId === null ? null : 'title', status: o.status,
    driveSeconds: o.seconds === undefined ? 2820 : o.seconds, createdAt: NOW,
  })!;
}

/** A done meeting of a client, with a Doc and this many action items. */
function done(db: Db, o: { startedAt: string; title?: string; clientId?: number; seconds?: number | null; docFileId?: string; actionItems?: number }): number {
  const id = found(db, { ...o, status: 'queued' });
  advanceStage(db, id, 'doc', { summary: summary(o.actionItems ?? 2), docFileId: o.docFileId ?? 'doc1' }, NOW);
  finishMeeting(db, id, { at: NOW });
  return id;
}

async function book(db: Db): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await buildWorkbook(loadTrackerView(db, now, healthy))) as unknown as ExcelJS.Buffer);
  return wb;
}

function rowWhere(ws: ExcelJS.Worksheet, pred: (r: ExcelJS.Row) => boolean): ExcelJS.Row {
  let found: ExcelJS.Row | undefined;
  ws.eachRow((r) => {
    if (!found && pred(r)) found = r;
  });
  if (!found) throw new Error('row not found');
  return found;
}

const rowOf = (ws: ExcelJS.Worksheet, first: string) => rowWhere(ws, (r) => r.getCell(1).value === first);
const allText = (ws: ExcelJS.Worksheet): string => {
  const out: string[] = [];
  ws.eachRow((r) => r.eachCell((c) => void out.push(c.text)));
  return out.join('\n');
};
const sharma = (db: Db) => loadTrackerView(db, now, healthy).clients.find((c) => c.client.code === 'SHA')!;

describe('meetings in the view', () => {
  it('lists a client’s done meetings newest first, with IST date, title, length, Doc id and action items', () => {
    const db = seededDb();
    const a = done(db, { startedAt: '2026-10-20T19:00:00.000Z', title: 'Kickoff', seconds: 3725, docFileId: 'docA', actionItems: 3 });
    const b = done(db, { startedAt: '2026-10-22T06:00:00.000Z', title: 'Review', seconds: null, docFileId: 'docB', actionItems: 0 });
    found(db, { startedAt: '2026-10-23T06:00:00.000Z', status: 'queued' });
    done(db, { startedAt: '2026-10-24T06:00:00.000Z', clientId: 2 });
    expect(sharma(db).meetings).toEqual([
      { id: b, date: '2026-10-22', title: 'Review', seconds: null, docFileId: 'docB', actionItemCount: 0 },
      // 19:00 UTC on the 20th is 00:30 IST on the 21st.
      { id: a, date: '2026-10-21', title: 'Kickoff', seconds: 3725, docFileId: 'docA', actionItemCount: 3 },
    ]);
    expect(sharma(db).lastMeeting).toBe('2026-10-22');
    const mehta = loadTrackerView(db, now, healthy).clients.find((c) => c.client.code === 'MEH')!;
    expect(mehta.meetings).toHaveLength(1);
  });

  it('gives no meetings and no last meeting to a client without done meetings', () => {
    const db = seededDb();
    found(db, { startedAt: '2026-10-23T06:00:00.000Z', status: 'failed' });
    expect(sharma(db)).toMatchObject({ meetings: [], lastMeeting: null });
  });

  it('shows at most CLIENT_MEETINGS_LIMIT meetings', () => {
    const db = seededDb();
    for (let i = 0; i <= CLIENT_MEETINGS_LIMIT; i++) done(db, { startedAt: new Date(Date.UTC(2026, 5, 1) + i * 86_400_000).toISOString() });
    expect(CLIENT_MEETINGS_LIMIT).toBe(100);
    expect(sharma(db).meetings).toHaveLength(100);
  });

  it('lists unassigned meetings by id, IST date and length only, never internal ones, at most UNASSIGNED_LIMIT', () => {
    const db = seededDb();
    const u = found(db, { startedAt: '2026-10-23T06:00:00.000Z', status: 'unassigned', title: 'Secret pitch', clientId: null, seconds: 47 });
    found(db, { startedAt: '2026-10-24T06:00:00.000Z', status: 'internal', title: '', clientId: null });
    const view = loadTrackerView(db, now, healthy);
    expect(view.unassigned).toEqual([{ id: u, date: '2026-10-23', seconds: 47 }]);
    for (let i = 0; i < UNASSIGNED_LIMIT; i++) found(db, { startedAt: new Date(Date.UTC(2026, 6, 1) + i * 86_400_000).toISOString(), status: 'unassigned', clientId: null });
    expect(UNASSIGNED_LIMIT).toBe(50);
    expect(loadTrackerView(db, now, healthy).unassigned).toHaveLength(50);
  });
});

describe('Overview', () => {
  it('adds an 11th column, Last meeting, with the date or blank, and no block when nothing is unassigned', async () => {
    const db = seededDb();
    done(db, { startedAt: '2026-10-22T06:00:00.000Z' });
    found(db, { startedAt: '2026-10-24T06:00:00.000Z', status: 'internal', title: '', clientId: null });
    const ov = (await book(db)).getWorksheet('Overview')!;
    expect(ov.getCell('A3').value).toBe('Client');
    expect(ov.getCell('K3').value).toBe('Last meeting');
    expect(ov.getCell('L3').value).toBeNull();
    // Mehta Foods is row 4, Sharma Interiors row 5.
    expect(ov.getCell('K4').value).toBe('');
    expect(ov.getCell('K5').value).toEqual(new Date(Date.UTC(2026, 9, 22)));
    expect(ov.getCell('K5').numFmt).toBe('d mmm yyyy');
    expect(allText(ov)).not.toContain('Unassigned');
    expect(ov.views[0]).toMatchObject({ state: 'frozen', ySplit: 3 });
  });

  it('shows an Unassigned meetings block under the health line: id, IST short date and length, no titles', async () => {
    const db = seededDb();
    const a = found(db, { startedAt: '2026-10-23T06:00:00.000Z', status: 'unassigned', title: 'Secret pitch to Acme', clientId: null, seconds: 47 });
    const b = found(db, { startedAt: '2026-10-24T18:45:00.000Z', status: 'unassigned', title: 'Another secret', clientId: null, seconds: 3725 });
    const c = found(db, { startedAt: '2026-10-25T06:00:00.000Z', status: 'unassigned', title: 'Third secret', clientId: null, seconds: null });
    const ov = (await book(db)).getWorksheet('Overview')!;
    expect(ov.getCell('A1').value).toBe(healthy.text);
    expect(ov.getCell('A2').value).toBe('Unassigned meetings');
    expect(ov.getCell('A3').value).toBe(`#${c} · 25 Oct`);
    // 18:45 UTC on the 24th is 00:15 IST on the 25th.
    expect(ov.getCell('A4').value).toBe(`#${b} · 25 Oct · 1:02:05`);
    expect(ov.getCell('A5').value).toBe(`#${a} · 23 Oct · 0:47`);
    expect(ov.getCell('A6').value).toBe(HINT);
    // Up to 50 rows could fill the screen if frozen, so with the block nothing is frozen.
    expect((ov.views ?? []).some((v) => v.state === 'frozen')).toBe(false);
    const header = rowOf(ov, 'Client');
    expect(header.getCell(11).value).toBe('Last meeting');
    expect(ov.getRow(header.number + 1).getCell(1).text).toBe('Mehta Foods');
    expect(ov.getRow(header.number - 1).getCell(1).text).toMatch(/^Built /);
    const text = allText(ov);
    expect(text).not.toContain('secret');
    expect(text).not.toContain('Secret');
  });

  it('keeps the unassigned rows as plain text', async () => {
    const db = seededDb();
    found(db, { startedAt: '2026-10-23T06:00:00.000Z', status: 'unassigned', clientId: null, seconds: 47 });
    const ov = (await book(db)).getWorksheet('Overview')!;
    expect(ov.getCell('A3').type).toBe(ExcelJS.ValueType.String);
    expect(ov.getCell('A3').formula).toBeUndefined();
  });
});

describe('Meetings section on the client tab', () => {
  it('comes after Done and before People, with date, title, length, action items and a Doc link', async () => {
    const db = seededDb();
    done(db, { startedAt: '2026-10-20T06:00:00.000Z', title: 'Kickoff', seconds: 3725, docFileId: 'docA_1-x', actionItems: 3 });
    done(db, { startedAt: '2026-10-22T06:00:00.000Z', title: '=HYPERLINK("http://evil")', seconds: 47, docFileId: 'docB', actionItems: 0 });
    const ws = (await book(db)).getWorksheet('Sharma Interiors')!;
    const doneAt = rowOf(ws, 'Done').number;
    const title = rowOf(ws, 'Meetings').number;
    expect(title).toBeGreaterThan(doneAt);
    expect(title).toBeLessThan(rowOf(ws, 'People').number);
    expect(ws.getRow(title + 1).values).toEqual([, 'Date', 'Meeting', 'Length', 'Action items', 'Doc']);
    const first = ws.getRow(title + 2);
    expect(first.getCell(1).value).toEqual(new Date(Date.UTC(2026, 9, 22)));
    expect(first.getCell(1).numFmt).toBe('d mmm yyyy');
    expect(first.getCell(2).value).toBe('=HYPERLINK("http://evil")');
    expect(first.getCell(2).type).toBe(ExcelJS.ValueType.String);
    expect(first.getCell(2).formula).toBeUndefined();
    expect(first.getCell(3).value).toBe('0:47');
    expect(first.getCell(4).value).toBe(0);
    expect(first.getCell(5).value).toEqual({ text: 'Open', hyperlink: 'https://docs.google.com/document/d/docB/edit' });
    const second = ws.getRow(title + 3);
    expect(second.getCell(2).value).toBe('Kickoff');
    expect(second.getCell(3).value).toBe('1:02:05');
    expect(second.getCell(4).value).toBe(3);
    expect(second.getCell(5).value).toEqual({ text: 'Open', hyperlink: 'https://docs.google.com/document/d/docA_1-x/edit' });
  });

  it('shows (none) for a client without meetings', async () => {
    const ws = (await book(seededDb())).getWorksheet('Sharma Interiors')!;
    expect(ws.getRow(rowOf(ws, 'Meetings').number + 2).getCell(1).value).toBe('(none)');
  });

  it('does not link a Doc id that is not a plain id, or a missing one', async () => {
    const db = seededDb();
    done(db, { startedAt: '2026-10-22T06:00:00.000Z', docFileId: 'x/../evil?a=1' });
    const ws = (await book(db)).getWorksheet('Sharma Interiors')!;
    const row = ws.getRow(rowOf(ws, 'Meetings').number + 2);
    expect(row.getCell(5).value).toBeNull();
    expect(row.getCell(5).hyperlink).toBeUndefined();
  });

  it('keeps the workbook readable when a meeting title holds characters XML does not allow', async () => {
    const db = seededDb();
    const id = done(db, { startedAt: '2026-10-22T06:00:00.000Z' });
    db.prepare('UPDATE meetings SET title = ? WHERE id = ?').run('Kick￾off\x01 call￿', id);
    const ws = (await book(db)).getWorksheet('Sharma Interiors')!;
    expect(ws.getRow(rowOf(ws, 'Meetings').number + 2).getCell(2).value).toBe('Kickoff call');
  });
});

describe('meeting decisions', () => {
  it('shows Source Meeting linked to the meeting’s Doc, only for a valid Doc id', async () => {
    const db = seededDb();
    const good = done(db, { startedAt: '2026-10-22T06:00:00.000Z', docFileId: 'docGood' });
    const bad = done(db, { startedAt: '2026-10-21T06:00:00.000Z', docFileId: 'bad id' });
    addDecision(db, { clientId: 1, text: 'Blue theme chosen', decidedOn: '2026-10-22', source: 'meeting', sourceWaId: null, meetingId: good }, NOW);
    addDecision(db, { clientId: 1, text: 'Launch on 1 Nov', decidedOn: '2026-10-21', source: 'meeting', sourceWaId: null, meetingId: bad }, NOW);
    addDecision(db, { clientId: 1, text: 'Logo approved', decidedOn: '2026-10-20', source: 'whatsapp', sourceWaId: 'm1' }, NOW);
    const ws = (await book(db)).getWorksheet('Sharma Interiors')!;
    const linked = rowWhere(ws, (r) => r.getCell(2).value === 'Blue theme chosen').getCell(3);
    expect(linked.value).toEqual({ text: 'Meeting', hyperlink: 'https://docs.google.com/document/d/docGood/edit' });
    expect(rowWhere(ws, (r) => r.getCell(2).value === 'Launch on 1 Nov').getCell(3).value).toBe('Meeting');
    expect(rowWhere(ws, (r) => r.getCell(2).value === 'Logo approved').getCell(3).value).toBe('WhatsApp');
  });

  it('puts the meeting’s Doc id on its decisions in the view', () => {
    const db = seededDb();
    const m = done(db, { startedAt: '2026-10-22T06:00:00.000Z', docFileId: 'docGood' });
    addDecision(db, { clientId: 1, text: 'Blue theme chosen', decidedOn: '2026-10-22', source: 'meeting', sourceWaId: null, meetingId: m }, NOW);
    addDecision(db, { clientId: 1, text: 'Logo approved', decidedOn: '2026-10-20', source: 'whatsapp', sourceWaId: 'm1' }, NOW);
    expect(sharma(db).decisions.map((d) => [d.text, d.docFileId])).toEqual([['Blue theme chosen', 'docGood'], ['Logo approved', null]]);
  });
});
