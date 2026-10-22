import type { Db } from './db.ts';

export const MEDIA_KINDS = ['image', 'video', 'document', 'sticker', 'voice', 'audio'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];
export type MediaStatus = 'pending' | 'done' | 'failed' | 'unavailable' | 'metadata';
export type TextKind = 'description' | 'extract';

export interface NewMedia {
  messageId: number;
  clientId: number;
  kind: MediaKind;
  status: MediaStatus;
  mimeType: string | null;
  /** As the sender named it: untrusted, never used in a local path. */
  fileName: string | null;
  fileSize: number | null;
  seconds: number | null;
  /** Forwarded media is never sent to Claude for a paid description. */
  forwarded: boolean;
  /** Sealed download details (see src/media/ref.ts), or null. */
  refEnc: Buffer | null;
  errorCode: string | null;
  createdAt: string;
}

export interface MediaRow {
  id: number;
  messageId: number;
  clientId: number;
  kind: MediaKind;
  status: MediaStatus;
  mimeType: string | null;
  fileName: string | null;
  fileSize: number | null;
  seconds: number | null;
  forwarded: boolean;
  pageCount: number | null;
  /** Whether sealed download details are still stored. The details themselves are read only by getMediaRef. */
  hasRef: boolean;
  /** Relative to DATA_DIR, forward slashes. */
  localPath: string | null;
  sha256: string | null;
  textKind: TextKind | null;
  /** The stored text. From mediaForMessages, only its first maxChars characters. */
  text: string | null;
  /** Length of the whole stored text in characters (Unicode code points, as [...text] counts them), even when text holds only its start. */
  textChars: number | null;
  note: string | null;
  errorCode: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  driveFileId: string | null;
  /**
   * Amendment 12h: the file was read after its message was processed, so the message is queued again as a re-check.
   * markProcessedIfUnchanged clears it once that re-check is processed.
   */
  requeuedForText: boolean;
  createdAt: string;
  /** For a finished file, when it was finished (nothing changes it afterwards; uploads never touch it). */
  updatedAt: string;
}

interface RawMedia {
  id: number;
  message_id: number;
  client_id: number;
  kind: MediaKind;
  status: MediaStatus;
  mime_type: string | null;
  file_name: string | null;
  file_size: number | null;
  seconds: number | null;
  forwarded: number;
  page_count: number | null;
  has_ref: number;
  local_path: string | null;
  sha256: string | null;
  text_kind: TextKind | null;
  text: string | null;
  text_chars: number | null;
  note: string | null;
  error_code: string | null;
  attempts: number;
  next_attempt_at: string | null;
  drive_file_id: string | null;
  requeued_for_text: number;
  created_at: string;
  updated_at: string;
}

/** Every column except the sealed download details. textSql selects the text (all of it, or only its start). */
function columns(textSql: string): string {
  return `id, message_id, client_id, kind, status, mime_type, file_name, file_size, seconds, forwarded, page_count, ref_enc IS NOT NULL AS has_ref,
  local_path, sha256, text_kind, ${textSql} AS text, length(text) AS text_chars, note, error_code, attempts, next_attempt_at, drive_file_id,
  requeued_for_text, created_at, updated_at`;
}

const COLUMNS = columns('text');

function toRow(r: RawMedia): MediaRow {
  return {
    id: r.id,
    messageId: r.message_id,
    clientId: r.client_id,
    kind: r.kind,
    status: r.status,
    mimeType: r.mime_type,
    fileName: r.file_name,
    fileSize: r.file_size,
    seconds: r.seconds,
    forwarded: r.forwarded === 1,
    pageCount: r.page_count,
    hasRef: r.has_ref === 1,
    localPath: r.local_path,
    sha256: r.sha256,
    textKind: r.text_kind,
    text: r.text,
    textChars: r.text_chars,
    note: r.note,
    errorCode: r.error_code,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at,
    driveFileId: r.drive_file_id,
    requeuedForText: r.requeued_for_text === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function insertMedia(db: Db, m: NewMedia): number {
  return Number(
    db
      .prepare(`INSERT INTO media (message_id, client_id, kind, status, mime_type, file_name, file_size, seconds, forwarded, ref_enc, error_code,
          created_at, updated_at)
        VALUES (@messageId, @clientId, @kind, @status, @mimeType, @fileName, @fileSize, @seconds, @forwarded, @refEnc, @errorCode, @createdAt, @createdAt)`)
      .run({ ...m, forwarded: m.forwarded ? 1 : 0 }).lastInsertRowid,
  );
}

export function messageRowId(db: Db, clientId: number, waId: string): number | undefined {
  return (db.prepare('SELECT id FROM messages WHERE client_id = ? AND wa_id = ?').get(clientId, waId) as { id: number } | undefined)?.id;
}

export function getMedia(db: Db, id: number): MediaRow | undefined {
  const r = db.prepare(`SELECT ${COLUMNS} FROM media WHERE id = ?`).get(id) as RawMedia | undefined;
  return r ? toRow(r) : undefined;
}

/** The sealed download details. Secret: never log or return them anywhere else. */
export function getMediaRef(db: Db, id: number): Buffer | null {
  return (db.prepare('SELECT ref_enc FROM media WHERE id = ?').get(id) as { ref_enc: Buffer | null } | undefined)?.ref_enc ?? null;
}

/**
 * Pending files whose next attempt is due, in the order their messages were sent (history often arrives out of order).
 * Files of inactive clients wait until the client is active again.
 */
export function dueMediaIds(db: Db, nowIso: string, limit: number): number[] {
  return (
    db
      .prepare(`SELECT m.id FROM media m
        JOIN clients c ON c.id = m.client_id AND c.active = 1
        JOIN messages msg ON msg.id = m.message_id
        WHERE m.status = 'pending' AND (m.next_attempt_at IS NULL OR m.next_attempt_at <= ?)
        ORDER BY msg.ts, m.id LIMIT ?`)
      .all(nowIso, limit) as { id: number }[]
  ).map((r) => r.id);
}

export interface MediaJob {
  clientId: number;
  clientCode: string;
  waId: string;
  ts: string;
  revoked: boolean;
}

/** What processing one file needs to know about its message and client. */
export function mediaJob(db: Db, mediaId: number): MediaJob | undefined {
  const r = db
    .prepare(`SELECT m.client_id AS clientId, c.code AS clientCode, msg.wa_id AS waId, msg.ts AS ts, msg.revoked AS revoked
      FROM media m JOIN messages msg ON msg.id = m.message_id JOIN clients c ON c.id = m.client_id WHERE m.id = ?`)
    .get(mediaId) as (Omit<MediaJob, 'revoked'> & { revoked: number }) | undefined;
  return r ? { ...r, revoked: r.revoked === 1 } : undefined;
}

/** The original is on disk: the sealed download details are no longer needed and are wiped. */
export function markDownloaded(db: Db, id: number, d: { localPath: string; sha256: string; fileSize: number; at: string }): void {
  db.prepare('UPDATE media SET local_path = @localPath, sha256 = @sha256, file_size = @fileSize, ref_enc = NULL, updated_at = @at WHERE id = @id').run({ id, ...d });
}

/**
 * Amendment 12h: an SQL condition on the media table, true for a finished file whose text queues its message again: an
 * image or a document with a description or text. Only those two kinds (review M1): voice notes and audio never hold up
 * a message (12e), so text for them, such as a Phase 2b transcript, queues nothing; nor does any other kind.
 * finishMedia and markProcessedIfUnchanged (src/store/messages.ts) share it, so they never disagree about a file.
 */
export const REQUEUING_FILE = `media.kind IN ('image', 'document') AND media.status = 'done' AND media.text_kind IS NOT NULL
  AND media.text IS NOT NULL AND media.text <> ''`;

/**
 * The file has been read. NUL characters in the text are stored as spaces: SQLite's substr() and length() stop at the first one,
 * so mediaForMessages would otherwise cut the text there. A space rather than nothing keeps the words and numbers on either side apart.
 *
 * Amendment 12h, in the same transaction, when an image or a document finishes with a description or text
 * (REQUEUING_FILE; never for a message deleted for everyone):
 * - its message's version goes up by exactly 1, so a run that holds the message (and showed the file as still being
 *   read) does not mark it processed (markProcessedIfUnchanged);
 * - a message that was processed before (processed_at set, or queued again for an edit or a reaction) is queued again,
 *   and the file is flagged requeued_for_text, so the prompt marks the message "(re-check: file now read)".
 * A message never processed is not flagged: its next run sees the file like any other.
 */
export function finishMedia(db: Db, id: number, x: { textKind: TextKind | null; text: string | null; pageCount: number | null; note: string | null; at: string }): void {
  const text = x.text === null ? null : x.text.replaceAll('\u0000', ' ');
  db.transaction(() => {
    db.prepare(`UPDATE media SET status = 'done', text_kind = @textKind, text = @text, page_count = @pageCount, note = @note, error_code = NULL,
      next_attempt_at = NULL, ref_enc = NULL, updated_at = @at WHERE id = @id`).run({ id, ...x, text });
    // The flag first: it needs processed_at as it was before the message is queued again.
    db.prepare(`UPDATE media SET requeued_for_text = 1 WHERE id = ? AND ${REQUEUING_FILE} AND message_id IN
      (SELECT id FROM messages WHERE revoked = 0 AND (processed_at IS NOT NULL OR requeue_reason IS NOT NULL))`).run(id);
    db.prepare(`UPDATE messages SET processed_at = NULL, version = version + 1
      WHERE revoked = 0 AND id = (SELECT message_id FROM media WHERE id = ? AND ${REQUEUING_FILE})`).run(id);
  }).immediate();
}

/** A final failure. The sealed details are wiped; an original already saved stays on disk. */
export function failMedia(db: Db, id: number, f: { status: 'failed' | 'unavailable'; errorCode: string; at: string }): void {
  db.prepare('UPDATE media SET status = @status, error_code = @errorCode, next_attempt_at = NULL, ref_enc = NULL, updated_at = @at WHERE id = @id').run({ id, ...f });
}

/** Try again later. countAttempt is false when nothing was tried (for example the spend cap). */
export function deferMedia(db: Db, id: number, d: { errorCode: string; nextAttemptAt: string; countAttempt: boolean; at: string }): void {
  db.prepare('UPDATE media SET error_code = @errorCode, next_attempt_at = @nextAttemptAt, attempts = attempts + @inc, updated_at = @at WHERE id = @id').run({
    id,
    errorCode: d.errorCode,
    nextAttemptAt: d.nextAttemptAt,
    inc: d.countAttempt ? 1 : 0,
    at: d.at,
  });
}

/**
 * Files of the given messages, keyed by message row id. Long texts (up to a million characters) stay in the database:
 * text holds at most maxChars characters (pass the prompt's per-message cap + 1) and textChars is the full length,
 * so the prompt can say how much was cut.
 */
export function mediaForMessages(db: Db, messageIds: number[], maxChars: number): Map<number, MediaRow> {
  if (messageIds.length === 0) return new Map();
  const rows = db
    .prepare(`SELECT ${columns('substr(text, 1, @maxChars)')} FROM media WHERE message_id IN (SELECT value FROM json_each(@ids))`)
    .all({ maxChars, ids: JSON.stringify(messageIds) }) as RawMedia[];
  return new Map(rows.map((r) => [r.message_id, toRow(r)]));
}

export interface UploadCandidate {
  id: number;
  clientId: number;
  clientName: string;
  kind: MediaKind;
  mimeType: string | null;
  fileName: string | null;
  localPath: string;
  ts: string;
  driveAttempts: number;
}

/** The rows uploadCandidates returns, shared with isUploadCandidate so the two never disagree. Its one parameter is now. */
const UPLOAD_CANDIDATES_FROM = `FROM media m JOIN messages msg ON msg.id = m.message_id JOIN clients c ON c.id = m.client_id
      JOIN people p ON p.client_id = m.client_id AND p.jid = msg.sender_jid
      WHERE m.local_path IS NOT NULL AND m.drive_file_id IS NULL AND m.drive_failed = 0
        AND (m.drive_next_at IS NULL OR m.drive_next_at <= ?)
        AND m.kind IN ('image', 'document') AND msg.revoked = 0 AND msg.from_me = 0 AND p.role = 'client' AND c.active = 1`;

/**
 * Saved images and documents from people whose role is 'client', not yet in Drive and due for an attempt.
 * Never the founder's own messages, messages deleted for everyone, or inactive clients.
 */
export function uploadCandidates(db: Db, nowIso: string, limit: number): UploadCandidate[] {
  return db
    .prepare(`SELECT m.id, m.client_id AS clientId, c.name AS clientName, m.kind, m.mime_type AS mimeType, m.file_name AS fileName,
        m.local_path AS localPath, msg.ts, m.drive_attempts AS driveAttempts
      ${UPLOAD_CANDIDATES_FROM}
      ORDER BY m.id LIMIT ?`)
    .all(nowIso, limit) as UploadCandidate[];
}

/** Whether one file is still an upload candidate: checked again just before it is uploaded, since a pass can take minutes. */
export function isUploadCandidate(db: Db, mediaId: number, nowIso: string): boolean {
  return db.prepare(`SELECT 1 ${UPLOAD_CANDIDATES_FROM} AND m.id = ?`).get(nowIso, mediaId) !== undefined;
}

export function markUploaded(db: Db, id: number, driveFileId: string): void {
  db.prepare('UPDATE media SET drive_file_id = ?, drive_next_at = NULL WHERE id = ?').run(driveFileId, id);
}

/** failed: stop trying until the next service start. countAttempt false: a sign-in problem, not the file's fault. */
export function markUploadFailed(db: Db, id: number, f: { failed: boolean; nextAt: string | null; countAttempt: boolean }): void {
  db.prepare('UPDATE media SET drive_attempts = drive_attempts + @inc, drive_failed = @failed, drive_next_at = @nextAt WHERE id = @id').run({
    id,
    inc: f.countAttempt ? 1 : 0,
    failed: f.failed ? 1 : 0,
    nextAt: f.nextAt,
  });
}

/** At service start: uploads that gave up get a fresh set of attempts. Returns how many. */
export function resetUploadFailures(db: Db): number {
  return db.prepare('UPDATE media SET drive_failed = 0, drive_attempts = 0, drive_next_at = NULL WHERE drive_failed = 1 AND drive_file_id IS NULL').run().changes;
}

export interface ClientFileRow {
  id: number;
  kind: MediaKind;
  status: MediaStatus;
  mimeType: string | null;
  fileName: string | null;
  fileSize: number | null;
  seconds: number | null;
  pageCount: number | null;
  textKind: TextKind | null;
  /** The first 400 characters of the stored text. */
  textStart: string | null;
  note: string | null;
  errorCode: string | null;
  driveFileId: string | null;
  ts: string;
  revoked: boolean;
  sender: string | null;
}

/** How many files the client tab lists at most (the newest). */
export const CLIENT_FILES_LIMIT = 500;

/** Images, documents and videos sent by people whose role is 'client', newest first. View-once media is never listed. */
export function listClientFiles(db: Db, clientId: number, limit = CLIENT_FILES_LIMIT): ClientFileRow[] {
  const rows = db
    .prepare(`SELECT m.id, m.kind, m.status, m.mime_type AS mimeType, m.file_name AS fileName, m.file_size AS fileSize, m.seconds,
        m.page_count AS pageCount, m.text_kind AS textKind, substr(m.text, 1, 400) AS textStart, m.note, m.error_code AS errorCode,
        m.drive_file_id AS driveFileId, msg.ts, msg.revoked, COALESCE(p.name, msg.sender_name) AS sender
      FROM media m JOIN messages msg ON msg.id = m.message_id
      JOIN people p ON p.client_id = m.client_id AND p.jid = msg.sender_jid
      WHERE m.client_id = ? AND p.role = 'client' AND msg.from_me = 0 AND m.kind IN ('image', 'document', 'video')
        AND COALESCE(m.error_code, '') <> 'view_once'
      ORDER BY msg.ts DESC, m.id DESC LIMIT ?`)
    .all(clientId, limit) as (Omit<ClientFileRow, 'revoked'> & { revoked: number })[];
  return rows.map((r) => ({ ...r, revoked: r.revoked === 1 }));
}
