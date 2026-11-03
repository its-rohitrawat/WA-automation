import { TRACKER_ID_KEY } from '../output/trackerKey.ts';
import { isOverdue, loadTrackerView, type TrackerView } from '../output/view.ts';
import type { Db } from '../store/db.ts';
import { getKv } from '../store/kv.ts';
import { priorityRank, type TaskRow } from '../store/tasks.ts';
import { displayDate, istDayLabel } from '../util/time.ts';

/** Most urgent open tasks listed per client. */
export const TOP_TASKS = 3;
/** Longest task title shown, in characters. Longer titles are cut, at a space when one is near the end. */
export const MAX_TITLE_CHARS = 70;

/** Critical first, then overdue, then due today, then priority (most urgent first), then oldest raised, then task id. */
export function byMorningUrgency(today: string): (a: TaskRow, b: TaskRow) => number {
  const critical = (t: TaskRow) => (t.priority === 'critical' ? 0 : 1);
  const overdue = (t: TaskRow) => (isOverdue(t, today) ? 0 : 1);
  const dueToday = (t: TaskRow) => (t.deadline === today ? 0 : 1);
  return (a, b) =>
    critical(a) - critical(b) ||
    overdue(a) - overdue(b) ||
    dueToday(a) - dueToday(b) ||
    priorityRank(a) - priorityRank(b) ||
    a.raisedOn.localeCompare(b.raisedOn) ||
    a.id - b.id;
}

/** One line of at most `max` characters. Counts code points, so an emoji is never cut in half. */
export function shortTitle(title: string, max = MAX_TITLE_CHARS): string {
  const flat = title.replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  if (chars.length <= max) return flat;
  const cut = chars.slice(0, max - 1).join('');
  const space = cut.lastIndexOf(' ');
  return `${(space >= max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The notes shown after a task: its deadline ("due today" or "due 21 Oct"), overdue, critical or major, maybe done. */
export function taskNotes(t: TaskRow, today: string): string[] {
  const notes: string[] = [];
  if (t.deadline) notes.push(t.deadline === today ? 'due today' : `due ${displayDate(t.deadline)}`);
  if (isOverdue(t, today)) notes.push('overdue');
  if (t.priority === 'critical' || t.priority === 'major') notes.push(t.priority);
  if (t.status === 'maybe_done') notes.push('maybe done');
  return notes;
}

export { TRACKER_ID_KEY };

/** A Drive file id: letters, digits, _ and -, at least 10 of them. Anything else never goes into the link. */
const DRIVE_FILE_ID = /^[A-Za-z0-9_-]{10,}$/;

/** The Drive link to Tracker.xlsx, or undefined while the tracker was never uploaded (or the stored id is not a Drive id). */
export async function trackerLink(db: Db): Promise<string | undefined> {
  const id = await getKv(db, TRACKER_ID_KEY);
  return id !== undefined && DRIVE_FILE_ID.test(id) ? `https://drive.google.com/file/d/${id}/view` : undefined;
}

// The morning message the owner can write (November release, change 5): free text with placeholders that the report fills
// in from the tracker view (no AI call). The text is stored per workspace in the settings store (SettingsStore, key
// reportMessage); without one the default below is sent, which reads exactly as the one-line message did before. An
// unknown placeholder is sent as written, and filling never throws, so a saved text can never fail the morning send.

/** The placeholders, in the order the editor lists them, each with what it stands for. None names a client or a task. */
export const MESSAGE_PLACEHOLDERS = [
  { key: 'greeting', hint: 'Good morning' },
  { key: 'date', hint: "Today's date" },
  { key: 'summary', hint: 'The usual line: critical, open and overdue' },
  { key: 'open', hint: 'Open tasks' },
  { key: 'overdue', hint: 'Overdue tasks' },
  { key: 'critical', hint: 'Critical open tasks' },
  { key: 'due_today', hint: 'Open tasks due today' },
  { key: 'clients', hint: 'Active clients' },
  { key: 'tracker_link', hint: "Today's tracker on Google Drive" },
] as const;
export type MessageKey = (typeof MESSAGE_PLACEHOLDERS)[number]['key'];

/** The message sent while the owner has saved none. Filled in, it is the one-line message of 27 Oct 2026. */
export const DEFAULT_MESSAGE = "{greeting}. {summary}. Today's tracker: {tracker_link}";
/** The longest message text the owner can save, in characters (code points, so an emoji counts once). */
export const MESSAGE_MAX_CHARS = 1000;

/** Control characters other than a line break (C0, DEL and C1). */
const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/;

/** The text as it is saved: Windows line breaks as plain ones, NFC, the ends trimmed. */
export function normalizeMessage(text: string): string {
  return text.replace(/\r\n?/g, '\n').normalize('NFC').trim();
}

/** Why a message text cannot be saved, in the owner's words, or null when it can. */
export function messageProblem(v: unknown): string | null {
  if (typeof v !== 'string') return 'The message must be text';
  const text = normalizeMessage(v);
  if (text === '') return 'Write the message, or reset it to the default';
  if (Array.from(text).length > MESSAGE_MAX_CHARS) return `The message can be at most ${MESSAGE_MAX_CHARS} characters`;
  if (CONTROL.test(text)) return 'The message can have line breaks, but no other control characters';
  return null;
}

/**
 * Fills every {placeholder} it has a value for, in one pass (a value is never read again as a placeholder). Anything
 * else, an unknown {name} too, stays as written. Never throws.
 */
export function fillMessage(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{([a-z_]+)\}/g, (whole, key: string) => (Object.hasOwn(values, key) ? values[key]! : whole));
}

/**
 * Each placeholder's value for today, from the tracker view's active clients. today: the IST date the view was built
 * for (view.today), whose overdue counts already use it.
 */
export function messageValues(view: TrackerView, today: string, link: string): Record<MessageKey, string> {
  const active = view.clients.filter((c) => c.client.active);
  let open = 0;
  let overdue = 0;
  let critical = 0;
  let dueToday = 0;
  for (const c of active) {
    const tasks = [...c.usOpen, ...c.clientOpen];
    open += tasks.length;
    overdue += c.overdue;
    critical += tasks.filter((t) => t.priority === 'critical').length;
    dueToday += tasks.filter((t) => t.deadline === today).length;
  }
  // Critical first: named only when there are some, so a day without any reads as before.
  const lead = critical > 0 ? `${critical} critical, ` : '';
  const summary = active.length === 0 ? 'No open tasks' : `${lead}${open} open ${open === 1 ? 'task' : 'tasks'}, ${overdue} overdue`;
  return {
    greeting: 'Good morning', date: istDayLabel(new Date(`${today}T12:00:00+05:30`)), summary, open: String(open), overdue: String(overdue),
    critical: String(critical), due_today: String(dueToday), clients: String(active.length), tracker_link: link,
  };
}

/**
 * The morning WhatsApp text: the owner's saved text (template), or the default one line with the totals of the active
 * clients and the tracker link (owner decision D1, 27 Oct 2026). Built from the tracker view only (no AI call). It names
 * no client and no task. today: the IST date the view was built for (view.today); the view's overdue counts already use it.
 */
export function buildShortMorningText(view: TrackerView, today: string, link: string, template: string = DEFAULT_MESSAGE): string {
  return fillMessage(template, messageValues(view, today, link));
}

/** The morning message editor's data (GET /dashboard/api/settings/report-message): nothing private, no number. */
export interface MessageEditorView {
  /** The text in force: the saved one, or the default. */
  template: string;
  isDefault: boolean;
  defaultTemplate: string;
  maxChars: number;
  /** Each placeholder with today's real value, for the list beside the editor and the live preview. */
  placeholders: { key: MessageKey; hint: string; value: string }[];
  /** False while the tracker is not on Drive yet: the briefing is then not sent at all. */
  trackerLinked: boolean;
}

/** What tracker_link shows in the preview before the tracker is on Drive. */
const NO_LINK_YET = "(today's tracker link)";

/** The editor's data, with today's numbers from the same tracker view the morning send builds. saved: the saved text, if any. */
export async function messageEditorView(db: Db, now: Date, saved: string | undefined): Promise<MessageEditorView> {
  const link = await trackerLink(db);
  const view = await loadTrackerView(db, now, { ok: true, text: '' });
  const values = messageValues(view, view.today, link ?? NO_LINK_YET);
  return {
    template: saved ?? DEFAULT_MESSAGE, isDefault: saved === undefined, defaultTemplate: DEFAULT_MESSAGE, maxChars: MESSAGE_MAX_CHARS,
    placeholders: MESSAGE_PLACEHOLDERS.map((p) => ({ key: p.key, hint: p.hint, value: values[p.key] })),
    trackerLinked: link !== undefined,
  };
}
