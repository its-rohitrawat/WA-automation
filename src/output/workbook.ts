import ExcelJS from 'exceljs';
import type { TaskRow } from '../store/tasks.ts';
import { daysBetween, displayDate, istDateTime, istShortDate, istTime } from '../util/time.ts';
import { isOverdue, type ClientView, type FileView, type TrackerView } from './view.ts';

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
const SOURCE_LABEL: Record<string, string> = { whatsapp: 'WhatsApp', meeting: 'Meeting', human: 'Human' };
const sourceLabel = (s: string) => SOURCE_LABEL[s] ?? cap(s);
const DATE_FMT = 'd mmm yyyy';

/** A real date cell value (UTC midnight of the India calendar day) from "YYYY-MM-DD". */
function isoToDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

function formatDates(row: ExcelJS.Row): void {
  row.eachCell((c) => {
    if (c.value instanceof Date) c.numFmt = DATE_FMT;
  });
}

type Cell = string | number | Date;
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

export function taskCells(t: TaskRow, today: string): Cell[] {
  const reminders = t.reminderCount ? `${t.reminderCount}${t.lastReminderOn ? ` (last ${displayDate(t.lastReminderOn)})` : ''}` : '0';
  const note = 'source message deleted by sender';
  const source = t.sourceQuote
    ? `"${t.sourceQuote}"${t.sourceDate ? ` (${displayDate(t.sourceDate)})` : ''}${t.sourceRevoked ? ` (${note})` : ''}`
    : t.sourceRevoked
      ? note
      : t.origin === 'whatsapp'
        ? ''
        : sourceLabel(t.origin);
  return [
    t.code, t.title, cap(t.category), cap(t.priority), t.assignedTo ?? '', t.askedBy ?? '', isoToDate(t.raisedOn),
    t.deadline ? isoToDate(t.deadline) : '', daysBetween(t.raisedOn, t.closedOn ?? today), t.latestProgress ?? '', reminders, STATUS_TEXT[t.status], source,
  ];
}

function addTaskTable(ws: ExcelJS.Worksheet, title: string, tasks: TaskRow[], today: string, opts: { closedOn?: boolean; autoFilter?: boolean } = {}): void {
  sectionTitle(ws, title);
  const headers = opts.closedOn ? [...TASK_HEADERS, 'Closed on'] : TASK_HEADERS;
  const header = ws.addRow(headers);
  styleHeader(header);
  if (tasks.length === 0) noneRow(ws);
  for (const t of tasks) {
    const cells = taskCells(t, today);
    if (opts.closedOn) cells.push(t.closedOn ? isoToDate(t.closedOn) : '');
    const row = ws.addRow(cells);
    formatDates(row);
    row.alignment = { vertical: 'top', wrapText: true };
    if (t.status === 'done') fillRow(row, FILL_DONE, headers.length);
    else if (t.status === 'maybe_done') fillRow(row, FILL_MAYBE, headers.length);
    else if (isOverdue(t, today)) fillRow(row, FILL_OVERDUE, headers.length);
  }
  // One AutoFilter per sheet: header row to the last data row (header only when there are none).
  if (opts.autoFilter) ws.autoFilter = { from: { row: header.number, column: 1 }, to: { row: header.number + tasks.length, column: headers.length } };
  ws.addRow([]);
}

const DRIVE_ID = /^[A-Za-z0-9_-]{1,200}$/;
/**
 * Files received columns. Column D alone is narrow (it is the tasks' Priority column), so the description spans D to L and long
 * descriptions stay a few lines tall instead of a very tall row. The Drive link is in M.
 */
const FILE_DESC_FIRST = 4;
const FILE_DESC_LAST = 12;
const FILE_LINK = 13;

function addFilesTable(ws: ExcelJS.Worksheet, files: FileView[]): void {
  sectionTitle(ws, 'Files received');
  const header = ws.addRow(['Date', 'Sent by', 'File name', 'Description']);
  header.getCell(FILE_LINK).value = 'Drive link';
  ws.mergeCells(header.number, FILE_DESC_FIRST, header.number, FILE_DESC_LAST);
  styleHeader(header);
  if (files.length === 0) noneRow(ws);
  for (const f of files) {
    const row = ws.addRow([isoToDate(f.date), f.sentBy, f.name, f.description]);
    ws.mergeCells(row.number, FILE_DESC_FIRST, row.number, FILE_DESC_LAST);
    formatDates(row);
    row.alignment = { wrapText: true, vertical: 'top', horizontal: 'left' };
    if (f.driveFileId && DRIVE_ID.test(f.driveFileId)) {
      const link = row.getCell(FILE_LINK);
      link.value = { text: 'Open', hyperlink: `https://drive.google.com/file/d/${f.driveFileId}/view` };
      link.font = { color: { argb: 'FF0563C1' }, underline: true };
    }
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
      c.percentDone === null ? '' : c.percentDone / 100,
      c.usOpen.length,
      c.clientOpen.length,
      c.overdue,
      c.maybeDone,
      c.client.statusText ?? '',
      c.nextDeadline ? isoToDate(c.nextDeadline) : '',
      last ? `${istShortDate(last)} ${istTime(last)}` : '',
    ]);
    formatDates(row);
    if (c.percentDone !== null) row.getCell(3).numFmt = '0%';
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
  ws.addRow([`${c.client.name}${c.client.active ? '' : ' (inactive)'} (${c.client.code})`]).font = { bold: true, size: 16 };
  ws.addRow([]);

  sectionTitle(ws, 'Where we are');
  ws.addRow(['Status', c.client.statusText ?? 'Not set yet']).alignment = { wrapText: true, vertical: 'top' };
  ws.addRow(['Phase', c.client.currentPhase ?? 'Not set yet']);
  const pct = ws.addRow(['% done', c.percentDone === null ? 'No tasks yet' : c.percentDone / 100]);
  if (c.percentDone !== null) pct.getCell(2).numFmt = '0%';
  pct.getCell(2).alignment = { horizontal: 'left' };
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
  for (const d of c.decisions) {
    const row = ws.addRow([isoToDate(d.decidedOn), d.text, sourceLabel(d.source)]);
    formatDates(row);
    row.alignment = { wrapText: true, vertical: 'top', horizontal: 'left' };
  }
  ws.addRow([]);

  addFilesTable(ws, c.files);
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
