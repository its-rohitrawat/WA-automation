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
}

export interface ReactionRow {
  targetWaId: string;
  reactorJid: string;
  emoji: string;
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

/** Keeps the previous text in message_edits and queues the message for the AI again. */
export function applyEdit(db: Db, clientId: number, waId: string, newText: string, editedAt: string): boolean {
  const row = db.prepare('SELECT id, text FROM messages WHERE client_id = ? AND wa_id = ?').get(clientId, waId) as
    | { id: number; text: string | null }
    | undefined;
  if (!row || row.text === newText) return false;
  db.transaction(() => {
    db.prepare('INSERT INTO message_edits (message_id, previous_text, edited_at) VALUES (?, ?, ?)').run(row.id, row.text, editedAt);
    db.prepare('UPDATE messages SET text = ?, edited_at = ?, processed_at = NULL WHERE id = ?').run(newText, editedAt, row.id);
  })();
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
  db.prepare(`INSERT INTO reactions (client_id, target_wa_id, reactor_jid, emoji, ts) VALUES (@clientId, @targetWaId, @reactorJid, @emoji, @ts)
    ON CONFLICT (client_id, target_wa_id, reactor_jid) DO UPDATE SET emoji = excluded.emoji, ts = excluded.ts`).run(r);
}

export function listUnprocessed(db: Db, clientId: number, limit = 200): MessageRow[] {
  return (
    db.prepare('SELECT * FROM messages WHERE client_id = ? AND processed_at IS NULL AND revoked = 0 ORDER BY ts, id LIMIT ?').all(clientId, limit) as RawMessage[]
  ).map(toRow);
}

export function listRecentProcessed(db: Db, clientId: number, limit = 30): MessageRow[] {
  return (
    db
      .prepare('SELECT * FROM messages WHERE client_id = ? AND processed_at IS NOT NULL AND revoked = 0 ORDER BY ts DESC, id DESC LIMIT ?')
      .all(clientId, limit) as RawMessage[]
  )
    .map(toRow)
    .reverse();
}

export function markProcessed(db: Db, ids: number[], at: string): void {
  const stmt = db.prepare('UPDATE messages SET processed_at = ? WHERE id = ?');
  db.transaction(() => {
    for (const id of ids) stmt.run(at, id);
  })();
}

export function reactionsFor(db: Db, clientId: number, waIds: string[]): ReactionRow[] {
  if (waIds.length === 0) return [];
  return db
    .prepare(`SELECT target_wa_id AS targetWaId, reactor_jid AS reactorJid, emoji FROM reactions
      WHERE client_id = ? AND emoji <> '' AND target_wa_id IN (SELECT value FROM json_each(?)) ORDER BY ts`)
    .all(clientId, JSON.stringify(waIds)) as ReactionRow[];
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
export function resetProcessedSince(db: Db, clientId: number, sinceIso: string): number {
  return db.prepare('UPDATE messages SET processed_at = NULL WHERE client_id = ? AND ts >= ? AND revoked = 0').run(clientId, sinceIso).changes;
}
