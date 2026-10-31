import type { Db, Sql } from './db.ts';

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

export async function outboxByUuid(db: Sql, uuid: string): Promise<OutboxRow | undefined> {
  const r = await db.get<RawRow>('SELECT * FROM outbox WHERE uuid = ?', [uuid]);
  return r ? toRow(r) : undefined;
}

/** Claims a message: the row exists, state claimed, before anything is sent. Throws on a uuid already used. */
export async function claimOutbox(db: Sql, o: { uuid: string; clientId: number; text: string; replyTo: number | null; actor: string; at: string }): Promise<OutboxRow> {
  const r = (await db.get<RawRow>(
    "INSERT INTO outbox (uuid, client_id, text, reply_to, state, actor, created_at) VALUES (?, ?, ?, ?, 'claimed', ?, ?) RETURNING *",
    [o.uuid, o.clientId, o.text, o.replyTo, o.actor, o.at],
  ))!;
  return toRow(r);
}

/** Written before WhatsApp is asked: a crash after this leaves the row as "may have gone", never as "not sent". */
export async function markSending(db: Sql, id: number, at: string): Promise<void> {
  await db.run("UPDATE outbox SET state = 'sending', attempted_at = ? WHERE id = ? AND state = 'claimed'", [at, id]);
}

export async function finishOutbox(db: Sql, id: number, o: { state: 'sent' | 'failed' | 'unknown'; waId?: string | null; errorCode?: string | null; at: string }): Promise<OutboxRow> {
  const r = await db.get<RawRow>(
    "UPDATE outbox SET state = ?, wa_id = ?, error_code = ?, finished_at = ? WHERE id = ? AND state IN ('claimed', 'sending') RETURNING *",
    [o.state, o.waId ?? null, o.errorCode ?? null, o.at, id],
  );
  return r ? toRow(r) : toRow((await db.get<RawRow>('SELECT * FROM outbox WHERE id = ?', [id]))!);
}

/** When the latest message to this client's group was claimed, or null. */
export async function lastClaimedAt(db: Sql, clientId: number): Promise<string | null> {
  return (await db.get<{ at: string | null }>('SELECT MAX(created_at) AS at FROM outbox WHERE client_id = ?', [clientId]))!.at;
}

/** How many messages were claimed (to any group) since this time. */
export async function claimedSince(db: Sql, since: string): Promise<number> {
  return (await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM outbox WHERE created_at >= ?', [since]))!.n;
}

/**
 * At start: a row still claimed was never sent (failed, interrupted_before_send); a row still sending may have gone
 * (unknown, interrupted). Neither is sent again.
 */
export async function settleInterrupted(db: Sql, at: string): Promise<{ failed: number; unknown: number }> {
  const failed = (await db.run("UPDATE outbox SET state = 'failed', error_code = 'interrupted_before_send', finished_at = ? WHERE state = 'claimed'", [at])).changes;
  const unknown = (await db.run("UPDATE outbox SET state = 'unknown', error_code = 'interrupted', finished_at = ? WHERE state = 'sending'", [at])).changes;
  return { failed, unknown };
}

/**
 * The client's messages from the dashboard that the chat shows on their own: not sent yet, not sent, may have gone, or
 * sent but the founder's own copy not stored yet (it is shown once: as the stored message once it is in). Since `since`.
 */
export async function outboxToShow(db: Sql, clientId: number, since: string): Promise<OutboxRow[]> {
  return (await db.all<RawRow>(
    `SELECT o.* FROM outbox o WHERE o.client_id = ? AND o.created_at >= ?
      AND NOT (o.state = 'sent' AND EXISTS (SELECT 1 FROM messages m WHERE m.client_id = o.client_id AND m.wa_id = o.wa_id))
      ORDER BY o.created_at, o.id`,
    [clientId, since],
  )).map(toRow);
}

/**
 * The text of a message the dashboard sent to this group, by WhatsApp's id; undefined for any other message. Baileys asks
 * this when a member's phone could not read the message and asks for it again (a retry receipt); the gateway's
 * retryMessage awaits it.
 */
export async function sentTextFor(db: Sql, waId: string, groupId: string): Promise<string | undefined> {
  const r = await db.get<{ text: string }>(
    "SELECT o.text FROM outbox o JOIN clients c ON c.id = o.client_id WHERE o.wa_id = ? AND c.group_id = ? AND o.state = 'sent'",
    [waId, groupId],
  );
  return r?.text;
}
