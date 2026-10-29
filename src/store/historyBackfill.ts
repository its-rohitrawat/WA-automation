import type { Db, Sql } from './db.ts';
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
  /** The oldest message the answers have reached: the next request pages back from it. Null before the first answer. */
  cursor: { waId: string; fromMe: boolean; ts: string } | null;
  /** Messages this backfill stored itself (duplicates and messages kept earlier are not counted). */
  found: number;
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
      cursor: o.cursor && typeof o.cursor.waId === 'string' && typeof o.cursor.ts === 'string' ? { waId: o.cursor.waId, fromMe: o.cursor.fromMe === true, ts: o.cursor.ts } : null,
      found: Number.isInteger(o.found) ? o.found! : 0,
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
    state: 'waiting', requests: 0, empties: 0, timeouts: 0, failures: 0, cursor: null, found: 0, fetchingSince: null, finishedAt: null,
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
export async function listBackfills(db: Sql): Promise<Backfill[]> {
  // A range, not LIKE: "_" in the prefix would be a wildcard there.
  const rows = await db.all<{ k: string; v: string }>('SELECT k, v FROM kv WHERE k >= ? AND k < ? ORDER BY k', [PREFIX, `${PREFIX.slice(0, -1)};`]);
  return rows.flatMap((r) => parse(r.k.slice(PREFIX.length), r.v) ?? []);
}

/**
 * Where the first request pages back from: the group's oldest message since it was approved. Messages kept from an
 * earlier approval are not used, so the days the group was not approved are read too.
 */
export async function firstAnchor(db: Sql, clientId: number, until: string): Promise<{ waId: string; fromMe: boolean; ts: string } | undefined> {
  const r = await db.get<{ wa_id: string; from_me: number; ts: string }>('SELECT wa_id, from_me, ts FROM messages WHERE client_id = ? AND ts >= ? ORDER BY ts, id LIMIT 1', [clientId, until]);
  return r ? { waId: r.wa_id, fromMe: r.from_me === 1, ts: r.ts } : undefined;
}

/** The client's stored messages, to count what an answer added. */
export async function messageCount(db: Sql, clientId: number): Promise<number> {
  return (await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages WHERE client_id = ?', [clientId]))!.n;
}

/** How long a finished backfill shows on the Clients card. */
export const SHOW_DONE_MS = 7 * 86_400_000;

/** What the Clients card shows for a client; null when there is nothing to say. */
export type BackfillStatus = { state: 'waiting' | 'reading'; found: number } | { state: 'done'; found: number } | null;

/** The Clients card's line for a client: reading, waiting for the first message, or read (for a week after). */
export async function backfillStatus(db: Db, clientId: number, now: Date): Promise<BackfillStatus> {
  const b = (await listBackfills(db)).find((x) => x.clientId === clientId);
  if (!b || b.state === 'stopped') return null;
  const found = b.found;
  if (b.state === 'done') return b.finishedAt && now.getTime() - Date.parse(b.finishedAt) < SHOW_DONE_MS ? { state: 'done', found } : null;
  return { state: b.state === 'waiting' ? 'waiting' : 'reading', found };
}
