import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import type { ClientConfig } from '../../src/config/groups.ts';
import { loadTrackerView } from '../../src/output/view.ts';
import { buildWorkbook } from '../../src/output/workbook.ts';
import { setPhase, setStatus, syncClients } from '../../src/store/clients.ts';
import { openDb } from '../../src/store/db.ts';
import { upsertPerson } from '../../src/store/people.ts';
import { addDecision, createTask, logReminder, setTaskStatus, type NewTask } from '../../src/store/tasks.ts';
import { NOW, seededDb, SHARMA } from '../helpers/db.ts';

const task = (o: Partial<NewTask> = {}): NewTask => ({
  clientId: 1, side: 'us', title: 'Revise homepage banner', category: 'design', priority: 'high', assignedTo: 'Rahul', askedBy: 'Mr. Sharma',
  raisedOn: '2026-10-10', deadline: '2026-10-18', latestProgress: null, sourceQuote: 'banner thoda bright karo', sourceDate: '2026-10-10',
  sourceWaId: 'm1', origin: 'whatsapp', ...o,
});

const healthy = { ok: true, text: 'ok' };
const now = new Date('2026-10-19T08:00:00Z');

async function build(db: ReturnType<typeof seededDb>): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await buildWorkbook(loadTrackerView(db, now, healthy))) as unknown as ExcelJS.Buffer);
  return wb;
}

function findByCell(ws: ExcelJS.Worksheet, col: number, value: string): ExcelJS.Row {
  let found: ExcelJS.Row | undefined;
  ws.eachRow((row) => {
    if (!found && row.getCell(col).value === value) found = row;
  });
  if (!found) throw new Error(`row with ${value} not found`);
  return found;
}

const cfg = (n: number, name: string): ClientConfig => ({
  groupId: `12036300000000000${n}@g.us`, name, code: `C0${n}`, phases: ['One', 'Two'], emailDomains: [], meetingKeywords: [],
});

describe('workbook round 2', () => {
  it('floors % done so 199 of 200 is 99%', async () => {
    const db = seededDb();
    for (let i = 0; i < 200; i++) {
      const t = createTask(db, task({ title: `t${i}` }), NOW);
      if (i < 199) setTaskStatus(db, t.id, 'done', '2026-10-15', NOW, 'ai');
    }
    const ov = (await build(db)).getWorksheet('Overview')!;
    expect(ov.getCell('C5').value).toBe(0.99);
  });

  it('stops age at the closing date', async () => {
    const db = seededDb();
    const t = createTask(db, task(), NOW);
    setTaskStatus(db, t.id, 'done', '2026-10-15', NOW, 'ai');
    const ws = (await build(db)).getWorksheet('Sharma Interiors')!;
    expect(findByCell(ws, 1, 'SHA-001').getCell(9).value).toBe(5);
  });

  it('keeps maybe-done yellow even when overdue', async () => {
    const db = seededDb();
    const t = createTask(db, task(), NOW);
    setTaskStatus(db, t.id, 'maybe_done', '2026-10-15', NOW, 'ai');
    const ws = (await build(db)).getWorksheet('Sharma Interiors')!;
    expect((findByCell(ws, 1, 'SHA-001').getCell(1).fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FFFFF1B8');
  });

  it('orders open tasks by priority, deadline (none last) and code; done by newest close', () => {
    const db = seededDb();
    createTask(db, task({ title: 'low early', priority: 'low', deadline: '2026-10-01' }), NOW); // 001
    createTask(db, task({ title: 'high none', priority: 'high', deadline: null }), NOW); // 002
    createTask(db, task({ title: 'high late', priority: 'high', deadline: '2026-10-30' }), NOW); // 003
    createTask(db, task({ title: 'high early', priority: 'high', deadline: '2026-10-20' }), NOW); // 004
    createTask(db, task({ title: 'med', priority: 'medium', deadline: '2026-10-05' }), NOW); // 005
    const d1 = createTask(db, task({ title: 'd1' }), NOW); // 006
    const d2 = createTask(db, task({ title: 'd2' }), NOW); // 007
    const d3 = createTask(db, task({ title: 'd3' }), NOW); // 008
    setTaskStatus(db, d1.id, 'done', '2026-10-12', NOW, 'ai');
    setTaskStatus(db, d2.id, 'done', '2026-10-16', NOW, 'ai');
    setTaskStatus(db, d3.id, 'done', '2026-10-16', NOW, 'ai');
    const v = loadTrackerView(db, now, healthy).clients.find((c) => c.client.code === 'SHA')!;
    expect(v.usOpen.map((t) => t.code)).toEqual(['SHA-004', 'SHA-003', 'SHA-002', 'SHA-005', 'SHA-001']);
    expect(v.done.map((t) => t.code)).toEqual(['SHA-007', 'SHA-008', 'SHA-006']);
  });

  it('orders clients by name case-insensitively', () => {
    const db = openDb(':memory:');
    syncClients(db, [cfg(1, 'zeta'), cfg(2, 'Alpha'), cfg(3, 'beta')]);
    expect(loadTrackerView(db, now, healthy).clients.map((c) => c.client.name)).toEqual(['Alpha', 'beta', 'zeta']);
  });

  it('keeps sheet-name suffixes stable by client id', () => {
    const db = openDb(':memory:');
    syncClients(db, [cfg(1, 'Acme'), cfg(2, 'acme')]);
    const names = () => Object.fromEntries(loadTrackerView(db, now, healthy).clients.map((c) => [c.client.code, c.sheetName]));
    expect(names()).toEqual({ C01: 'Acme', C02: 'acme (2)' });
    syncClients(db, [cfg(1, 'Acme'), cfg(2, 'acme'), cfg(3, 'ACME')]);
    expect(names()).toMatchObject({ C01: 'Acme', C02: 'acme (2)' });
  });

  it('builds with awkward client names', async () => {
    const db = openDb(':memory:');
    syncClients(db, [cfg(1, 'History'), cfg(2, "Sharma & Sons Interior Design' Studio"), cfg(3, `${'a'.repeat(30)}😀`)]);
    const wb = await build(db);
    expect(wb.worksheets).toHaveLength(4);
    for (const w of wb.worksheets) expect(w.name.endsWith("'")).toBe(false);
  });

  it('shows the revoked note with or without a quote', async () => {
    const db = seededDb();
    const a = createTask(db, task({ title: 'no quote', sourceQuote: null, sourceDate: null, sourceWaId: 'r1' }), NOW);
    const b = createTask(db, task({ title: 'with quote', sourceWaId: 'r2' }), NOW);
    db.prepare('UPDATE tasks SET source_revoked = 1 WHERE id IN (?, ?)').run(a.id, b.id);
    const ws = (await build(db)).getWorksheet('Sharma Interiors')!;
    expect(findByCell(ws, 1, 'SHA-001').getCell(13).value).toBe('source message deleted by sender');
    expect(findByCell(ws, 1, 'SHA-002').getCell(13).value).toBe('"banner thoda bright karo" (10 Oct) (source message deleted by sender)');
  });

  it('renders milestones, decisions and people', async () => {
    const db = seededDb();
    logReminder(db, createTask(db, task(), NOW).id, '2026-10-13', NOW);
    setPhase(db, 1, 'Design', 'human');
    addDecision(db, { clientId: 1, text: 'Use the blue theme', decidedOn: '2026-10-12', source: 'whatsapp', sourceWaId: null }, NOW);
    upsertPerson(db, { clientId: 1, jid: '9199@s.whatsapp.net', number: '9199', name: 'Mr. Sharma', fromMe: false });
    const ws = (await build(db)).getWorksheet('Sharma Interiors')!;
    expect(findByCell(ws, 1, 'Discovery').getCell(2).value).toBe('✅ Done');
    expect(findByCell(ws, 1, 'Design').getCell(2).value).toBe('🔄 Current');
    expect(findByCell(ws, 1, 'Development').getCell(2).value).toBe('⏳ Upcoming');
    const dec = findByCell(ws, 2, 'Use the blue theme');
    expect(dec.getCell(1).value).toEqual(new Date(Date.UTC(2026, 9, 12)));
    expect(dec.getCell(1).numFmt).toBe('d mmm yyyy');
    expect(dec.getCell(3).value).toBe('WhatsApp');
    expect(findByCell(ws, 1, 'Mr. Sharma').getCell(2).value).toBe('9199');
  });

  it('builds an Overview with only the header when there are no clients', async () => {
    const wb = await build(openDb(':memory:'));
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Overview']);
    expect(wb.getWorksheet('Overview')!.getCell('A3').value).toBe('Client');
    expect(wb.getWorksheet('Overview')!.getCell('A4').value).toBeNull();
  });

  it('keeps decisions, status text and people as text, never formulas', async () => {
    const db = seededDb();
    addDecision(db, { clientId: 1, text: '=1+1', decidedOn: '2026-10-12', source: 'whatsapp', sourceWaId: null }, NOW);
    setStatus(db, 1, '=SUM(1,2)', NOW);
    upsertPerson(db, { clientId: 1, jid: 'j1', number: null, name: '+cmd', fromMe: false });
    const wb = await build(db);
    const ws = wb.getWorksheet('Sharma Interiors')!;
    for (const [col, v] of [[2, '=1+1'], [2, '=SUM(1,2)'], [1, '+cmd']] as const) {
      const cell = findByCell(ws, col, v).getCell(col);
      expect(cell.type).toBe(ExcelJS.ValueType.String);
      expect(cell.formula).toBeUndefined();
    }
    const ovCell = wb.getWorksheet('Overview')!.getCell('H5');
    expect(ovCell.type).toBe(ExcelJS.ValueType.String);
    expect(ovCell.value).toBe('=SUM(1,2)');
  });

  it('puts (inactive) on the inactive tab title', async () => {
    const db = seededDb();
    syncClients(db, [SHARMA]);
    const ws = (await build(db)).getWorksheet('Mehta Foods')!;
    expect(String(ws.getCell('A1').value)).toContain('(inactive)');
  });

  it('limits the AutoFilter to the header and data rows', async () => {
    const db = seededDb();
    createTask(db, task(), NOW);
    const wb = await build(db);
    const ws = wb.getWorksheet('Sharma Interiors')!;
    const header = findByCell(ws, 1, 'ID').number;
    const rows = (ref: unknown) => String(ref).match(/\d+/g)!.map(Number);
    expect(rows(ws.autoFilter)).toEqual([header, header + 1]);
    const empty = rows(wb.getWorksheet('Mehta Foods')!.autoFilter);
    expect(empty[1]).toBe(empty[0]);
  });
});
