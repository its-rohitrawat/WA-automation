import { isOverdue, type ClientView, type TrackerView } from '../output/view.ts';
import type { TaskRow } from '../store/tasks.ts';
import { displayDate, istShortDate, istTime } from '../util/time.ts';

/** Most urgent open tasks listed per client. */
export const TOP_TASKS = 3;
/** Longest task title in the message, in characters. Longer titles are cut, at a space when one is near the end. */
export const MAX_TITLE_CHARS = 70;

const PRIORITY_RANK: Record<TaskRow['priority'], number> = { high: 0, medium: 1, low: 2 };

/** Overdue first, then due today, then priority (high first), then oldest raised, then task id. */
export function byMorningUrgency(today: string): (a: TaskRow, b: TaskRow) => number {
  const overdue = (t: TaskRow) => (isOverdue(t, today) ? 0 : 1);
  const dueToday = (t: TaskRow) => (t.deadline === today ? 0 : 1);
  return (a, b) =>
    overdue(a) - overdue(b) ||
    dueToday(a) - dueToday(b) ||
    PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
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

function taskLine(t: TaskRow, today: string): string {
  const notes: string[] = [];
  if (t.deadline) notes.push(t.deadline === today ? 'due today' : `due ${displayDate(t.deadline)}`);
  if (isOverdue(t, today)) notes.push('overdue');
  if (t.priority === 'high') notes.push('high priority');
  if (t.status === 'maybe_done') notes.push('maybe done');
  return `• [${t.side}] ${t.code} ${shortTitle(t.title)}${notes.length ? ` (${notes.join(', ')})` : ''}`;
}

function clientLines(c: ClientView, today: string): string[] {
  const open = [...c.usOpen, ...c.clientOpen];
  if (open.length === 0) return [`*${c.client.name}*: no open tasks`];
  const top = open.sort(byMorningUrgency(today)).slice(0, TOP_TASKS);
  return [`*${c.client.name}*: ${open.length} open, ${c.overdue} overdue`, ...top.map((t) => taskLine(t, today))];
}

/** The morning WhatsApp text, built from the tracker view only (no AI call). Inactive clients are left out. */
export function buildMorningText(view: TrackerView, today: string): string {
  const active = view.clients.filter((c) => c.client.active);
  const lines = [`Morning report · ${displayDate(today)}`];
  let open = 0;
  let overdue = 0;
  if (active.length === 0) lines.push('', 'No active clients.');
  for (const c of active) {
    open += c.usOpen.length + c.clientOpen.length;
    overdue += c.overdue;
    lines.push('', ...clientLines(c, today));
  }
  const built = `${istShortDate(view.generatedAt)} ${istTime(view.generatedAt)}`;
  lines.push('', `Total: ${open} open, ${overdue} overdue · Built ${built} IST`);
  return lines.join('\n');
}
