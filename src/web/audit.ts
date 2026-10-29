import type { Db } from '../store/db.ts';
import type { Clock } from '../util/clock.ts';
import { UNSAFE_TEXT } from './sessions.ts';

export const AUDIT_KINDS = ['auth', 'config', 'connection', 'task', 'meeting', 'ops'] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];
/** Longest detail kept; longer text is cut. */
export const AUDIT_DETAIL_MAX = 300;
const LIST_MAX = 500;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,32}$/;

export interface AuditInput {
  /** The owner's email, or `agent`. */
  actor: string;
  /** A short plain event name, such as `Signed in`. */
  event: string;
  kind: AuditKind;
  /** Plain text, already free of secrets: callers pass masked numbers and emails. Kept to one line of 300 characters. */
  detail: string;
  requestId?: string;
}

export interface AuditEntry {
  id: number;
  at: string;
  actor: string;
  event: string;
  kind: AuditKind;
  detail: string;
  requestId?: string;
}

interface Row {
  id: number;
  at: string;
  actor: string;
  event: string;
  kind: AuditKind;
  detail: string;
  request_id: string | null;
}

function oneLine(text: string): string {
  return text.replace(UNSAFE_TEXT, ' ').replace(/ {2,}/g, ' ').trim();
}

/**
 * Who did what, in `audit_log` (migration v9), for the dashboard's Audit screen. Never tokens, cookies, QR codes or
 * message text. `record` is synchronous and uses the caller's database connection, so it can run inside an action's
 * transaction.
 */
export class AuditLog {
  readonly #db: Db;
  readonly #clock: Clock;

  constructor(db: Db, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  record(e: AuditInput): void {
    if (!(AUDIT_KINDS as readonly string[]).includes(e.kind)) throw new Error('audit: unknown kind');
    const actor = oneLine(e.actor).slice(0, 120);
    const event = oneLine(e.event).slice(0, 80);
    if (actor === '') throw new Error('audit: actor is required');
    if (event === '') throw new Error('audit: event is required');
    const detail = oneLine(e.detail).slice(0, AUDIT_DETAIL_MAX);
    const requestId = e.requestId !== undefined && REQUEST_ID.test(e.requestId) ? e.requestId : null;
    this.#db
      .raw.prepare('INSERT INTO audit_log (at, actor, event, kind, detail, request_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(this.#clock.now().toISOString(), actor, event, e.kind, detail, requestId);
  }

  /**
   * Newest first (by entry id, which follows the order of recording). `before` is the id of the last entry already
   * shown, for the next page. `limit` is 1-500, default 100. For tests and tools only: the dashboard's Audit screen
   * reads through src/control/auditQueries.ts (filters, masked emails), and no route serves this list.
   */
  list(o: { kind?: AuditKind; before?: number; limit?: number } = {}): AuditEntry[] {
    const wanted = o.limit !== undefined && Number.isFinite(o.limit) ? Math.floor(o.limit) : 100;
    const limit = Math.min(LIST_MAX, Math.max(1, wanted));
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (o.kind !== undefined) {
      where.push('kind = ?');
      args.push(o.kind);
    }
    if (o.before !== undefined && Number.isFinite(o.before)) {
      where.push('id < ?');
      args.push(Math.floor(o.before));
    }
    const sql = `SELECT id, at, actor, event, kind, detail, request_id FROM audit_log${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
    const rows = this.#db.raw.prepare(sql).all(...args, limit) as Row[];
    return rows.map((r) => {
      const entry: AuditEntry = { id: r.id, at: r.at, actor: r.actor, event: r.event, kind: r.kind, detail: r.detail };
      if (r.request_id !== null) entry.requestId = r.request_id;
      return entry;
    });
  }

  /** Removes entries older than `days` days (default 90). Returns how many were removed. */
  purgeOlderThan(days = 90): number {
    const cutoff = new Date(this.#clock.now().getTime() - days * 86_400_000).toISOString();
    return this.#db.raw.prepare('DELETE FROM audit_log WHERE at < ?').run(cutoff).changes;
  }
}
