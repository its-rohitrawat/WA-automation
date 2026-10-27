import type { Db } from '../store/db.ts';
import type { MeetingStatus } from '../store/meetings.ts';
import { ControlError, type Audit, type AuditEntry } from './errors.ts';

// The dashboard's Activity screen (D4 Task 4): one feed, newest first, merged from the batches, task events, meetings
// and the audit log. Every line is fixed words plus codes, counts, client names and the task or meeting title, which
// are untrusted text the browser shows as text. A task event's stored detail (words from the chat) is never read.
// Meetings keep no history of their stages, so each one shows once, in its current state, at its last change.

export const ACTIVITY_KINDS = ['all', 'msg', 'task', 'meet', 'tracker', 'issue'] as const;
export type ActivityFilter = (typeof ACTIVITY_KINDS)[number];
/** An item's kind: one of the filters, or a connection or setting change (shown under all only). */
export type ActivityKind = Exclude<ActivityFilter, 'all'> | 'connection' | 'config';

const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 200;

type Source = 'a' | 'b' | 'e' | 'm';

/** Where a page ends: the last item's time, source and row id. With a time alone, everything strictly before it. */
export interface ActivityCursor {
  at: string;
  src?: Source;
  id?: number;
}

export interface ActivityParams {
  kind: ActivityFilter;
  limit: number;
  before?: ActivityCursor;
}

export interface ActivityItem {
  /** Unique across sources: "b:12" (batch), "e:" (task event), "m:" (meeting), "a:" (audit row). */
  id: string;
  kind: ActivityKind;
  title: string;
  detail: string;
  who: string;
  at: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

/** Reads and checks the Activity screen's URL parameters. Throws ControlError (400) naming the bad field. */
export function parseActivityParams(p: URLSearchParams): ActivityParams {
  const kind = p.get('kind') ?? '';
  if (kind !== '' && !(ACTIVITY_KINDS as readonly string[]).includes(kind)) {
    throw new ControlError(400, `kind must be one of: ${ACTIVITY_KINDS.join(', ')}`, 'kind');
  }
  const rawLimit = p.get('limit') ?? '';
  if (rawLimit !== '' && (!/^\d{1,9}$/.test(rawLimit) || Number(rawLimit) < 1)) throw new ControlError(400, 'limit must be a whole number of at least 1', 'limit');
  const out: ActivityParams = { kind: (kind || 'all') as ActivityFilter, limit: Math.min(rawLimit === '' ? LIMIT_DEFAULT : Number(rawLimit), LIMIT_MAX) };
  const before = p.get('before') ?? '';
  if (before !== '') {
    const m = /^([^|]+)(?:\|([abem])\|([1-9]\d{0,14}))?$/.exec(before);
    if (!m || !ISO.test(m[1]!) || Number.isNaN(Date.parse(m[1]!))) throw new ControlError(400, 'before must be a time from the previous page', 'before');
    out.before = m[2] === undefined ? { at: m[1]! } : { at: m[1]!, src: m[2] as Source, id: Number(m[3]) };
  }
  return out;
}

const TASK_OPS = ['add_task', 'update_task', 'mark_maybe_done', 'close_task', 'reopen_task', 'unlock', 'log_reminder'] as const;
const MEET_STATUSES: readonly MeetingStatus[] = ['done', 'unassigned', 'queued', 'skipped'];
const ISSUE_STATUSES: readonly MeetingStatus[] = ['too_long', 'no_access', 'failed'];
const PUBLISHED = 'tracker.published';
const PUBLISH_FAILED = 'tracker.publish_failed';

const list = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(', '); // fixed values from this file only

/** Each source's rows for a filter, as (at, src, id). */
function sourcesFor(kind: ActivityFilter): string[] {
  const out: string[] = [];
  const batches = kind === 'all' ? "status IN ('ok', 'failed')" : kind === 'msg' ? "status = 'ok'" : kind === 'issue' ? "status = 'failed'" : null;
  if (batches) out.push(`SELECT finished_at AS at, 'b' AS src, id FROM batches WHERE finished_at IS NOT NULL AND ${batches}`);
  if (kind === 'all' || kind === 'task') {
    out.push(`SELECT at, 'e' AS src, id FROM task_events WHERE task_id IS NOT NULL AND op IN (${list(TASK_OPS)})`);
  }
  const meetings = kind === 'all' ? [...MEET_STATUSES, ...ISSUE_STATUSES] : kind === 'meet' ? MEET_STATUSES : kind === 'issue' ? ISSUE_STATUSES : null;
  if (meetings) out.push(`SELECT updated_at AS at, 'm' AS src, id FROM meetings WHERE status IN (${list(meetings)})`);
  const audit = kind === 'all'
    ? `kind IN ('connection', 'config') OR (actor = 'agent' AND event IN ('${PUBLISHED}', '${PUBLISH_FAILED}'))`
    : kind === 'tracker' ? `actor = 'agent' AND event = '${PUBLISHED}'` : kind === 'issue' ? `actor = 'agent' AND event = '${PUBLISH_FAILED}'` : null;
  if (audit) out.push(`SELECT at, 'a' AS src, id FROM audit_log WHERE ${audit}`);
  return out;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

function batchItem(db: Db, id: number): Omit<ActivityItem, 'id' | 'at'> {
  const b = db.prepare(`SELECT b.status, b.message_count AS messages, b.accepted, c.name AS client FROM batches b JOIN clients c ON c.id = b.client_id
    WHERE b.id = ?`).get(id) as { status: string; messages: number; accepted: number | null; client: string };
  return b.status === 'ok'
    ? { kind: 'msg', title: `${plural(b.messages, 'message')} read`, detail: b.client, who: `${plural(b.accepted ?? 0, 'task')} changed` }
    : { kind: 'issue', title: `Could not read ${plural(b.messages, 'message')}`, detail: b.client, who: 'the agent tries again' };
}

const TASK_TITLES: Record<(typeof TASK_OPS)[number], string> = {
  add_task: 'Task created', update_task: 'Task updated', mark_maybe_done: 'Marked maybe done', close_task: 'Marked done', reopen_task: 'Reopened',
  unlock: 'Handed back to the agent', log_reminder: 'Reminder noted',
};

function taskItem(db: Db, id: number): Omit<ActivityItem, 'id' | 'at'> {
  const e = db.prepare(`SELECT e.op, e.actor, t.code, t.title, t.origin, t.meeting_id AS meetingId, c.name AS client,
      EXISTS (SELECT 1 FROM messages m JOIN media md ON md.message_id = m.id
        WHERE m.client_id = t.client_id AND m.wa_id = t.source_wa_id AND md.kind = 'voice') AS voice
    FROM task_events e JOIN tasks t ON t.id = e.task_id JOIN clients c ON c.id = t.client_id WHERE e.id = ?`).get(id) as {
    op: (typeof TASK_OPS)[number]; actor: 'ai' | 'human'; code: string; title: string; origin: string; meetingId: number | null; client: string; voice: number;
  };
  let who: string;
  if (e.op === 'add_task') {
    const from = e.meetingId !== null || e.origin === 'meeting' ? 'from a meeting' : e.voice === 1 ? 'from a voice note' : 'from WhatsApp';
    who = `${from} · ${e.client}`;
  } else {
    who = `${e.actor === 'human' ? 'by the owner' : 'by the agent'} · ${e.client}`;
  }
  return { kind: 'task', title: TASK_TITLES[e.op], detail: `${e.code} · ${e.title}`, who };
}

const MEETING_TITLES: Record<string, string> = {
  done: 'Meeting summary ready', unassigned: 'Meeting needs a client', queued: 'Meeting being processed', skipped: 'Meeting skipped',
  too_long: 'Meeting too long to process', no_access: 'No access to a meeting recording', failed: 'Meeting could not be processed',
};

function meetingItem(db: Db, id: number): Omit<ActivityItem, 'id' | 'at'> {
  const m = db.prepare(`SELECT m.status, m.title, COALESCE(m.audio_seconds, m.drive_seconds) AS seconds, c.name AS client,
      (SELECT COUNT(*) FROM tasks t WHERE t.meeting_id = m.id) AS items
    FROM meetings m LEFT JOIN clients c ON c.id = m.client_id WHERE m.id = ?`).get(id) as {
    status: MeetingStatus; title: string; seconds: number | null; client: string | null; items: number;
  };
  const issue = (ISSUE_STATUSES as readonly string[]).includes(m.status);
  let detail = m.client === null ? m.title : `${m.title} · ${m.client}`;
  if (m.status === 'too_long' && m.seconds !== null) detail += ` (${Math.round(m.seconds / 60)} min)`;
  const who = m.status === 'done' ? plural(m.items, 'action item') : m.status === 'too_long' ? 'over the length limit' : '';
  return { kind: issue ? 'issue' : 'meet', title: MEETING_TITLES[m.status] ?? 'Meeting changed', detail, who };
}

function auditItem(db: Db, id: number): Omit<ActivityItem, 'id' | 'at'> {
  const a = db.prepare('SELECT actor, event, kind, detail FROM audit_log WHERE id = ?').get(id) as { actor: string; event: string; kind: string; detail: string };
  const who = a.actor === 'agent' ? 'by the agent' : `by ${a.actor}`;
  if (a.event === PUBLISHED) return { kind: 'tracker', title: 'Tracker updated', detail: a.detail, who };
  if (a.event === PUBLISH_FAILED) return { kind: 'issue', title: 'Tracker upload failed', detail: a.detail, who };
  return a.kind === 'config'
    ? { kind: 'config', title: 'Setting changed', detail: a.detail, who }
    : { kind: 'connection', title: 'Connection changed', detail: a.detail, who };
}

const ITEMS: Record<Source, (db: Db, id: number) => Omit<ActivityItem, 'id' | 'at'>> = { a: auditItem, b: batchItem, e: taskItem, m: meetingItem };

/** One page of the feed, newest first. next: the cursor for the following page, or null when this page is the last. */
export function listActivity(db: Db, p: ActivityParams): { items: ActivityItem[]; next: string | null } {
  const union = sourcesFor(p.kind).join(' UNION ALL ');
  const params: Record<string, string | number> = { limit: p.limit };
  let where = '';
  if (p.before) {
    params.at = p.before.at;
    if (p.before.src === undefined) {
      where = 'WHERE at < @at';
    } else {
      where = 'WHERE (at, src, id) < (@at, @src, @id)';
      params.src = p.before.src;
      params.id = p.before.id!;
    }
  }
  const rows = db.prepare(`SELECT at, src, id FROM (${union}) ${where} ORDER BY at DESC, src DESC, id DESC LIMIT @limit`).all(params) as {
    at: string; src: Source; id: number;
  }[];
  const items = rows.map((r) => ({ id: `${r.src}:${r.id}`, ...ITEMS[r.src](db, r.id), at: r.at }));
  const last = rows.at(-1);
  return { items, next: rows.length === p.limit && last ? `${last.at}|${last.src}|${last.id}` : null };
}

const FAILURE_WORDS = (f: { step: 'build' | 'drive'; auth: boolean }): string =>
  f.step === 'build' ? 'the workbook could not be built' : f.auth ? 'Google sign-in expired' : 'Drive did not accept the upload';

/**
 * The DrivePublisher's onPublished and onFailure hooks, writing the agent's own rows for the Activity screen. The words
 * are fixed: the error itself (which can hold anything) never reaches the audit log.
 */
export function publisherAuditHooks(audit: Audit): { onPublished: () => void; onFailure: (f: { step: 'build' | 'drive'; auth: boolean }) => void } {
  const entry = (event: string, detail: string): AuditEntry => ({ actor: 'agent', event, kind: 'ops', detail });
  return {
    onPublished: () => audit(entry(PUBLISHED, 'Tracker.xlsx uploaded to Drive')),
    onFailure: (f) => audit(entry(PUBLISH_FAILED, `Tracker upload failed: ${FAILURE_WORDS(f)}`)),
  };
}
