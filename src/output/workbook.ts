import ExcelJS from 'exceljs';
import type { TaskRow } from '../store/tasks.ts';
import { daysBetween, displayDate, istDateTime, istShortDate, istTime } from '../util/time.ts';
import { isOverdue, type ClientView, type TrackerView } from './view.ts';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const BLACK = 'FF0D0D0D';
const ORANGE = 'FFFF5B14';
const WHITE = 'FFFFFFFF';
const GREY = 'FF8A8A8A';
const FILL_OVERDUE = 'FFFFD9D2';
const FILL_MAYBE = 'FFFFF1B8';
const FILL_DONE = 'FFD8F5DD';

const TASK_HEADERS = ['ID', 'Task', 'Category', 'Priority', 'Assigned to', 'Asked by', 'Raised', 'Deadline', 'Age (days)', 'Latest progress', 'Reminders', 'Status', 'Source message'];
const STATUS_TEXT: Record<TaskRow['status'], string> = { open: 'Open', maybe_done: 'Maybe done (please check)', done: 'Done' };

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const solid = (argb: string): ExcelJS.Fill => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });

function styleHeader(row: ExcelJS.Row): void {
  row.eachCell((c) => {
    c.fill = solid(BLACK);
    c.font = { bold: true, color: { argb: WHITE } };
    c.alignment = { vertical: 'middle', wrapText: true };
  });
}

function sectionTitle(ws: ExcelJS.Worksheet, title: string): void {
  ws.addRow([title]).font = { bold: true, size: 13, color: { argb: ORANGE } };
}

function noneRow(ws: ExcelJS.Worksheet): void {
  ws.addRow(['(none)']).font = { italic: true, color: { argb: GREY } };
}

function fillRow(row: ExcelJS.Row, argb: string, columns: number): void {
  for (let i = 1; i <= columns; i++) row.getCell(i).fill = solid(argb);
}

export function taskCells(t: TaskRow, today: string): (string | number)[] {
  const reminders = t.reminderCount ? `${t.reminderCount}${t.lastReminderOn ? ` (last ${displayDate(t.lastReminderOn)})` : ''}` : '0';
  const deleted = t.sourceRevoked ? ' (source message deleted by sender)' : '';
  const source = t.sourceQuote ? `"${t.sourceQuote}"${t.sourceDate ? ` (${displayDate(t.sourceDate)})` : ''}${deleted}` : t.origin === 'whatsapp' ? '' : t.origin;
  return [
    t.code, t.title, cap(t.category), cap(t.priority), t.assignedTo ?? '', t.askedBy ?? '', displayDate(t.raisedOn),
    t.deadline ? displayDate(t.deadline) : '', daysBetween(t.raisedOn, today), t.latestProgress ?? '', reminders, STATUS_TEXT[t.status], source,
  ];
}

function addTaskTable(ws: ExcelJS.Worksheet, title: string, tasks: TaskRow[], today: string, opts: { closedOn?: boolean; autoFilter?: boolean } = {}): void {
  sectionTitle(ws, title);
  const headers = opts.closedOn ? [...TASK_HEADERS, 'Closed on'] : TASK_HEADERS;
  const header = ws.addRow(headers);
  styleHeader(header);
  if (opts.autoFilter) ws.autoFilter = { from: { row: header.number, column: 1 }, to: { row: header.number, column: headers.length } };
  if (tasks.length === 0) noneRow(ws);
  for (const t of tasks) {
    const cells = taskCells(t, today);
    if (opts.closedOn) cells.push(t.closedOn ? displayDate(t.closedOn) : '');
    const row = ws.addRow(cells);
    row.alignment = { vertical: 'top', wrapText: true };
    if (t.status === 'done') fillRow(row, FILL_DONE, headers.length);
    else if (isOverdue(t, today)) fillRow(row, FILL_OVERDUE, headers.length);
    else if (t.status === 'maybe_done') fillRow(row, FILL_MAYBE, headers.length);
  }
  ws.addRow([]);
}

function addOverview(wb: ExcelJS.Workbook, view: TrackerView): void {
  const ws = wb.addWorksheet('Overview', { views: [{ state: 'frozen', ySplit: 3 }] });
  ws.columns = [{ width: 30 }, { width: 14 }, { width: 9 }, { width: 13 }, { width: 16 }, { width: 10 }, { width: 14 }, { width: 60 }, { width: 14 }, { width: 18 }];
  ws.addRow([view.health.text]).font = { bold: true, size: 12, color: { argb: view.health.ok ? 'FF1F7A3D' : 'FFB42318' } };
  ws.mergeCells(1, 1, 1, 10);
  ws.addRow([`Built ${istDateTime(view.generatedAt)} IST`]).font = { italic: true, color: { argb: GREY } };
  styleHeader(ws.addRow(['Client', 'Phase', '% done', 'Our open tasks', 'Waiting on client', 'Overdue', 'Maybe done (check)', 'Where we are', 'Next deadline', 'Last activity']));
  for (const c of view.clients) {
    const last = c.lastActivity ? new Date(c.lastActivity) : null;
    const name = c.client.name + (c.client.active ? '' : ' (inactive)');
    const row = ws.addRow([
      name,
      c.client.currentPhase ?? '',
      c.percentDone === null ? '' : `${c.percentDone}%`,
      c.usOpen.length,
      c.clientOpen.length,
      c.overdue,
      c.maybeDone,
      c.client.statusText ?? '',
      c.nextDeadline ? displayDate(c.nextDeadline) : '',
      last ? `${istShortDate(last)} ${istTime(last)}` : '',
    ]);
    row.getCell(1).value = { text: name, hyperlink: `#'${c.sheetName.replace(/'/g, "''")}'!A1` };
    row.getCell(1).font = { color: { argb: 'FF0563C1' }, underline: true };
    row.alignment = { vertical: 'top', wrapText: true };
    if (c.overdue > 0) row.getCell(6).fill = solid(FILL_OVERDUE);
    if (c.maybeDone > 0) row.getCell(7).fill = solid(FILL_MAYBE);
  }
}

function addClientSheet(wb: ExcelJS.Workbook, c: ClientView, today: string): void {
  const ws = wb.addWorksheet(c.sheetName, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [{ width: 14 }, { width: 38 }, { width: 13 }, { width: 10 }, { width: 14 }, { width: 16 }, { width: 10 }, { width: 10 }, { width: 10 }, { width: 32 }, { width: 16 }, { width: 22 }, { width: 44 }, { width: 11 }];
  ws.addRow([`${c.client.name} (${c.client.code})`]).font = { bold: true, size: 16 };
  ws.addRow([]);

  sectionTitle(ws, 'Where we are');
  ws.addRow(['Status', c.client.statusText ?? 'Not set yet']).alignment = { wrapText: true, vertical: 'top' };
  ws.addRow(['Phase', c.client.currentPhase ?? 'Not set yet']);
  ws.addRow(['% done', c.percentDone === null ? 'No tasks yet' : `${c.percentDone}%`]);
  ws.addRow(['Last updated', c.client.statusUpdatedAt ? istDateTime(new Date(c.client.statusUpdatedAt)) : '']);
  ws.addRow([]);

  sectionTitle(ws, 'Milestones');
  const current = c.client.currentPhase ? c.client.phases.indexOf(c.client.currentPhase) : -1;
  c.client.phases.forEach((p, i) => ws.addRow([p, i < current ? '✅ Done' : i === current ? '🔄 Current' : '⏳ Upcoming']));
  ws.addRow([]);

  addTaskTable(ws, 'Our pending tasks', c.usOpen, today, { autoFilter: true });
  addTaskTable(ws, 'Waiting on client', c.clientOpen, today);

  sectionTitle(ws, 'Decisions');
  styleHeader(ws.addRow(['Date', 'Decision', 'Source']));
  if (c.decisions.length === 0) noneRow(ws);
  for (const d of c.decisions) ws.addRow([displayDate(d.decidedOn), d.text, cap(d.source)]).alignment = { wrapText: true, vertical: 'top' };
  ws.addRow([]);

  addTaskTable(ws, 'Done', c.done, today, { closedOn: true });

  sectionTitle(ws, 'People');
  styleHeader(ws.addRow(['Name', 'Number', 'Role', 'Set by']));
  if (c.people.length === 0) noneRow(ws);
  for (const p of c.people) ws.addRow([p.name ?? '', p.number ?? '', cap(p.role), p.roleSetBy === 'system' ? 'Founder' : p.roleSetBy === 'human' ? 'Human' : 'AI']);
}

export async function buildWorkbook(view: TrackerView): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'WA Agent';
  wb.created = view.generatedAt;
  addOverview(wb, view);
  for (const c of view.clients) addClientSheet(wb, c, view.today);
  return Buffer.from((await wb.xlsx.writeBuffer()) as unknown as ArrayBuffer);
}
