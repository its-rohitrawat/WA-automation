import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import type { ClientConfig } from '../../src/config/groups.ts';
import { loadTrackerView } from '../../src/output/view.ts';
import { buildWorkbook } from '../../src/output/workbook.ts';
import { setPhase, setStatus, syncClients } from '../../src/store/clients.ts';
import type { Db } from '../../src/store/db.ts';
import { upsertPerson } from '../../src/store/people.ts';
import { addDecision, createTask, logReminder, setTaskStatus, type NewTask } from '../../src/store/tasks.ts';
import { NOW, seeded, SHARMA, testDb } from '../helpers/db.ts';

/** Sharma's real id in the test running now, set by seededDb() (on Postgres ids are shared by every customer). */
let sharma = 0;
async function seededDb(): Promise<Db> {
  const s = await seeded();
  sharma = s.ids.sharma;
  return s.db;
}

const task = (o: Partial<NewTask> = {}): NewTask => ({
  clientId: sharma, side: 'us', title: 'Revise homepage banner', category: 'design', priority: 'major', assignedTo: 'Rahul', askedBy: 'Mr. Sharma',
  raisedOn: '2026-10-10', deadline: '2026-10-18', latestProgress: null, sourceQuote: 'banner thoda bright karo', sourceDate: '2026-10-10',
  sourceWaId: 'm1', origin: 'whatsapp', ...o,
});

const healthy = { ok: true, text: 'ok' };
const now = new Date('2026-10-19T08:00:00Z');

async function build(db: Db): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await buildWorkbook(await loadTrackerView(db, now, healthy))) as unknown as ExcelJS.Buffer);
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
    const db = await seededDb();
    // One transaction: on Postgres each statement is a round trip, and these are 800.
    await db.tx(async (q) => {
      for (let i = 0; i < 200; i++) {
        const t = await createTask(q, task({ title: `t${i}` }), NOW);
        if (i < 199) await setTaskStatus(q, t.id, 'done', '2026-10-15', NOW, 'ai');
      }
    });
    const ov = (await build(db)).getWorksheet('Overview')!;
    expect(ov.getCell('C5').value).toBe(0.99);
  });

  it('stops age at the closing date', async () => {
    const db = await seededDb();
    const t = await createTask(db, task(), NOW);
    await setTaskStatus(db, t.id, 'done', '2026-10-15', NOW, 'ai');
    const ws = (await build(db)).getWorksheet('Sharma Interiors')!;
    expect(findByCell(ws, 1, 'SHA-001').getCell(9).value).toBe(5);
  });

  it('keeps maybe-done yellow even when overdue', async () => {
    const db = await seededDb();
    const t = await createTask(db, task(), NOW);
    await setTaskStatus(db, t.id, 'maybe_done', '2026-10-15', NOW, 'ai');
    const ws = (await build(db)).getWorksheet('Sharma Interiors')!;
    expect((findByCell(ws, 1, 'SHA-001').getCell(1).fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FFFFF1B8');
  });

  it('orders open tasks by priority, deadline (none last) and code; done by newest close', async () => {
    const db = await seededDb();
    await createTask(db, task({ title: 'low early', priority: 'low', deadline: '2026-10-01' }), NOW); // 001
    await createTask(db, task({ title: 'high none', priority: 'major', deadline: null }), NOW); // 002
    await createTask(db, task({ title: 'high late', priority: 'major', deadline: '2026-10-30' }), NOW); // 003
    await createTask(db, task({ title: 'high early', priority: 'major', deadline: '2026-10-20' }), NOW); // 004
    await createTask(db, task({ title: 'med', priority: 'medium', deadline: '2026-10-05' }), NOW); // 005
    const d1 = await createTask(db, task({ title: 'd1' }), NOW); // 006
    const d2 = await createTask(db, task({ title: 'd2' }), NOW); // 007
    const d3 = await createTask(db, task({ title: 'd3' }), NOW); // 008
    await setTaskStatus(db, d1.id, 'done', '2026-10-12', NOW, 'ai');
    await setTaskStatus(db, d2.id, 'done', '2026-10-16', NOW, 'ai');
    await setTaskStatus(db, d3.id, 'done', '2026-10-16', NOW, 'ai');
    const v = (await loadTrackerView(db, now, healthy)).clients.find((c) => c.client.code === 'SHA')!;
    expect(v.usOpen.map((t) => t.code)).toEqual(['SHA-004', 'SHA-003', 'SHA-002', 'SHA-005', 'SHA-001']);
    expect(v.done.map((t) => t.code)).toEqual(['SHA-007', 'SHA-008', 'SHA-006']);
  });

  it('orders clients by name case-insensitively', async () => {
    const db = await testDb();
    await syncClients(db, [cfg(1, 'zeta'), cfg(2, 'Alpha'), cfg(3, 'beta')]);
    expect((await loadTrackerView(db, now, healthy)).clients.map((c) => c.client.name)).toEqual(['Alpha', 'beta', 'zeta']);
  });

  it('keeps sheet-name suffixes stable by client id', async () => {
    const db = await testDb();
    await syncClients(db, [cfg(1, 'Acme'), cfg(2, 'acme')]);
    const names = async () => Object.fromEntries((await loadTrackerView(db, now, healthy)).clients.map((c) => [c.client.code, c.sheetName]));
    expect(await names()).toEqual({ C01: 'Acme', C02: 'acme (2)' });
    await syncClients(db, [cfg(1, 'Acme'), cfg(2, 'acme'), cfg(3, 'ACME')]);
    expect(await names()).toMatchObject({ C01: 'Acme', C02: 'acme (2)' });
  });

  it('builds with awkward client names', async () => {
    const db = await testDb();
    await syncClients(db, [cfg(1, 'History'), cfg(2, "Sharma & Sons Interior Design' Studio"), cfg(3, `${'a'.repeat(30)}😀`)]);
    const wb = await build(db);
    expect(wb.worksheets).toHaveLength(5);
    for (const w of wb.worksheets) expect(w.name.endsWith("'")).toBe(false);
  });

  it('builds with a backslash in a client name', async () => {
    const db = await testDb();
    await syncClients(db, [cfg(1, 'Sharma\\Mehta Designs')]);
    const wb = await build(db);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Today', 'Overview', 'Sharma Mehta Designs']);
  });

  it('breaks ties by creation order, not by text of the code', async () => {
    const db = await seededDb();
    // Codes from SHA-998, so the third is the first four-digit one (as tests/control/taskQueries.test.ts does): by the
    // text of the code SHA-1000 would come first. A thousand tasks to get there were 3,000 round trips on Postgres.
    await db.run('UPDATE clients SET next_task_seq = 998 WHERE id = ?', [sharma]);
    for (let i = 0; i < 3; i++) await createTask(db, task({ title: `t${i}`, deadline: null }), NOW);
    const codes = (await loadTrackerView(db, now, healthy)).clients.find((c) => c.client.code === 'SHA')!.usOpen.map((t) => t.code);
    expect(codes).toEqual(['SHA-998', 'SHA-999', 'SHA-1000']);
  });

  it('shows the revoked note with or without a quote', async () => {
    const db = await seededDb();
    const a = await createTask(db, task({ title: 'no quote', sourceQuote: null, sourceDate: null, sourceWaId: 'r1' }), NOW);
    const b = await createTask(db, task({ title: 'with quote', sourceWaId: 'r2' }), NOW);
    await db.run('UPDATE tasks SET source_revoked = 1 WHERE id IN (?, ?)', [a.id, b.id]);
    const ws = (await build(db)).getWorksheet('Sharma Interiors')!;
    expect(findByCell(ws, 1, 'SHA-001').getCell(13).value).toBe('source message deleted by sender');
    expect(findByCell(ws, 1, 'SHA-002').getCell(13).value).toBe('"banner thoda bright karo" (10 Oct) (source message deleted by sender)');
  });

  it('renders milestones, decisions and people', async () => {
    const db = await seededDb();
    await logReminder(db, (await createTask(db, task(), NOW)).id, '2026-10-13', NOW);
    await setPhase(db, sharma, 'Design', 'human');
    await addDecision(db, { clientId: sharma, text: 'Use the blue theme', decidedOn: '2026-10-12', source: 'whatsapp', sourceWaId: null }, NOW);
    await upsertPerson(db, { clientId: sharma, jid: '9199@s.whatsapp.net', number: '9199', name: 'Mr. Sharma', fromMe: false });
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
    const wb = await build(await testDb());
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Today', 'Overview']);
    expect(wb.getWorksheet('Overview')!.getCell('A3').value).toBe('Client');
    expect(wb.getWorksheet('Overview')!.getCell('A4').value).toBeNull();
  });

  it('keeps decisions, status text and people as text, never formulas', async () => {
    const db = await seededDb();
    await addDecision(db, { clientId: sharma, text: '=1+1', decidedOn: '2026-10-12', source: 'whatsapp', sourceWaId: null }, NOW);
    await setStatus(db, sharma, '=SUM(1,2)', NOW);
    await upsertPerson(db, { clientId: sharma, jid: 'j1', number: null, name: '+cmd', fromMe: false });
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
    const db = await seededDb();
    await syncClients(db, [SHARMA]);
    const ws = (await build(db)).getWorksheet('Mehta Foods')!;
    expect(String(ws.getCell('A1').value)).toContain('(inactive)');
  });

  it('limits the AutoFilter to the header and data rows', async () => {
    const db = await seededDb();
    await createTask(db, task(), NOW);
    const wb = await build(db);
    const ws = wb.getWorksheet('Sharma Interiors')!;
    const header = findByCell(ws, 1, 'ID').number;
    const rows = (ref: unknown) => String(ref).match(/\d+/g)!.map(Number);
    expect(rows(ws.autoFilter)).toEqual([header, header + 1]);
    const empty = rows(wb.getWorksheet('Mehta Foods')!.autoFilter);
    expect(empty[1]).toBe(empty[0]);
  });
});
