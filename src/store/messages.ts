import type { Db } from './db.ts';

export interface NewMessage {
  waId: string;
  clientId: number;
  senderJid: string;
  senderNumber: string | null;
  senderName: string | null;
  fromMe: boolean;
  ts: string;
  text: string | null;
  quotedWaId: string | null;
  mediaType: string | null;
}

export interface MessageRow extends NewMessage {
  id: number;
  editedAt: string | null;
  revoked: boolean;
  processedAt: string | null;
  requeueReason: 'edit' | 'reaction' | null;
  /** Bumped by every edit and significant reaction; lets a run see that a message changed during its AI call. */
  version: number;
}

export interface ReactionRow {
  targetWaId: string;
  reactorJid: string;
  emoji: string;
}

/** A stored reaction with the time it was last set. */
export interface StoredReactionRow extends ReactionRow {
  ts: string;
}

interface RawMessage {
  id: number;
  wa_id: string;
  client_id: number;
  sender_jid: string;
  sender_number: string | null;
  sender_name: string | null;
  from_me: number;
  ts: string;
  text: string | null;
  quoted_wa_id: string | null;
  media_type: string | null;
  edited_at: string | null;
  revoked: number;
  processed_at: string | null;
  requeue_reason: 'edit' | 'reaction' | null;
  version: number;
}

function toRow(r: RawMessage): MessageRow {
  return {
    id: r.id,
    waId: r.wa_id,
    clientId: r.client_id,
    senderJid: r.sender_jid,
    senderNumber: r.sender_number,
    senderName: r.sender_name,
    fromMe: r.from_me === 1,
    ts: r.ts,
    text: r.text,
    quotedWaId: r.quoted_wa_id,
    mediaType: r.media_type,
    editedAt: r.edited_at,
    revoked: r.revoked === 1,
    processedAt: r.processed_at,
    requeueReason: r.requeue_reason,
    version: r.version,
  };
}

/** Returns true when the message was new. */
export function insertMessage(db: Db, m: NewMessage): boolean {
  const r = db
    .prepare(`INSERT OR IGNORE INTO messages (wa_id, client_id, sender_jid, sender_number, sender_name, from_me, ts, text, quoted_wa_id, media_type)
      VALUES (@waId, @clientId, @senderJid, @senderNumber, @senderName, @fromMe, @ts, @text, @quotedWaId, @mediaType)`)
    .run({ ...m, fromMe: m.fromMe ? 1 : 0 });
  return r.changes === 1;
}

/**
 * True for a message queued again because its file was read after the message was processed (amendment 12h). Such a
 * message was processed before even though processed_at and requeue_reason are both empty.
 */
const QUEUED_FOR_FILE = 'EXISTS (SELECT 1 FROM media WHERE media.message_id = messages.id AND media.requeued_for_text = 1)';

/** Keeps the previous text in message_edits and queues the message for the AI again. */
export function applyEdit(db: Db, clientId: number, waId: string, newText: string, editedAt: string): boolean {
  const row = db.prepare('SELECT id, text FROM messages WHERE client_id = ? AND wa_id = ?').get(clientId, waId) as
    | { id: number; text: string | null }
    | undefined;
  if (!row || row.text === newText) return false;
  db.transaction(() => {
    db.prepare('INSERT INTO message_edits (message_id, previous_text, edited_at) VALUES (?, ?, ?)').run(row.id, row.text, editedAt);
    db.prepare(`UPDATE messages SET text = ?, edited_at = ?,
      requeue_reason = CASE WHEN processed_at IS NOT NULL OR requeue_reason = 'reaction' OR ${QUEUED_FOR_FILE} THEN 'edit' ELSE requeue_reason END,
      processed_at = NULL, version = version + 1, touch_reason = 'edit' WHERE id = ?`).run(newText, editedAt, row.id);
  }).immediate();
  return true;
}

/** "Deleted for everyone": keep the row, flag it, exclude it from AI input, and mark tasks that came from it. */
export function applyRevoke(db: Db, clientId: number, waId: string): boolean {
  const r = db.prepare('UPDATE messages SET revoked = 1 WHERE client_id = ? AND wa_id = ? AND revoked = 0').run(clientId, waId);
  db.prepare('UPDATE tasks SET source_revoked = 1 WHERE client_id = ? AND source_wa_id = ?').run(clientId, waId);
  return r.changes === 1;
}

/** An empty emoji means the reaction was removed. The row is kept with emoji ''. */
export function upsertReaction(db: Db, r: { clientId: number; targetWaId: string; reactorJid: string; emoji: string; ts: string }): void {
  db.transaction(() => {
    const prev = db.prepare('SELECT emoji FROM reactions WHERE client_id = ? AND target_wa_id = ? AND reactor_jid = ?').get(r.clientId, r.targetWaId, r.reactorJid) as
      | { emoji: string }
      | undefined;
    db.prepare(`INSERT INTO reactions (client_id, target_wa_id, reactor_jid, emoji, ts) VALUES (@clientId, @targetWaId, @reactorJid, @emoji, @ts)
      ON CONFLICT (client_id, target_wa_id, reactor_jid) DO UPDATE SET emoji = excluded.emoji, ts = excluded.ts`).run(r);
    if (r.emoji !== '' && (!prev || prev.emoji !== r.emoji)) {
      db.prepare(`UPDATE messages SET version = version + 1, touch_reason = CASE WHEN touch_reason = 'edit' THEN 'edit' ELSE 'reaction' END
        WHERE client_id = ? AND wa_id = ? AND revoked = 0`).run(r.clientId, r.targetWaId);
      db.prepare(`UPDATE messages SET requeue_reason = 'reaction', processed_at = NULL
        WHERE client_id = ? AND wa_id = ? AND revoked = 0 AND (processed_at IS NOT NULL OR (requeue_reason IS NULL AND ${QUEUED_FOR_FILE}))`)
        .run(r.clientId, r.targetWaId);
    }
  }).immediate();
}

export function listUnprocessed(db: Db, clientId: number, limit = 200): MessageRow[] {
  return (
    db.prepare('SELECT * FROM messages WHERE client_id = ? AND processed_at IS NULL AND revoked = 0 ORDER BY ts, id LIMIT ?').all(clientId, limit) as RawMessage[]
  ).map(toRow);
}

/** The latest processed messages, oldest first. With beforeTs, only those sent before it (ts < beforeTs). */
export function listRecentProcessed(db: Db, clientId: number, limit = 30, beforeTs?: string): MessageRow[] {
  return (
    db
      .prepare('SELECT * FROM messages WHERE client_id = ? AND processed_at IS NOT NULL AND revoked = 0 AND ts < ? ORDER BY ts DESC, id DESC LIMIT ?')
      .all(clientId, beforeTs ?? '9999-12-31T00:00:00.000Z', limit) as RawMessage[]
  )
    .map(toRow)
    .reverse();
}

export function markProcessed(db: Db, ids: number[], at: string): void {
  const stmt = db.prepare('UPDATE messages SET processed_at = ?, requeue_reason = NULL WHERE id = ?');
  db.transaction(() => {
    for (const id of ids) stmt.run(at, id);
  }).immediate();
}

/**
 * Marks messages processed only if they are still at the version the run read. A row that changed in the meantime
 * stays queued with a re-check marker ('edit' or 'reaction'), because the operations from its old version were applied.
 * Returns how many rows were skipped. Runs inside the caller's transaction.
 *
 * Amendment 12h: marking a message processed clears its file's requeued_for_text.
 * - fileUnread: the run showed the message's file as still being read. If that file was read during the call
 *   (finishMedia moved the version), the message stays queued with the flag set, so the next run shows the text as a
 *   "file now read" re-check. finishMedia adds exactly 1 to the version, so a version one past the run's means nothing
 *   else changed: the message is then a plain file re-check, and an edit or reaction label left from before the run
 *   (touch_reason, requeue_reason) is cleared rather than shown again (review I1).
 * - fileShown: the run showed the file's text as a "file now read" re-check. If the mark fails (an edit or a reaction
 *   during the call), the flag is cleared too: the next run needs only the edit or reaction marker (review M2).
 */
export function markProcessedIfUnchanged(
  db: Db,
  rows: { id: number; version: number; fileUnread?: boolean; fileShown?: boolean }[],
  at: string,
): number {
  const mark = db.prepare('UPDATE messages SET processed_at = @at, requeue_reason = NULL, touch_reason = NULL WHERE id = @id AND version = @version');
  const clearFlag = db.prepare('UPDATE media SET requeued_for_text = 0 WHERE message_id = ? AND requeued_for_text = 1');
  const requeue = db.prepare('UPDATE messages SET requeue_reason = COALESCE(touch_reason, requeue_reason) WHERE id = ?');
  // The same test as finishMedia's: a finished file with a description or text, of a message not deleted for everyone.
  const flagReadFile = db.prepare(`UPDATE media SET requeued_for_text = 1
    WHERE message_id = ? AND status = 'done' AND text_kind IS NOT NULL AND text IS NOT NULL AND text <> ''
      AND message_id IN (SELECT id FROM messages WHERE revoked = 0)`);
  const fileOnly = db.prepare('UPDATE messages SET requeue_reason = NULL, touch_reason = NULL WHERE id = @id AND version = @version + 1');
  let skipped = 0;
  for (const r of rows) {
    if (mark.run({ at, id: r.id, version: r.version }).changes > 0) {
      clearFlag.run(r.id);
      continue;
    }
    skipped++;
    if (r.fileUnread && flagReadFile.run(r.id).changes > 0 && fileOnly.run({ id: r.id, version: r.version }).changes > 0) continue;
    requeue.run(r.id);
    if (r.fileShown) clearFlag.run(r.id);
  }
  return skipped;
}

/** Marks tasks whose source message was deleted for everyone (also catches a deletion that landed during an AI call). */
export function flagRevokedSources(db: Db, clientId: number): number {
  return db
    .prepare(`UPDATE tasks SET source_revoked = 1 WHERE client_id = ? AND source_revoked = 0
      AND source_wa_id IN (SELECT wa_id FROM messages WHERE client_id = ? AND revoked = 1)`)
    .run(clientId, clientId).changes;
}

export function reactionsFor(db: Db, clientId: number, waIds: string[]): StoredReactionRow[] {
  if (waIds.length === 0) return [];
  return db
    .prepare(`SELECT target_wa_id AS targetWaId, reactor_jid AS reactorJid, emoji, ts FROM reactions
      WHERE client_id = ? AND emoji <> '' AND target_wa_id IN (SELECT value FROM json_each(?)) ORDER BY ts`)
    .all(clientId, JSON.stringify(waIds)) as StoredReactionRow[];
}

export function lastActivity(db: Db, clientId: number): string | null {
  return (db.prepare('SELECT MAX(ts) AS ts FROM messages WHERE client_id = ?').get(clientId) as { ts: string | null }).ts;
}

export function clientIdsWithUnprocessed(db: Db): number[] {
  return (
    db
      .prepare(`SELECT DISTINCT m.client_id AS id FROM messages m JOIN clients c ON c.id = m.client_id
        WHERE c.active = 1 AND m.processed_at IS NULL AND m.revoked = 0 ORDER BY m.client_id`)
      .all() as { id: number }[]
  ).map((r) => r.id);
}

/** Used by `cli reprocess`: queues messages from a date onward for the AI again. */
/** Processed, non-revoked messages from sinceIso (inclusive) up to untilIso (exclusive, optional). */
export function countProcessedBetween(db: Db, clientId: number, sinceIso: string, untilIso?: string): number {
  const r = db
    .prepare('SELECT COUNT(*) AS n FROM messages WHERE client_id = ? AND processed_at IS NOT NULL AND revoked = 0 AND ts >= ? AND ts < ?')
    .get(clientId, sinceIso, untilIso ?? '9999-12-31T00:00:00.000Z') as { n: number };
  return r.n;
}

/** Queues processed messages in the window for the AI again. Returns how many were actually re-queued. */
export function resetProcessedSince(db: Db, clientId: number, sinceIso: string, untilIso?: string): number {
  return db
    .prepare('UPDATE messages SET processed_at = NULL WHERE client_id = ? AND processed_at IS NOT NULL AND revoked = 0 AND ts >= ? AND ts < ?')
    .run(clientId, sinceIso, untilIso ?? '9999-12-31T00:00:00.000Z').changes;
}

export function unprocessedCounts(db: Db): Map<number, number> {
  const rows = db
    .prepare('SELECT client_id AS id, COUNT(*) AS n FROM messages WHERE processed_at IS NULL AND revoked = 0 GROUP BY client_id')
    .all() as { id: number; n: number }[];
  return new Map(rows.map((r) => [r.id, r.n]));
}
