import type { Db } from '../store/db.ts';
import { ControlError } from './errors.ts';

// The dashboard's Audit logs screen (D5 Task 4). Rows hold who did what, never tokens, cookies, QR codes or message
// text (spec 4.8). The request id stays in the table for the agent's own log: the screen does not need it.

export const AUDIT_KINDS = ['all', 'auth', 'config', 'connection', 'task', 'meeting', 'ops'] as const;
export type AuditFilter = (typeof AUDIT_KINDS)[number];

const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 200;
/** The default retention: the daily purge keeps 90 days. */
export const AUDIT_KEEP_DAYS = 90;

export interface AuditParams {
  kind: AuditFilter;
  limit: number;
  before?: { at: string; id: number };
}

export interface AuditRow {
  id: number;
  at: string;
  /** 'agent', an owner's email in full, or anyone else's email masked. */
  actor: string;
  event: string;
  kind: Exclude<AuditFilter, 'all'>;
  detail: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

/** Reads and checks the Audit screen's URL parameters. Throws ControlError (400) naming the bad field. */
export function parseAuditParams(p: URLSearchParams): AuditParams {
  const kind = p.get('kind') ?? '';
  if (kind !== '' && !(AUDIT_KINDS as readonly string[]).includes(kind)) throw new ControlError(400, `kind must be one of: ${AUDIT_KINDS.join(', ')}`, 'kind');
  const rawLimit = p.get('limit') ?? '';
  if (rawLimit !== '' && (!/^\d{1,9}$/.test(rawLimit) || Number(rawLimit) < 1)) throw new ControlError(400, 'limit must be a whole number of at least 1', 'limit');
  const out: AuditParams = { kind: (kind || 'all') as AuditFilter, limit: Math.min(rawLimit === '' ? LIMIT_DEFAULT : Number(rawLimit), LIMIT_MAX) };
  const before = p.get('before') ?? '';
  if (before !== '') {
    const m = /^([^|]+)\|([1-9]\d{0,14})$/.exec(before);
    if (!m || !ISO.test(m[1]!) || Number.isNaN(Date.parse(m[1]!))) throw new ControlError(400, 'before must come from the previous page', 'before');
    out.before = { at: m[1]!, id: Number(m[2]) };
  }
  return out;
}

/** "so••••@gmail.com": the first two letters before the @ and the domain. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) return '••••';
  return `${email.slice(0, Math.min(2, at))}••••${email.slice(at)}`;
}

/**
 * One page of the audit log, newest first. isOwner: whether an email is one of DASHBOARD_OWNER_EMAILS; only those are
 * shown in full (a refused sign-in names someone else, who is masked).
 */
export function listAudit(db: Db, p: AuditParams, isOwner: (email: string) => boolean): { rows: AuditRow[]; next: string | null } {
  const where: string[] = [];
  const params: Record<string, string | number> = { limit: p.limit };
  if (p.kind !== 'all') {
    where.push('kind = @kind');
    params.kind = p.kind;
  }
  if (p.before) {
    where.push('(at, id) < (@at, @id)');
    params.at = p.before.at;
    params.id = p.before.id;
  }
  const rows = db
    .prepare(`SELECT id, at, actor, event, kind, detail FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY at DESC, id DESC LIMIT @limit`)
    .all(params) as AuditRow[];
  const out = rows.map((r) => ({ ...r, actor: r.actor === 'agent' || isOwner(r.actor) ? r.actor : maskEmail(r.actor) }));
  const last = rows.at(-1);
  return { rows: out, next: rows.length === p.limit && last ? `${last.at}|${last.id}` : null };
}

/** The daily retention: removes rows older than `days` days before now. Returns how many went. */
export function purgeAuditOlderThan(db: Db, days: number, now: Date): number {
  if (!Number.isInteger(days) || days < 1) throw new Error('the audit log keeps at least one day');
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  return db.prepare('DELETE FROM audit_log WHERE at < ?').run(cutoff).changes;
}
