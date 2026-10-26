import ExcelJS from 'exceljs';
import { MAX_FILE_NAME_CHARS } from '../media/paths.ts';
import type { TaskRow } from '../store/tasks.ts';
import { daysBetween, displayDate, istDateTime, istShortDate, istTime, meetingLength } from '../util/time.ts';
import { isOverdue, type ClientView, type FileView, type MeetingView, type TrackerView } from './view.ts';

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

const LINK_FONT: Partial<ExcelJS.Font> = { color: { argb: 'FF0563C1' }, underline: true };

function setLink(cell: ExcelJS.Cell, text: string, hyperlink: string): void {
  cell.value = { text, hyperlink };
  cell.font = LINK_FONT;
}

/** "47 min", "1 h 02 min", "under 1 min", as in the Doc; blank when the length is not known. */
const lengthText = (seconds: number | null): string => (seconds === null ? '' : meetingLength(seconds));

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
/** A Drive file's or Google Doc's link, or null when the id is missing or not a plain Drive id. */
const driveUrl = (id: string | null): string | null => (id !== null && DRIVE_ID.test(id) ? `https://drive.google.com/file/d/${id}/view` : null);
const docUrl = (id: string | null): string | null => (id !== null && DRIVE_ID.test(id) ? `https://docs.google.com/document/d/${id}/edit` : null);
/** Client tab column widths, A to N. Excel counts a width in characters: the width of the digit 0 in the default 11 pt Calibri. */
const CLIENT_COLUMN_WIDTHS = [14, 38, 13, 10, 14, 16, 10, 10, 10, 32, 16, 22, 44, 11];
/**
 * Files received columns. Column D alone is narrow (it is the tasks' Priority column), so the description spans D to L and long
 * descriptions stay a few lines tall instead of a very tall row. The Drive link is in M.
 */
const FILE_DESC_FIRST = 4;
const FILE_DESC_LAST = 12;
const FILE_LINK = 13;
/** Excel's normal row height for 11 pt Calibri, in points: one line of text. */
const LINE_HEIGHT = 15;
/**
 * How much of a column's width wrapped text fills, in percent. A width counts digit-sized characters, but capitals, ₹ and emoji
 * are wider and Excel wraps at spaces, so a line holds fewer. 85% keeps the estimate on the tall side: a row a little too tall
 * is harmless, one too short hides text.
 */
const WRAP_FILL_PERCENT = 85;
/** Characters that fit on one wrapped line across columns first to last (1-based, inclusive). */
function lineChars(first: number, last: number): number {
  const width = CLIENT_COLUMN_WIDTHS.slice(first - 1, last).reduce((sum, w) => sum + w, 0);
  return Math.floor((width * WRAP_FILL_PERCENT) / 100);
}
/** Sent by (B, width 38): 32 characters a line. File name (C, width 13): 11. Description (D to L merged, width 140 in all): 119. */
const FILE_LINE_CHARS = { sentBy: lineChars(2, 2), name: lineChars(3, 3), description: lineChars(FILE_DESC_FIRST, FILE_DESC_LAST) };
/**
 * A cap so one odd row cannot take over the tab: as many lines as the longest file name sanitizeFileName keeps (120
 * characters, 11 lines of 11 in column C), so its end, often the extension, fits by the estimate (T14-14). The longest
 * description, about 300 characters, needs 3 lines.
 */
const MAX_FILE_LINES = Math.ceil(MAX_FILE_NAME_CHARS / FILE_LINE_CHARS.name);

/**
 * Height in points of a Files received row (owner decision D4). Excel and Google Sheets do not auto-fit a row to a merged cell,
 * so the row gets 15 points per line of its longest wrapped text: the description across D to L, or the sender or file name in
 * its own column. A row that fits on one line keeps the normal 15 points.
 */
export function fileRowHeight(f: Pick<FileView, 'sentBy' | 'name' | 'description'>): number {
  const lines = (s: string, perLine: number) => Math.ceil([...s].length / perLine);
  const n = Math.max(lines(f.sentBy, FILE_LINE_CHARS.sentBy), lines(f.name, FILE_LINE_CHARS.name), lines(f.description, FILE_LINE_CHARS.description), 1);
  return LINE_HEIGHT * Math.min(n, MAX_FILE_LINES);
}

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
    row.height = fileRowHeight(f);
    formatDates(row);
    row.alignment = { wrapText: true, vertical: 'top', horizontal: 'left' };
    const url = driveUrl(f.driveFileId);
    if (url) setLink(row.getCell(FILE_LINK), 'Open', url);
  }
  ws.addRow([]);
}

const MEETING_DOC = 5;

function addMeetingsTable(ws: ExcelJS.Worksheet, meetings: MeetingView[]): void {
  sectionTitle(ws, 'Meetings');
  styleHeader(ws.addRow(['Date', 'Meeting', 'Length', 'Action items', 'Doc']));
  if (meetings.length === 0) noneRow(ws);
  for (const m of meetings) {
    const row = ws.addRow([isoToDate(m.date), m.title, lengthText(m.seconds), m.actionItemCount]);
    formatDates(row);
    row.alignment = { wrapText: true, vertical: 'top', horizontal: 'left' };
    const url = docUrl(m.docFileId);
    if (url) setLink(row.getCell(MEETING_DOC), 'Open', url);
  }
  ws.addRow([]);
}

const ASSIGN_HINT = 'On the office PC: npm run cli -- meeting list, then meeting assign <id> <CODE>';
const OVERVIEW_COLUMNS = 11;

/**
 * Unassigned meetings below the client table, after a blank row: id, India date and length only. The title and attendees
 * are left out on purpose: everyone who opens the workbook sees the Overview.
 */
function addUnassigned(ws: ExcelJS.Worksheet, view: TrackerView): void {
  if (view.unassigned.length === 0) return;
  ws.addRow([]);
  sectionTitle(ws, 'Unassigned meetings');
  for (const m of view.unassigned) ws.addRow([[`#${m.id}`, displayDate(m.date), lengthText(m.seconds)].filter((s) => s !== '').join(' · ')]);
  const more = view.unassignedTotal - view.unassigned.length;
  if (more > 0) ws.addRow([`+${more} more`]);
  ws.addRow([ASSIGN_HINT]).font = { italic: true, color: { argb: GREY } };
}

/** " · 3 unassigned meetings (see below)", or nothing when there are none. */
function unassignedNote(view: TrackerView): string {
  const n = Math.max(view.unassignedTotal, view.unassigned.length);
  return n === 0 ? '' : ` · ${n} unassigned meeting${n === 1 ? '' : 's'} (see below)`;
}

function addOverview(wb: ExcelJS.Workbook, view: TrackerView): void {
  const ws = wb.addWorksheet('Overview', { views: [{ state: 'frozen', ySplit: 3 }] });
  ws.columns = [{ width: 30 }, { width: 14 }, { width: 9 }, { width: 13 }, { width: 16 }, { width: 10 }, { width: 14 }, { width: 60 }, { width: 14 }, { width: 18 }, { width: 14 }];
  ws.addRow([view.health.text]).font = { bold: true, size: 12, color: { argb: view.health.ok ? 'FF1F7A3D' : 'FFB42318' } };
  ws.mergeCells(1, 1, 1, OVERVIEW_COLUMNS);
  ws.addRow([`Built ${istDateTime(view.generatedAt)} IST${unassignedNote(view)}`]).font = { italic: true, color: { argb: GREY } };
  styleHeader(ws.addRow(['Client', 'Phase', '% done', 'Our open tasks', 'Waiting on client', 'Overdue', 'Maybe done (check)', 'Where we are', 'Next deadline', 'Last activity', 'Last meeting']));
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
      c.lastMeeting ? isoToDate(c.lastMeeting) : '',
    ]);
    formatDates(row);
    if (c.percentDone !== null) row.getCell(3).numFmt = '0%';
    row.getCell(1).value = { text: name, hyperlink: `#'${c.sheetName.replace(/'/g, "''")}'!A1` };
    row.getCell(1).font = { color: { argb: 'FF0563C1' }, underline: true };
    row.alignment = { vertical: 'top', wrapText: true };
    if (c.overdue > 0) row.getCell(6).fill = solid(FILL_OVERDUE);
    if (c.maybeDone > 0) row.getCell(7).fill = solid(FILL_MAYBE);
  }
  addUnassigned(ws, view);
}

function addClientSheet(wb: ExcelJS.Workbook, c: ClientView, today: string): void {
  const ws = wb.addWorksheet(c.sheetName, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = CLIENT_COLUMN_WIDTHS.map((width) => ({ width }));
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
    const url = d.source === 'meeting' ? docUrl(d.docFileId) : null;
    if (url) setLink(row.getCell(3), sourceLabel(d.source), url);
  }
  ws.addRow([]);

  addFilesTable(ws, c.files);
  addTaskTable(ws, 'Done', c.done, today, { closedOn: true });
  addMeetingsTable(ws, c.meetings);

  sectionTitle(ws, 'People');
  styleHeader(ws.addRow(['Name', 'Number', 'Role', 'Set by']));
  if (c.people.length === 0) noneRow(ws);
  for (const p of c.people) ws.addRow([p.name ?? '', p.number ?? '', cap(p.role), p.roleSetBy === 'system' ? 'Founder' : p.roleSetBy === 'human' ? 'Human' : 'AI']);
}

/**
 * Characters XML 1.0 does not allow: C0 controls other than tab, line feed and carriage return, U+FFFE, U+FFFF and unpaired
 * surrogates. ExcelJS drops the controls but writes U+FFFE and U+FFFF as they are, and then neither Excel nor ExcelJS can
 * open the file. Sender names, file names and file text come from WhatsApp, so one such character would break the whole
 * workbook. Those two are the ones that really break it. Unpaired surrogates are removed only as a precaution (T14-13):
 * JSZip in Node writes one as U+FFFD, which is valid XML, and text read back from SQLite never holds one anyway.
 */
const XML_UNSAFE = /[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function xmlSafe(s: string): string {
  return s.replace(XML_UNSAFE, '');
}

/** Cleans every text cell (and link text) in the workbook with xmlSafe. */
function cleanText(wb: ExcelJS.Workbook): void {
  wb.eachSheet((ws) =>
    ws.eachRow((row) =>
      row.eachCell((c) => {
        if (c.type === ExcelJS.ValueType.String) {
          const v = c.value as string;
          const safe = xmlSafe(v);
          if (safe !== v) c.value = safe;
        } else if (c.type === ExcelJS.ValueType.Hyperlink) {
          const v = c.value as ExcelJS.CellHyperlinkValue;
          const safe = xmlSafe(v.text);
          if (safe !== v.text) c.value = { ...v, text: safe };
        }
      }),
    ),
  );
}

export async function buildWorkbook(view: TrackerView): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'WA Agent';
  wb.created = view.generatedAt;
  addOverview(wb, view);
  for (const c of view.clients) addClientSheet(wb, c, view.today);
  cleanText(wb);
  return Buffer.from((await wb.xlsx.writeBuffer()) as unknown as ArrayBuffer);
}
