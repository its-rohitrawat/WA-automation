// The pure parts of the work and control screens (D4 Task 6, D5 Task 5): URL filters, labels, dates, the usage chart and
// day grouping. No DOM and no imports, so they are unit-tested in tests/web/workLib.test.ts. Everything here returns
// plain values; the screens put any text from the agent through esc().

const IST = 'Asia/Kolkata';

export const TASK_STATUSES = ['overdue', 'open', 'review', 'done'];
export const TASK_DEADLINES = ['past', 'week', 'none'];
export const TASK_PRIORITIES = ['high', 'medium', 'low'];
export const TASK_SORTS = ['deadline', 'code', 'client', 'owner', 'status'];

/**
 * @typedef {{ q?: string, client?: string, status?: string, owner?: string, deadline?: string, priority?: string, sort: string, dir: 'asc' | 'desc' }} TaskFilter
 */

/** The Tasks screen's filters from the address's query: unknown values are dropped. @param {string} search @returns {TaskFilter} */
export function taskQueryFromSearch(search) {
  const p = new URLSearchParams(search);
  /** @type {TaskFilter} */
  const out = { sort: 'deadline', dir: 'asc' };
  const text = (/** @type {string} */ k) => (p.get(k) ?? '').trim().slice(0, 200);
  const q = text('q');
  if (q) out.q = q;
  const client = text('client').toUpperCase();
  if (/^[A-Z]{3,4}$/.test(client)) out.client = client;
  const owner = text('owner');
  if (owner) out.owner = owner;
  const pick = (/** @type {string} */ k, /** @type {string[]} */ allowed) => {
    const v = p.get(k) ?? '';
    return allowed.includes(v) ? v : undefined;
  };
  const status = pick('status', TASK_STATUSES);
  if (status) out.status = status;
  const deadline = pick('deadline', TASK_DEADLINES);
  if (deadline) out.deadline = deadline;
  const priority = pick('priority', TASK_PRIORITIES);
  if (priority) out.priority = priority;
  out.sort = pick('sort', TASK_SORTS) ?? 'deadline';
  out.dir = p.get('dir') === 'desc' ? 'desc' : 'asc';
  return out;
}

/** The query for these filters: "" when nothing is set; the default sort is left out. @param {TaskFilter} f */
export function taskQueryToSearch(f) {
  const p = new URLSearchParams();
  for (const k of /** @type {const} */ (['q', 'client', 'status', 'owner', 'deadline', 'priority'])) {
    const v = f[k];
    if (v) p.set(k, v);
  }
  if (f.sort !== 'deadline' || f.dir !== 'asc') {
    p.set('sort', f.sort);
    if (f.dir === 'desc') p.set('dir', 'desc');
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** One value from the query, when it is one of `allowed`; else `fallback`. @param {string} search @param {string} key @param {string[]} allowed @param {string} fallback */
export function readList(search, key, allowed, fallback) {
  const v = new URLSearchParams(search).get(key) ?? '';
  return allowed.includes(v) ? v : fallback;
}

/** @type {Record<string, { cls: string, label: string }>} */
const TASK_PILLS = {
  overdue: { cls: 'p-overdue', label: 'Overdue' }, open: { cls: 'p-open', label: 'Open' }, review: { cls: 'p-review', label: 'Needs review' },
  done: { cls: 'p-done', label: 'Done' },
};
/** A task status's pill: its class (the colour) and its word (status is never shown by colour alone). @param {string} s */
export const taskPill = (s) => TASK_PILLS[s] ?? { cls: 'p-muted', label: 'Unknown' };

/** @type {Record<string, { icon: string, label: string }>} */
const SOURCES = { whatsapp: { icon: 'bubble', label: 'WhatsApp' }, meeting: { icon: 'video', label: 'Meeting' }, voice: { icon: 'mic', label: 'Voice note' }, dashboard: { icon: 'user', label: 'Added by you' } };
/** @param {string} s */
export const sourceLabel = (s) => SOURCES[s] ?? SOURCES.whatsapp;

/** @type {Record<string, { cls: string, label: string }>} */
const MEETING_PILLS = {
  done: { cls: 'p-done', label: 'Summary ready' }, queued: { cls: 'p-open', label: 'In progress' }, unassigned: { cls: 'p-warn', label: 'Needs a client' },
  internal: { cls: 'p-muted', label: 'Internal' }, skipped: { cls: 'p-muted', label: 'Skipped' }, too_long: { cls: 'p-overdue', label: 'Too long' },
  no_access: { cls: 'p-overdue', label: 'No access' }, failed: { cls: 'p-overdue', label: 'Failed' },
};
/** @param {string} s */
export const meetingPill = (s) => MEETING_PILLS[s] ?? { cls: 'p-muted', label: 'Unknown' };

/** An audit row's pill: refusals and failures stand out, setting changes are marked. @param {{ kind: string, event: string }} r */
export function auditPill(r) {
  if (/refused|failed|denied/.test(r.event)) return { cls: 'p-overdue' };
  if (r.kind === 'config') return { cls: 'p-review' };
  return { cls: 'p-muted' };
}

/** "30 Oct" for "2026-10-30"; "No deadline" for none. @param {string | null | undefined} date */
export function deadlineText(date) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return 'No deadline';
  const d = new Date(`${date}T00:00:00+05:30`);
  return Number.isNaN(d.getTime()) ? 'No deadline' : d.toLocaleDateString('en-GB', { timeZone: IST, day: 'numeric', month: 'short' });
}

/** "$7.50". @param {number} n */
const money = (n) => `$${(Number.isFinite(n) ? n : 0).toFixed(2)}`;

/**
 * The 14-day spend chart: bar heights in % of the higher of the biggest day and the cap, the last day marked as today,
 * the cap line's height (null without a cap), a text tip per bar, and the rows of the hidden table for screen readers.
 * @param {{ day: string, usd: number }[]} days @param {number} cap
 */
export function usageChart(days, cap) {
  const top = Math.max(cap > 0 ? cap : 0, ...days.map((d) => d.usd), 0);
  const pct = (/** @type {number} */ v) => (top > 0 ? Math.round((v / top) * 1000) / 10 : 0);
  const short = (/** @type {string} */ day) => deadlineText(day);
  return {
    bars: days.map((d, i) => ({ day: d.day, label: d.day.slice(8), usd: d.usd, pct: pct(d.usd), today: i === days.length - 1, tip: `${short(d.day)} · ${money(d.usd)}` })),
    capPct: cap > 0 && top > 0 ? pct(cap) : null,
    rows: days.map((d) => [short(d.day), money(d.usd)]),
  };
}

const dayKey = (/** @type {Date} */ d) => d.toLocaleDateString('en-CA', { timeZone: IST });
const longDay = (/** @type {Date} */ d) => d.toLocaleDateString('en-GB', { timeZone: IST, weekday: 'long', day: 'numeric', month: 'long' });

/**
 * Items grouped by their India date, in the order given (newest first from the API), each group named
 * "Today · …", "Yesterday · …" or the long date.
 * @template {{ at: string }} T @param {T[]} items @param {Date} [now] @returns {{ label: string, items: T[] }[]}
 */
export function groupByIstDay(items, now = new Date()) {
  const today = dayKey(now);
  const yesterday = dayKey(new Date(Date.parse(`${today}T12:00:00+05:30`) - 86_400_000));
  /** @type {{ key: string, label: string, items: T[] }[]} */
  const groups = [];
  for (const item of items) {
    const d = new Date(item.at);
    if (Number.isNaN(d.getTime())) continue;
    const key = dayKey(d);
    let g = groups.find((x) => x.key === key);
    if (!g) {
      const label = key === today ? `Today · ${longDay(d)}` : key === yesterday ? `Yesterday · ${longDay(d)}` : longDay(d);
      g = { key, label, items: [] };
      groups.push(g);
    }
    g.items.push(item);
  }
  return groups.map(({ label, items: list }) => ({ label, items: list }));
}

/** The founder's number typed twice: the same Indian mobile number (91, then 10 digits from 6-9). @param {string} a @param {string} b */
export function numbersMatch(a, b) {
  const da = String(a).replace(/\D/g, '');
  return /^91[6-9]\d{9}$/.test(da) && da === String(b).replace(/\D/g, '');
}
