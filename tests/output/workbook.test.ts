import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { loadTrackerView } from '../../src/output/view.ts';
import { buildWorkbook } from '../../src/output/workbook.ts';
import { syncClients, setStatus } from '../../src/store/clients.ts';
import { upsertPerson } from '../../src/store/people.ts';
import { addDecision, createTask, logReminder, setTaskStatus, type NewTask } from '../../src/store/tasks.ts';
import { openDb } from '../../src/store/db.ts';
import type { ClientConfig } from '../../src/config/groups.ts';
import { MEHTA, NOW, seededDb, SHARMA } from '../helpers/db.ts';

const task = (o: Partial<NewTask> = {}): NewTask => ({
  clientId: 1, side: 'us', title: 'Revise homepage banner', category: 'design', priority: 'high', assignedTo: 'Rahul', askedBy: 'Mr. Sharma',
  raisedOn: '2026-10-10', deadline: '2026-10-18', latestProgress: 'v2 shared 15 Oct', sourceQuote: 'banner thoda bright karo', sourceDate: '2026-10-10',
  sourceWaId: 'm1', origin: 'whatsapp', ...o,
});

function fixture() {
  const db = seededDb();
  const a = createTask(db, task(), NOW);
  logReminder(db, a.id, '2026-10-13', NOW);
  logReminder(db, a.id, '2026-10-17', NOW);
  createTask(db, task({ side: 'client', title: 'Send logo files', category: 'content', deadline: '2026-10-22' }), NOW);
  const done = createTask(db, task({ title: 'Share moodboard', deadline: null }), NOW);
  setTaskStatus(db, done.id, 'done', '2026-10-15', NOW, 'ai');
  setStatus(db, 1, 'Homepage approved, building inner pages', NOW);
  return db;
}

async function load(buf: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
  return wb;
}

function findRow(ws: ExcelJS.Worksheet, firstCell: string): ExcelJS.Row {
  let found: ExcelJS.Row | undefined;
  ws.eachRow((row) => {
    if (!found && row.getCell(1).value === firstCell) found = row;
  });
  if (!found) throw new Error(`row ${firstCell} not found`);
  return found;
}

const healthy = { ok: true, text: '✅ Connected · waiting for new messages' };
const now = new Date('2026-10-19T08:00:00Z');

describe('loadTrackerView', () => {
  it('computes counts, % done, overdue and next deadline', () => {
    const sharma = loadTrackerView(fixture(), now, healthy).clients.find((c) => c.client.code === 'SHA')!;
    expect(sharma).toMatchObject({ percentDone: 33, overdue: 1, maybeDone: 0, nextDeadline: '2026-10-18', sheetName: 'Sharma Interiors' });
    expect(sharma.usOpen.map((t) => t.code)).toEqual(['SHA-001']);
    expect(sharma.clientOpen.map((t) => t.code)).toEqual(['SHA-002']);
    expect(sharma.done.map((t) => t.code)).toEqual(['SHA-003']);
  });
});

describe('buildWorkbook', () => {
  it('has an Overview tab and one tab per client', async () => {
    const wb = await load(await buildWorkbook(loadTrackerView(fixture(), now, healthy)));
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Overview', 'Mehta Foods', 'Sharma Interiors']);
  });

  it('writes the health line and a linked summary row per client', async () => {
    const ov = (await load(await buildWorkbook(loadTrackerView(fixture(), now, healthy)))).getWorksheet('Overview')!;
    expect(ov.getCell('A1').value).toBe('✅ Connected · waiting for new messages');
    expect(ov.getCell('A3').value).toBe('Client');
    expect(ov.getCell('H3').value).toBe('Where we are');
    expect(JSON.stringify(ov.getCell('A5').value)).toContain("Sharma Interiors'!A1");
    expect(ov.getCell('D5').value).toBe(1);
    expect(ov.getCell('F5').value).toBe(1);
    expect(ov.getCell('H5').value).toBe('Homepage approved, building inner pages');
    expect(ov.getCell('I5').value).toEqual(new Date(Date.UTC(2026, 9, 18)));
    expect(ov.getCell('I5').numFmt).toBe('d mmm yyyy');
    expect(ov.getCell('C5').value).toBe(0.33);
    expect(ov.getCell('C5').numFmt).toBe('0%');
  });

  it('lists tasks with India dates, reminders, status and colour', async () => {
    const ws = (await load(await buildWorkbook(loadTrackerView(fixture(), now, healthy)))).getWorksheet('Sharma Interiors')!;
    const row = findRow(ws, 'SHA-001');
    expect(row.getCell(2).value).toBe('Revise homepage banner');
    expect(row.getCell(3).value).toBe('Design');
    expect(row.getCell(7).value).toEqual(new Date(Date.UTC(2026, 9, 10)));
    expect(row.getCell(8).value).toEqual(new Date(Date.UTC(2026, 9, 18)));
    expect(row.getCell(8).numFmt).toBe('d mmm yyyy');
    expect(row.getCell(9).value).toBe(9);
    expect(row.getCell(11).value).toBe('2 (last 17 Oct)');
    expect(row.getCell(12).value).toBe('Open');
    expect(row.getCell(13).value).toBe('"banner thoda bright karo" (10 Oct)');
    expect((row.getCell(1).fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FFFFD9D2');
    expect((findRow(ws, 'SHA-003').getCell(1).fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FFD8F5DD');
    expect(findRow(ws, 'Our pending tasks')).toBeDefined();
  });

  it('shows (none) in empty sections and marks inactive clients', async () => {
    const db = fixture();
    syncClients(db, [SHARMA]);
    const wb = await load(await buildWorkbook(loadTrackerView(db, now, healthy)));
    expect(wb.getWorksheet('Overview')!.getCell('A4').text).toBe(`${MEHTA.name} (inactive)`);
    expect(findRow(wb.getWorksheet('Mehta Foods')!, '(none)')).toBeDefined();
  });

  it('keeps chat-derived text as plain strings, never formulas', async () => {
    const db = seededDb();
    createTask(db, task({ title: '=1+1', latestProgress: '+cmd', sourceQuote: '=HYPERLINK("http://x")' }), NOW);
    const ws = (await load(await buildWorkbook(loadTrackerView(db, now, healthy)))).getWorksheet('Sharma Interiors')!;
    const row = findRow(ws, 'SHA-001');
    const cell = row.getCell(2);
    expect(cell.type).toBe(ExcelJS.ValueType.String);
    expect(cell.value).toBe('=1+1');
    expect(cell.formula).toBeUndefined();
    expect(row.getCell(10).type).toBe(ExcelJS.ValueType.String);
    expect(row.getCell(13).type).toBe(ExcelJS.ValueType.String);
  });
});
