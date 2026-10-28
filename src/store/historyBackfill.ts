import type { Db } from './db.ts';
import { getKv, setKv } from './kv.ts';

// The 7-day history backfill of a newly approved group (owner decision, 28 Oct 2026), kept in kv so a restart carries
// on. One entry per group id: the group's own WhatsApp id is already in the clients table, nothing else is stored here.

/** How far back a newly approved group is read. */
export const BACKFILL_DAYS = 7;
const PREFIX = 'history_backfill:';

/**
 * waiting: no stored message of the group yet to page back from (the first new one becomes the anchor);
 * fetching: asking WhatsApp for earlier messages; done: reached 7 days, an empty answer or the request cap;
 * stopped: the group was unapproved meanwhile.
 */
export type BackfillState = 'waiting' | 'fetching' | 'done' | 'stopped';

export interface Backfill {
  groupId: string;
  clientId: number;
  /** Messages older than this are dropped (ISO). */
  since: string;
  /** When the group was approved (ISO): messages before it, from since on, count as earlier messages. */
  until: string;
  state: BackfillState;
  /** Requests sent to WhatsApp so far (capped). */
  requests: number;
  /** Answers in a row that brought nothing older. */
  empties: number;
  /** Requests with no answer in time (the phone may be offline): counted apart, with a longer wait. */
  timeouts: number;
  /** Requests that could not be sent (a send error): counted apart, with a growing wait. */
  failures: number;
  /** When fetching began (ISO), for how long the group's processing is held; null before. */
  fetchingSince: string | null;
  finishedAt: string | null;
}

const key = (groupId: string) => `${PREFIX}${groupId}`;

function parse(groupId: string, v: string | undefined): Backfill | undefined {
  if (v === undefined) return undefined;
  try {
    const o = JSON.parse(v) as Partial<Backfill>;
    if (typeof o.clientId !== 'number' || typeof o.since !== 'string' || typeof o.until !== 'string') return undefined;
    const state = (['waiting', 'fetching', 'done', 'stopped'] as const).find((s) => s === o.state) ?? 'stopped';
    return {
      groupId, clientId: o.clientId, since: o.since, until: o.until, state,
      requests: Number.isInteger(o.requests) ? o.requests! : 0, empties: Number.isInteger(o.empties) ? o.empties! : 0,
      timeouts: Number.isInteger(o.timeouts) ? o.timeouts! : 0, failures: Number.isInteger(o.failures) ? o.failures! : 0,
      fetchingSince: typeof o.fetchingSince === 'string' ? o.fetchingSince : null, finishedAt: typeof o.finishedAt === 'string' ? o.finishedAt : null,
    };
  } catch {
    return undefined;
  }
}

/** Queues (or restarts) the backfill of a group approved now: the 7 days before now. */
export function queueBackfill(db: Db, groupId: string, clientId: number, now: Date): void {
  saveBackfill(db, {
    groupId, clientId, since: new Date(now.getTime() - BACKFILL_DAYS * 86_400_000).toISOString(), until: now.toISOString(),
    state: 'waiting', requests: 0, empties: 0, timeouts: 0, failures: 0, fetchingSince: null, finishedAt: null,
  });
}

export function getBackfill(db: Db, groupId: string): Backfill | undefined {
  return parse(groupId, getKv(db, key(groupId)));
}

export function saveBackfill(db: Db, b: Backfill): void {
  const { groupId, ...rest } = b;
  setKv(db, key(groupId), JSON.stringify(rest));
}

/** Every backfill entry, finished ones too. */
export function listBackfills(db: Db): Backfill[] {
  // A range, not LIKE: "_" in the prefix would be a wildcard there.
  const rows = db.prepare('SELECT k, v FROM kv WHERE k >= ? AND k < ? ORDER BY k').all(PREFIX, `${PREFIX.slice(0, -1)};`) as { k: string; v: string }[];
  return rows.flatMap((r) => parse(r.k.slice(PREFIX.length), r.v) ?? []);
}

/** The group's oldest stored message: where the next request pages back from. */
export function oldestMessage(db: Db, clientId: number): { waId: string; fromMe: boolean; ts: string } | undefined {
  const r = db.prepare('SELECT wa_id, from_me, ts FROM messages WHERE client_id = ? ORDER BY ts, id LIMIT 1').get(clientId) as
    { wa_id: string; from_me: number; ts: string } | undefined;
  return r ? { waId: r.wa_id, fromMe: r.from_me === 1, ts: r.ts } : undefined;
}

/** Stored messages from since up to (not including) until: the earlier messages read. */
export function earlierCount(db: Db, b: Pick<Backfill, 'clientId' | 'since' | 'until'>): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE client_id = ? AND ts >= ? AND ts < ?').get(b.clientId, b.since, b.until) as { n: number }).n;
}

/** How long a finished backfill shows on the Clients card. */
export const SHOW_DONE_MS = 7 * 86_400_000;

/** What the Clients card shows for a client; null when there is nothing to say. */
export type BackfillStatus = { state: 'waiting' | 'reading'; found: number } | { state: 'done'; found: number } | null;

/** The Clients card's line for a client: reading, waiting for the first message, or read (for a week after). */
export function backfillStatus(db: Db, clientId: number, now: Date): BackfillStatus {
  const b = listBackfills(db).find((x) => x.clientId === clientId);
  if (!b || b.state === 'stopped') return null;
  const found = earlierCount(db, b);
  if (b.state === 'done') return b.finishedAt && now.getTime() - Date.parse(b.finishedAt) < SHOW_DONE_MS ? { state: 'done', found } : null;
  return { state: b.state === 'waiting' ? 'waiting' : 'reading', found };
}
