import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import type { ClientConfig } from '../../src/config/groups.ts';
import { loadTrackerView } from '../../src/output/view.ts';
import { buildWorkbook } from '../../src/output/workbook.ts';
import { MAX_TITLE_CHARS } from '../../src/report/morningReport.ts';
import { syncClients } from '../../src/store/clients.ts';
import { openDb, type Db } from '../../src/store/db.ts';
import { createTask, setTaskStatus, type NewTask } from '../../src/store/tasks.ts';
import { MEHTA, NOW, seededDb, SHARMA } from '../helpers/db.ts';

const task = (o: Partial<NewTask> = {}): NewTask => ({
  clientId: 1, side: 'us', title: 'Revise homepage banner', category: 'design', priority: 'medium', assignedTo: 'Rahul', askedBy: 'Mr. Sharma',
  raisedOn: '2026-10-10', deadline: null, latestProgress: null, sourceQuote: null, sourceDate: null, sourceWaId: null, origin: 'whatsapp', ...o,
});

const healthy = { ok: true, text: 'ok' };
/** 13:30 IST on Monday 19 Oct 2026. */
const now = new Date('2026-10-19T08:00:00Z');

async function build(db: Db): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await buildWorkbook(await loadTrackerView(db, now, healthy))) as unknown as ExcelJS.Buffer);
  return wb;
}

const today = async (db: Db) => (await build(db)).getWorksheet('Today')!;

/** Each row's cells A to H as plain values ('' for empty), from row 3 (the first row under the header). */
function body(ws: ExcelJS.Worksheet): unknown[][] {
  const rows: unknown[][] = [];
  for (let r = 3; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    rows.push(Array.from({ length: 8 }, (_, i) => row.getCell(i + 1).value ?? ''));
  }
  return rows;
}

/**
 * Sharma: five open tasks (one on the client side, one maybe done) and one done. Mehta: one open task.
 * Urgency for Sharma: SHA-002 (overdue), SHA-003 (due today), SHA-004 (high, raised 5 Oct), SHA-001 (high, raised 10 Oct), SHA-006.
 */
async function fixture(): Promise<Db> {
  const db = await seededDb();
  createTask(db, task({ title: 'Homepage copy', priority: 'major', deadline: '2026-10-25' }), NOW);
  createTask(db, task({ side: 'client', title: 'Send logo files', priority: 'low', deadline: '2026-10-18' }), NOW);
  createTask(db, task({ title: 'Inner pages', deadline: '2026-10-19' }), NOW);
  createTask(db, task({ title: 'Domain setup', priority: 'major', raisedOn: '2026-10-05' }), NOW);
  const done = createTask(db, task({ title: 'Moodboard', priority: 'major', deadline: '2026-10-01' }), NOW);
  setTaskStatus(db, done.id, 'done', '2026-10-15', NOW, 'ai');
  const maybe = createTask(db, task({ title: 'Contact form' }), NOW);
  setTaskStatus(db, maybe.id, 'maybe_done', '2026-10-15', NOW, 'ai');
  createTask(db, task({ clientId: 2, title: 'Menu photos', priority: 'low' }), NOW);
  return db;
}

const date = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe('Today tab', () => {
  it('is the first sheet, before Overview', async () => {
    const wb = await build(await fixture());
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Today', 'Overview', 'Mehta Foods', 'Sharma Interiors']);
  });

  it('has the title, the header, counts per active client, the top 3 open tasks and a totals row', async () => {
    const ws = await today(await fixture());
    expect(ws.getCell('A1').value).toBe('Today · 19 Oct · built 13:30 IST');
    expect(ws.getRow(2).values).toEqual([undefined, 'Client', 'Open', 'Overdue', 'Side', 'ID', 'Task', 'Deadline', 'Notes']);
    expect(body(ws)).toEqual([
      ['Mehta Foods', 1, 0, '', '', '', '', ''],
      ['', '', '', 'us', 'MEH-001', 'Menu photos', '', ''],
      ['Sharma Interiors', 5, 1, '', '', '', '', ''],
      ['', '', '', 'client', 'SHA-002', 'Send logo files', date('2026-10-18'), 'overdue'],
      ['', '', '', 'us', 'SHA-003', 'Inner pages', date('2026-10-19'), 'due today'],
      ['', '', '', 'us', 'SHA-004', 'Domain setup', '', 'major'],
      ['Total', 6, 1, '', '', '', '', ''],
    ]);
  });

  it('formats deadlines as dates and follows the workbook style', async () => {
    const ws = await today(await fixture());
    expect(ws.getCell('G6').numFmt).toBe('d mmm yyyy');
    expect((ws.getCell('A2').fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FF0D0D0D');
    expect((ws.getCell('H2').fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FF0D0D0D');
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 2 });
    expect(ws.getColumn(6).width).toBeGreaterThanOrEqual(40);
    expect(ws.getCell('A9').font?.bold).toBe(true);
    expect(ws.getCell('A9').border?.top?.style).toBe('thin');
    expect((ws.getCell('C5').fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FFFFD9D2');
    expect((ws.getCell('C3').fill as ExcelJS.FillPattern | undefined)?.fgColor).toBeUndefined();
  });

  it('lists maybe done tasks and all four notes', async () => {
    const db = await seededDb();
    const t = createTask(db, task({ title: 'Launch', priority: 'major', deadline: '2026-10-19' }), NOW);
    setTaskStatus(db, t.id, 'maybe_done', '2026-10-19', NOW, 'ai');
    createTask(db, task({ title: 'Old one', priority: 'major', deadline: '2026-10-02' }), NOW);
    createTask(db, task({ title: 'Later', deadline: '2026-10-25' }), NOW);
    const rows = body(await today(db)).filter((r) => r[4] !== '');
    expect(rows.map((r) => [r[4], r[6], r[7]])).toEqual([
      ['SHA-002', date('2026-10-02'), 'overdue, major'],
      ['SHA-001', date('2026-10-19'), 'due today, major, maybe done'],
      ['SHA-003', date('2026-10-25'), ''],
    ]);
  });

  it('leaves out inactive clients', async () => {
    const db = await fixture();
    syncClients(db, [SHARMA]);
    const ws = await today(db);
    const names = body(ws).map((r) => r[0]).filter((v) => v !== '');
    expect(names).toEqual(['Sharma Interiors', 'Total']);
    expect(body(ws).some((r) => r[4] === 'MEH-001')).toBe(false);
    expect(body(ws).at(-1)).toEqual(['Total', 5, 1, '', '', '', '', '']);
  });

  it('shows a client with no open tasks with zero counts and no task rows', async () => {
    const db = await seededDb();
    const t = createTask(db, task({ clientId: 2 }), NOW);
    setTaskStatus(db, t.id, 'done', '2026-10-15', NOW, 'ai');
    expect(body(await today(db))).toEqual([
      ['Mehta Foods', 0, 0, '', '', '', '', ''],
      ['Sharma Interiors', 0, 0, '', '', '', '', ''],
      ['Total', 0, 0, '', '', '', '', ''],
    ]);
  });

  it('shows (none) and zero totals when there is no active client', async () => {
    const wb = await build(openDb(':memory:'));
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Today', 'Overview']);
    const ws = wb.getWorksheet('Today')!;
    expect(ws.getCell('A2').value).toBe('Client');
    expect(body(ws)).toEqual([
      ['(none)', '', '', '', '', '', '', ''],
      ['Total', 0, 0, '', '', '', '', ''],
    ]);

    const inactive = await seededDb();
    syncClients(inactive, []);
    expect(body(await today(inactive))[0]![0]).toBe('(none)');
  });

  it('cuts long titles like the old message', async () => {
    const db = await seededDb();
    const long = `${'word '.repeat(30)}end`;
    createTask(db, task({ title: long }), NOW);
    const title = body(await today(db)).find((r) => r[4] === 'SHA-001')![5] as string;
    expect(Array.from(title).length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
    expect(title.endsWith('…')).toBe(true);
  });

  it('keeps a title starting with = as text, never a formula', async () => {
    const db = await seededDb();
    createTask(db, task({ title: '=HYPERLINK("http://x","y")' }), NOW);
    createTask(db, task({ title: '+1', priority: 'low' }), NOW);
    const ws = await today(db);
    const first = ws.getCell('F5');
    expect(first.type).toBe(ExcelJS.ValueType.String);
    expect(first.value).toBe('=HYPERLINK("http://x","y")');
    expect(first.formula).toBeUndefined();
    expect(ws.getCell('F6').type).toBe(ExcelJS.ValueType.String);
    expect(ws.getCell('F6').value).toBe('+1');
  });

  it('removes characters XML does not allow from task titles', async () => {
    const db = await seededDb();
    createTask(db, task({ title: 'Kick\x01off\uFFFE' }), NOW);
    const ws = await today(db);
    expect(ws.getCell('F5').value).toBe('Kickoff');
  });

  it('a client named Today gets its own tab next to the Today tab', async () => {
    const db = openDb(':memory:');
    const named = (name: string, code: string): ClientConfig => ({ ...MEHTA, groupId: `${code}@g.us`, name, code });
    syncClients(db, [named('Today', 'TOD')]);
    const wb = await build(db);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Today', 'Overview', 'Today (2)']);
    expect(body(wb.getWorksheet('Today')!)[0]![0]).toBe('Today');
  });
});
