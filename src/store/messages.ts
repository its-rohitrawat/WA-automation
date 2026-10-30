import type { Db, Sql } from './db.ts';
import { REQUEUING_FILE } from './media.ts';

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
export async function insertMessage(db: Sql, m: NewMessage): Promise<boolean> {
  const r = await db.run(`INSERT OR IGNORE INTO messages (wa_id, client_id, sender_jid, sender_number, sender_name, from_me, ts, text, quoted_wa_id, media_type)
      VALUES (@waId, @clientId, @senderJid, @senderNumber, @senderName, @fromMe, @ts, @text, @quotedWaId, @mediaType)`, { ...m, fromMe: m.fromMe ? 1 : 0 });
  return r.changes === 1;
}

/**
 * True for a message queued again because its file was read after the message was processed (amendment 12h). Such a
 * message was processed before even though processed_at and requeue_reason are both empty.
 */
const QUEUED_FOR_FILE = 'EXISTS (SELECT 1 FROM media WHERE media.message_id = messages.id AND media.requeued_for_text = 1)';

/** Keeps the previous text in message_edits and queues the message for the AI again. */
export async function applyEdit(db: Sql, clientId: number, waId: string, newText: string, editedAt: string): Promise<boolean> {
  const row = await db.get<{ id: number; text: string | null }>('SELECT id, text FROM messages WHERE client_id = ? AND wa_id = ?', [clientId, waId]);
  if (!row || row.text === newText) return false;
  await db.tx(async (q) => {
    await q.run('INSERT INTO message_edits (message_id, previous_text, edited_at) VALUES (?, ?, ?)', [row.id, row.text, editedAt]);
    await q.run(`UPDATE messages SET text = ?, edited_at = ?,
      requeue_reason = CASE WHEN processed_at IS NOT NULL OR requeue_reason = 'reaction' OR ${QUEUED_FOR_FILE} THEN 'edit' ELSE requeue_reason END,
      processed_at = NULL, version = version + 1, touch_reason = 'edit' WHERE id = ?`, [newText, editedAt, row.id]);
  });
  return true;
}

/** "Deleted for everyone": keep the row, flag it, exclude it from AI input, and mark tasks that came from it. */
export async function applyRevoke(db: Sql, clientId: number, waId: string): Promise<boolean> {
  const r = await db.run('UPDATE messages SET revoked = 1 WHERE client_id = ? AND wa_id = ? AND revoked = 0', [clientId, waId]);
  await db.run('UPDATE tasks SET source_revoked = 1 WHERE client_id = ? AND source_wa_id = ?', [clientId, waId]);
  return r.changes === 1;
}

/** An empty emoji means the reaction was removed. The row is kept with emoji ''. */
export async function upsertReaction(db: Sql, r: { clientId: number; targetWaId: string; reactorJid: string; emoji: string; ts: string }): Promise<void> {
  await db.tx(async (q) => {
    const prev = await q.get<{ emoji: string }>('SELECT emoji FROM reactions WHERE client_id = ? AND target_wa_id = ? AND reactor_jid = ?', [r.clientId, r.targetWaId, r.reactorJid]);
    await q.run(`INSERT INTO reactions (client_id, target_wa_id, reactor_jid, emoji, ts) VALUES (@clientId, @targetWaId, @reactorJid, @emoji, @ts)
      ON CONFLICT (client_id, target_wa_id, reactor_jid) DO UPDATE SET emoji = excluded.emoji, ts = excluded.ts`, r);
    if (r.emoji !== '' && (!prev || prev.emoji !== r.emoji)) {
      await q.run(`UPDATE messages SET version = version + 1, touch_reason = CASE WHEN touch_reason = 'edit' THEN 'edit' ELSE 'reaction' END
        WHERE client_id = ? AND wa_id = ? AND revoked = 0`, [r.clientId, r.targetWaId]);
      await q.run(`UPDATE messages SET requeue_reason = 'reaction', processed_at = NULL
        WHERE client_id = ? AND wa_id = ? AND revoked = 0 AND (processed_at IS NOT NULL OR (requeue_reason IS NULL AND ${QUEUED_FOR_FILE}))`, [r.clientId, r.targetWaId]);
    }
  });
}

export async function listUnprocessed(db: Sql, clientId: number, limit = 200): Promise<MessageRow[]> {
  return (
    (await db.all<RawMessage>('SELECT * FROM messages WHERE client_id = ? AND processed_at IS NULL AND revoked = 0 ORDER BY ts, id LIMIT ?', [clientId, limit]))
  ).map(toRow);
}

/** The latest processed messages, oldest first. With beforeTs, only those sent before it (ts < beforeTs). */
export async function listRecentProcessed(db: Sql, clientId: number, limit = 30, beforeTs?: string): Promise<MessageRow[]> {
  return (
    (await db.all<RawMessage>('SELECT * FROM messages WHERE client_id = ? AND processed_at IS NOT NULL AND revoked = 0 AND ts < ? ORDER BY ts DESC, id DESC LIMIT ?', [clientId, beforeTs ?? '9999-12-31T00:00:00.000Z', limit]))
  )
    .map(toRow)
    .reverse();
}

export async function markProcessed(db: Sql, ids: number[], at: string): Promise<void> {
  await db.tx(async (q) => {
    for (const id of ids) await q.run('UPDATE messages SET processed_at = ?, requeue_reason = NULL WHERE id = ?', [at, id]);
  });
}

/**
 * Job C, P2: a run calls this when it starts, after listing its batch and before the AI call. It clears touch_reason of
 * each row still at the version the run read, so markProcessedIfUnchanged labels a message queued again only by an edit
 * or a reaction made during the call, never by a touch from before the run (an edit before a message's first run,
 * followed by a reaction during it, is a reaction re-check, and the replay guard stays on). A row touched after the
 * listing has a higher version and keeps its touch. requeue_reason, the label the run shows, is left alone.
 */
export async function clearTouches(db: Sql, rows: { id: number; version: number }[]): Promise<void> {
  await db.tx(async (q) => {
    for (const r of rows) {
      await q.run('UPDATE messages SET touch_reason = NULL WHERE id = @id AND version = @version AND touch_reason IS NOT NULL', { id: r.id, version: r.version });
    }
  });
}

/**
 * Marks messages processed only if they are still at the version the run read. A row that changed in the meantime
 * stays queued with a re-check marker ('edit' or 'reaction'), because the operations from its old version were applied.
 * The marker is the touch made during the call (the run cleared older ones when it started, clearTouches), or else the
 * marker the run showed. Returns how many rows were skipped. Runs inside the caller's transaction.
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
export async function markProcessedIfUnchanged(
  q: Sql,
  rows: { id: number; version: number; fileUnread?: boolean; fileShown?: boolean }[],
  at: string,
): Promise<number> {
  const mark = (id: number, version: number) =>
    q.run('UPDATE messages SET processed_at = @at, requeue_reason = NULL, touch_reason = NULL WHERE id = @id AND version = @version', { at, id, version });
  const clearFlag = (id: number) => q.run('UPDATE media SET requeued_for_text = 0 WHERE message_id = ? AND requeued_for_text = 1', [id]);
  const requeue = (id: number) => q.run('UPDATE messages SET requeue_reason = COALESCE(touch_reason, requeue_reason) WHERE id = ?', [id]);
  // The same test as finishMedia's: an image, document, voice note or audio file read with a description, text or transcript
  // (never a backlog transcript), of a message not deleted for everyone.
  const flagReadFile = (id: number) =>
    q.run(`UPDATE media SET requeued_for_text = 1
    WHERE message_id = ? AND ${REQUEUING_FILE} AND message_id IN (SELECT id FROM messages WHERE revoked = 0)`, [id]);
  const fileOnly = (id: number, version: number) =>
    q.run('UPDATE messages SET requeue_reason = NULL, touch_reason = NULL WHERE id = @id AND version = @version + 1', { id, version });
  let skipped = 0;
  for (const r of rows) {
    if ((await mark(r.id, r.version)).changes > 0) {
      await clearFlag(r.id);
      continue;
    }
    skipped++;
    if (r.fileUnread && (await flagReadFile(r.id)).changes > 0 && (await fileOnly(r.id, r.version)).changes > 0) continue;
    await requeue(r.id);
    if (r.fileShown) await clearFlag(r.id);
  }
  return skipped;
}

/** Marks tasks whose source message was deleted for everyone (also catches a deletion that landed during an AI call). */
export async function flagRevokedSources(db: Sql, clientId: number): Promise<number> {
  return (await db.run(`UPDATE tasks SET source_revoked = 1 WHERE client_id = ? AND source_revoked = 0
      AND source_wa_id IN (SELECT wa_id FROM messages WHERE client_id = ? AND revoked = 1)`, [clientId, clientId])).changes;
}

export async function reactionsFor(db: Sql, clientId: number, waIds: string[]): Promise<StoredReactionRow[]> {
  if (waIds.length === 0) return [];
  return db.all<StoredReactionRow>(`SELECT target_wa_id AS targetWaId, reactor_jid AS reactorJid, emoji, ts FROM reactions
      WHERE client_id = ? AND emoji <> '' AND target_wa_id IN (SELECT value FROM json_each(?)) ORDER BY ts`, [clientId, JSON.stringify(waIds)]);
}

export async function lastActivity(db: Sql, clientId: number): Promise<string | null> {
  return (await db.get<{ ts: string | null }>('SELECT MAX(ts) AS ts FROM messages WHERE client_id = ?', [clientId]))!.ts;
}

export async function clientIdsWithUnprocessed(db: Sql): Promise<number[]> {
  return (
    (await db.all<{ id: number }>(`SELECT DISTINCT m.client_id AS id FROM messages m JOIN clients c ON c.id = m.client_id
        WHERE c.active = 1 AND m.processed_at IS NULL AND m.revoked = 0 ORDER BY m.client_id`))
  ).map((r) => r.id);
}

/** Used by `cli reprocess`: queues messages from a date onward for the AI again. */
/** Processed, non-revoked messages from sinceIso (inclusive) up to untilIso (exclusive, optional). */
export async function countProcessedBetween(db: Sql, clientId: number, sinceIso: string, untilIso?: string): Promise<number> {
  const r = (await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages WHERE client_id = ? AND processed_at IS NOT NULL AND revoked = 0 AND ts >= ? AND ts < ?', [clientId, sinceIso, untilIso ?? '9999-12-31T00:00:00.000Z']))!;
  return r.n;
}

/** Queues processed messages in the window for the AI again. Returns how many were actually re-queued. */
export async function resetProcessedSince(db: Sql, clientId: number, sinceIso: string, untilIso?: string): Promise<number> {
  return (await db.run('UPDATE messages SET processed_at = NULL WHERE client_id = ? AND processed_at IS NOT NULL AND revoked = 0 AND ts >= ? AND ts < ?', [clientId, sinceIso, untilIso ?? '9999-12-31T00:00:00.000Z'])).changes;
}

export async function unprocessedCounts(db: Sql): Promise<Map<number, number>> {
  const rows = await db.all<{ id: number; n: number }>('SELECT client_id AS id, COUNT(*) AS n FROM messages WHERE processed_at IS NULL AND revoked = 0 GROUP BY client_id');
  return new Map(rows.map((r) => [r.id, r.n]));
}
