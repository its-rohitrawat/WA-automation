import { TRACKER_ID_KEY } from '../output/trackerKey.ts';
import { isOverdue, type TrackerView } from '../output/view.ts';
import type { Db } from '../store/db.ts';
import { getKv } from '../store/kv.ts';
import { priorityRank, type TaskRow } from '../store/tasks.ts';
import { displayDate } from '../util/time.ts';

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

/**
 * The morning WhatsApp text: one line with the totals of the active clients and the tracker link (owner decision D1,
 * 27 Oct 2026). Built from the tracker view only (no AI call). It names no client and no task.
 * today: the IST date the view was built for (view.today); the view's overdue counts already use it.
 */
export function buildShortMorningText(view: TrackerView, today: string, link: string): string {
  const active = view.clients.filter((c) => c.client.active);
  if (active.length === 0) return `Good morning. No open tasks. Today's tracker: ${link}`;
  let open = 0;
  let overdue = 0;
  let critical = 0;
  for (const c of active) {
    open += c.usOpen.length + c.clientOpen.length;
    overdue += c.overdue;
    critical += [...c.usOpen, ...c.clientOpen].filter((t) => t.priority === 'critical').length;
  }
  // Critical first: named only when there are some, so a day without any reads as before.
  const lead = critical > 0 ? `${critical} critical, ` : '';
  return `Good morning. ${lead}${open} open ${open === 1 ? 'task' : 'tasks'}, ${overdue} overdue. Today's tracker: ${link}`;
}
