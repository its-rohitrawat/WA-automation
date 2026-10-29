import type { Db } from './db.ts';

// The dashboard's messages to a client's group (migration v12). One row per message the owner confirmed, keyed by the
// browser's uuid: a repeated request finds its row and never sends again. The order is fixed: claim (the row exists
// before anything leaves), sending (written before WhatsApp is asked), then sent, failed or unknown. A failed row
// surely did not go; an unknown one may have, and nothing here ever sends it again.

export type OutboxState = 'claimed' | 'sending' | 'sent' | 'failed' | 'unknown';

export interface OutboxRow {
  id: number;
  uuid: string;
  clientId: number;
  text: string;
  /** The stored message (messages.id) this one replies to. */
  replyTo: number | null;
  state: OutboxState;
  /** WhatsApp's id of the sent message: the founder's own copy comes back with it. */
  waId: string | null;
  errorCode: string | null;
  actor: string;
  createdAt: string;
  attemptedAt: string | null;
  finishedAt: string | null;
}

interface RawRow {
  id: number;
  uuid: string;
  client_id: number;
  text: string;
  reply_to: number | null;
  state: OutboxState;
  wa_id: string | null;
  error_code: string | null;
  actor: string;
  created_at: string;
  attempted_at: string | null;
  finished_at: string | null;
}

const toRow = (r: RawRow): OutboxRow => ({
  id: r.id, uuid: r.uuid, clientId: r.client_id, text: r.text, replyTo: r.reply_to, state: r.state, waId: r.wa_id, errorCode: r.error_code,
  actor: r.actor, createdAt: r.created_at, attemptedAt: r.attempted_at, finishedAt: r.finished_at,
});

export function outboxByUuid(db: Db, uuid: string): OutboxRow | undefined {
  const r = db.raw.prepare('SELECT * FROM outbox WHERE uuid = ?').get(uuid) as RawRow | undefined;
  return r ? toRow(r) : undefined;
}

/** Claims a message: the row exists, state claimed, before anything is sent. Throws on a uuid already used. */
export function claimOutbox(db: Db, o: { uuid: string; clientId: number; text: string; replyTo: number | null; actor: string; at: string }): OutboxRow {
  const r = db
    .raw.prepare("INSERT INTO outbox (uuid, client_id, text, reply_to, state, actor, created_at) VALUES (?, ?, ?, ?, 'claimed', ?, ?) RETURNING *")
    .get(o.uuid, o.clientId, o.text, o.replyTo, o.actor, o.at) as RawRow;
  return toRow(r);
}

/** Written before WhatsApp is asked: a crash after this leaves the row as "may have gone", never as "not sent". */
export function markSending(db: Db, id: number, at: string): void {
  db.raw.prepare("UPDATE outbox SET state = 'sending', attempted_at = ? WHERE id = ? AND state = 'claimed'").run(at, id);
}

export function finishOutbox(db: Db, id: number, o: { state: 'sent' | 'failed' | 'unknown'; waId?: string | null; errorCode?: string | null; at: string }): OutboxRow {
  const r = db
    .raw.prepare("UPDATE outbox SET state = ?, wa_id = ?, error_code = ?, finished_at = ? WHERE id = ? AND state IN ('claimed', 'sending') RETURNING *")
    .get(o.state, o.waId ?? null, o.errorCode ?? null, o.at, id) as RawRow | undefined;
  return r ? toRow(r) : toRow(db.raw.prepare('SELECT * FROM outbox WHERE id = ?').get(id) as RawRow);
}

/** When the latest message to this client's group was claimed, or null. */
export function lastClaimedAt(db: Db, clientId: number): string | null {
  return (db.raw.prepare('SELECT MAX(created_at) AS at FROM outbox WHERE client_id = ?').get(clientId) as { at: string | null }).at;
}

/** How many messages were claimed (to any group) since this time. */
export function claimedSince(db: Db, since: string): number {
  return (db.raw.prepare('SELECT COUNT(*) AS n FROM outbox WHERE created_at >= ?').get(since) as { n: number }).n;
}

/**
 * At start: a row still claimed was never sent (failed, interrupted_before_send); a row still sending may have gone
 * (unknown, interrupted). Neither is sent again.
 */
export function settleInterrupted(db: Db, at: string): { failed: number; unknown: number } {
  const failed = db.raw.prepare("UPDATE outbox SET state = 'failed', error_code = 'interrupted_before_send', finished_at = ? WHERE state = 'claimed'").run(at).changes;
  const unknown = db.raw.prepare("UPDATE outbox SET state = 'unknown', error_code = 'interrupted', finished_at = ? WHERE state = 'sending'").run(at).changes;
  return { failed, unknown };
}

/**
 * The client's messages from the dashboard that the chat shows on their own: not sent yet, not sent, may have gone, or
 * sent but the founder's own copy not stored yet (it is shown once: as the stored message once it is in). Since `since`.
 */
export function outboxToShow(db: Db, clientId: number, since: string): OutboxRow[] {
  return (db
    .raw.prepare(`SELECT o.* FROM outbox o WHERE o.client_id = ? AND o.created_at >= ?
      AND NOT (o.state = 'sent' AND EXISTS (SELECT 1 FROM messages m WHERE m.client_id = o.client_id AND m.wa_id = o.wa_id))
      ORDER BY o.created_at, o.id`)
    .all(clientId, since) as RawRow[]).map(toRow);
}

/**
 * The text of a message the dashboard sent to this group, by WhatsApp's id; undefined for any other message. Baileys asks
 * this when a member's phone could not read the message and asks for it again (a retry receipt).
 */
export function sentTextFor(db: Db, waId: string, groupId: string): string | undefined {
  const r = db
    .raw.prepare("SELECT o.text FROM outbox o JOIN clients c ON c.id = o.client_id WHERE o.wa_id = ? AND c.group_id = ? AND o.state = 'sent'")
    .get(waId, groupId) as { text: string } | undefined;
  return r?.text;
}
