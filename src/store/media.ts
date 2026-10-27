import { showsText } from '../media/paths.ts';
import type { ProviderId } from '../stt/types.ts';
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
  /**
   * A 2a voice note queued by `cli transcribe-voice` (V6) after its message was processed: its transcript is stored for the
   * record and never queues its message again.
   */
  backlog: boolean;
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
  backlog: number;
  created_at: string;
  updated_at: string;
}

/** Every column except the sealed download details. textSql selects the text (all of it, or only its start). */
function columns(textSql: string): string {
  return `id, message_id, client_id, kind, status, mime_type, file_name, file_size, seconds, forwarded, page_count, ref_enc IS NOT NULL AS has_ref,
  local_path, sha256, text_kind, ${textSql} AS text, length(text) AS text_chars, note, error_code, attempts, next_attempt_at, drive_file_id,
  requeued_for_text, backlog, created_at, updated_at`;
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
    backlog: r.backlog === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Records a file of a stored message. The row is written only when messageId is a message of clientId (T1-09): every
 * later step files the original, the Drive copy and Files received by the row's client, so a mismatch is refused here.
 */
export function insertMedia(db: Db, m: NewMedia): number {
  const r = db
    .prepare(`INSERT INTO media (message_id, client_id, kind, status, mime_type, file_name, file_size, seconds, forwarded, ref_enc, error_code,
        created_at, updated_at)
      SELECT id, client_id, @kind, @status, @mimeType, @fileName, @fileSize, @seconds, @forwarded, @refEnc, @errorCode, @createdAt, @createdAt
      FROM messages WHERE id = @messageId AND client_id = @clientId`)
    .run({ ...m, forwarded: m.forwarded ? 1 : 0 });
  if (r.changes === 0) throw new Error(`insertMedia: message ${m.messageId} is not a message of client ${m.clientId}`);
  return Number(r.lastInsertRowid);
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
 * Live files come before backlog files (`cli transcribe-voice`, V6), so a long backlog never holds up a new voice note
 * its message is waiting for. Files of inactive clients wait until the client is active again.
 * `o.audio` (the media queue's voice lane, Phase 2b Task 10): true lists only voice notes and audio files, false only the
 * other files; absent, every file.
 */
export function dueMediaIds(db: Db, nowIso: string, limit: number, o: { audio?: boolean } = {}): number[] {
  const kinds = o.audio === undefined ? '' : o.audio ? "AND m.kind IN ('voice', 'audio')" : "AND m.kind NOT IN ('voice', 'audio')";
  return (
    db
      .prepare(`SELECT m.id FROM media m
        JOIN clients c ON c.id = m.client_id AND c.active = 1
        JOIN messages msg ON msg.id = m.message_id
        WHERE m.status = 'pending' AND (m.next_attempt_at IS NULL OR m.next_attempt_at <= ?) ${kinds}
        ORDER BY m.backlog, msg.ts, m.id LIMIT ?`)
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
 * image, a document, a voice note or an audio file with a description, text or transcript. Voice notes and audio hold up
 * a message like a picture does (V1), so a transcript that arrives late re-checks it like a picture's description; a
 * backlog transcript (backlog = 1, `cli transcribe-voice`) is stored for the record and never does (V6). No other kind
 * queues anything (review M1).
 * finishMedia and markProcessedIfUnchanged (src/store/messages.ts) share it, so they never disagree about a file.
 * finishMedia stores text that shows nothing as NULL, so such a file never matches; the prompt then shows it as read
 * without text (src/media/promptText.ts).
 */
export const REQUEUING_FILE = `media.kind IN ('image', 'document', 'voice', 'audio') AND media.backlog = 0 AND media.status = 'done'
  AND media.text_kind IS NOT NULL AND media.text IS NOT NULL AND media.text <> ''`;

/**
 * Notes a speech provider's stored copy for deletion (N1), shared by finishMedia and noteMediaForget. ON CONFLICT rather
 * than OR IGNORE: a copy already noted is kept, but a ref the CHECK refuses still throws.
 */
const NOTE_FORGET = `INSERT INTO media_stt_forget (media_id, provider, ref, created_at) VALUES (@id, @provider, @ref, @at)
  ON CONFLICT (provider, ref) DO NOTHING`;

/**
 * The file has been read. NUL characters in the text are stored as spaces: SQLite's substr() and length() stop at the first one,
 * so mediaForMessages would otherwise cut the text there. A space rather than nothing keeps the words and numbers on either side apart.
 * Text that shows nothing (only spaces, NULs or zero-width characters: showsText) is stored as no text (NULL), so the
 * file is finished without text, like an empty extract: it never queues its message for a paid run that would show an
 * empty block.
 *
 * Only a pending file is finished. A second finish of the same file changes nothing and queues nothing (12h hardening),
 * so the version never moves by more than 1 for one file.
 *
 * Amendment 12h, in the same transaction, when an image, a document, a voice note or an audio file finishes with a
 * description, text or transcript (REQUEUING_FILE: never a backlog transcript, never for a message deleted for everyone):
 * - its message's version goes up by exactly 1, so a run that holds the message (and showed the file as still being
 *   read) does not mark it processed (markProcessedIfUnchanged);
 * - a message that was processed before (processed_at set, or queued again for an edit or a reaction) is queued again,
 *   and the file is flagged requeued_for_text, so the prompt marks the message "(re-check: file now read)".
 * A message never processed is not flagged: its next run sees the file like any other.
 *
 * forget (N1): the speech provider kept a copy of the transcript. It is noted in media_stt_forget in the same
 * transaction, so a transcript is never stored without its copy noted for deletion. The copy is noted whether or not
 * this finish stored the transcript (the file already finished or failed): the provider holds it either way. A copy
 * already noted (the same provider and ref) is noted once.
 */
export function finishMedia(
  db: Db,
  id: number,
  x: {
    textKind: TextKind | null;
    text: string | null;
    pageCount: number | null;
    note: string | null;
    at: string;
    forget?: { provider: ProviderId; ref: string } | null;
  },
): void {
  const { forget, ...fields } = x;
  const spaced = fields.text === null ? null : fields.text.replaceAll('\u0000', ' ');
  const text = spaced !== null && showsText(spaced) ? spaced : null;
  db.transaction(() => {
    const finished = db.prepare(`UPDATE media SET status = 'done', text_kind = @textKind, text = @text, page_count = @pageCount, note = @note, error_code = NULL,
      next_attempt_at = NULL, ref_enc = NULL, updated_at = @at WHERE id = @id AND status = 'pending'`).run({ id, ...fields, text }).changes;
    if (forget) {
      // ON CONFLICT rather than OR IGNORE: a copy already noted is kept, but a ref the CHECK refuses still throws, so the
      // finish is undone instead of a transcript stored with its copy silently never deleted.
      db.prepare(NOTE_FORGET).run({ id, provider: forget.provider, ref: forget.ref, at: fields.at });
    }
    if (finished === 0) return; // already finished (or failed): nothing to flag or queue again
    // The flag first: it needs processed_at as it was before the message is queued again.
    db.prepare(`UPDATE media SET requeued_for_text = 1 WHERE id = ? AND ${REQUEUING_FILE} AND message_id IN
      (SELECT id FROM messages WHERE revoked = 0 AND (processed_at IS NOT NULL OR requeue_reason IS NOT NULL))`).run(id);
    db.prepare(`UPDATE messages SET processed_at = NULL, version = version + 1
      WHERE revoked = 0 AND id = (SELECT message_id FROM media WHERE id = ? AND ${REQUEUING_FILE})`).run(id);
  }).immediate();
}

/**
 * Notes a speech provider's stored copy of a voice transcript for deletion (N1) outside a finish: the copy an unreadable
 * answer still named (Phase 3's M7), written by the processor when that error ends a run. A copy already noted (the
 * same provider and ref) is noted once; a ref the CHECK refuses throws.
 */
export function noteMediaForget(db: Db, id: number, f: { provider: ProviderId; ref: string; at: string }): void {
  db.prepare(NOTE_FORGET).run({ id, ...f });
}

/** A final failure. The sealed details are wiped; an original already saved stays on disk. */
export function failMedia(db: Db, id: number, f: { status: 'failed' | 'unavailable'; errorCode: string; at: string }): void {
  db.prepare('UPDATE media SET status = @status, error_code = @errorCode, next_attempt_at = NULL, ref_enc = NULL, updated_at = @at WHERE id = @id').run({ id, ...f });
}

/**
 * Final review FR1: claims a pending file before it is downloaded, decoded or read. In one committed write the attempt
 * is counted and the next attempt moves to nextAttemptAt (about 15 minutes ahead), so a run that never ends (the process
 * stopped) leaves the file waiting with one attempt used, and a database that cannot be written stops the run before
 * anything is paid. The error code is kept: the waits of amendment 10d read the last one back. Returns false when the
 * file is no longer pending.
 */
export function claimMedia(db: Db, id: number, c: { nextAttemptAt: string; at: string }): boolean {
  return (
    db.prepare(`UPDATE media SET attempts = attempts + 1, next_attempt_at = @nextAttemptAt, updated_at = @at WHERE id = @id AND status = 'pending'`).run({ id, ...c })
      .changes === 1
  );
}

/**
 * Try again later. countAttempt is false when nothing was tried (for example the spend cap). `attempts`, when given
 * instead, is stored as it is: the processor passes the count from before its claim, or that count plus one.
 */
export function deferMedia(
  db: Db,
  id: number,
  d: { errorCode: string; nextAttemptAt: string; at: string } & ({ countAttempt: boolean; attempts?: never } | { attempts: number; countAttempt?: never }),
): void {
  db.prepare('UPDATE media SET error_code = @errorCode, next_attempt_at = @nextAttemptAt, attempts = COALESCE(@attempts, attempts + @inc), updated_at = @at WHERE id = @id').run({
    id,
    errorCode: d.errorCode,
    nextAttemptAt: d.nextAttemptAt,
    inc: d.countAttempt ? 1 : 0,
    attempts: d.attempts ?? null,
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

export interface VoiceBacklogRow {
  id: number;
  clientId: number;
  /** Bytes on disk: `cli transcribe-voice` works out the longest each file can be from it (V5, N4). */
  fileSize: number | null;
  /** As WhatsApp declared it: `cli transcribe-voice` skips, and counts, files that need ffmpeg when it is missing (canSend, N2). */
  mimeType: string | null;
}

/**
 * The 2a backlog (V6), shared by voiceBacklog and queueVoiceBacklog so the listing and the queueing never disagree: a
 * saved voice note or audio file that was finished without a transcript and without an error, its message not deleted
 * for everyone, its client active. A file noted format_not_supported (no ffmpeg then, N2) is included, so installing
 * ffmpeg lets the command pick it up; any other note (too_long, forwarded_not_transcribed, no_speech, too_costly,
 * revoked) is final.
 * Whether it was queued as backlog before does not matter (Phase 2b final review): a backlog file that finished again
 * with no transcriber (voice notes switched off while it waited) has no text and no note, so it is listed again rather
 * than stuck. A transcript always sets text_kind, even one stored as no text (finishMedia stores text that shows nothing
 * as NULL), so `text_kind IS NULL` keeps every file that was transcribed out, backlog or not.
 */
const VOICE_BACKLOG_FROM = `FROM media m JOIN messages msg ON msg.id = m.message_id JOIN clients c ON c.id = m.client_id AND c.active = 1
      WHERE m.kind IN ('voice', 'audio') AND m.status = 'done' AND m.text IS NULL AND m.text_kind IS NULL
        AND (m.note IS NULL OR m.note = 'format_not_supported') AND m.error_code IS NULL AND m.local_path IS NOT NULL AND msg.revoked = 0`;

/**
 * The error codes of a voice note or audio file that failed on this computer, never at a paid provider (Phase 2b final
 * review): the local engine's own (local_<code>: local_empty_output, local_timeout, local_exit_<n>, local_no_output,
 * local_aborted after 24 hours) and ffmpeg's (audio_convert_failed, audio_no_duration, audio_split_failed). An SQL
 * condition on m (media). The underscore is escaped: in LIKE it matches any one character. Never an stt_* code: those
 * failed at a paid provider and may have been paid. Shared by mediaStats (voiceFailed) and the --failed listing.
 */
const LOCAL_FAILURE = `(m.error_code LIKE 'local\\_%' ESCAPE '\\' OR m.error_code IN ('audio_convert_failed', 'audio_no_duration', 'audio_split_failed'))`;

/**
 * Failed voice notes and audio files `cli transcribe-voice --failed` can queue again, shared by failedLocalVoice and
 * queueFailedLocalVoice as the backlog's FROM is: failed on this computer (LOCAL_FAILURE), the original still saved, its
 * message not deleted for everyone, its client active.
 */
const FAILED_LOCAL_VOICE_FROM = `FROM media m JOIN messages msg ON msg.id = m.message_id JOIN clients c ON c.id = m.client_id AND c.active = 1
      WHERE m.kind IN ('voice', 'audio') AND m.status = 'failed' AND ${LOCAL_FAILURE} AND m.local_path IS NOT NULL AND msg.revoked = 0`;

/**
 * The fields a file queued again by `cli transcribe-voice` gets (V6), shared by queueVoiceBacklog and
 * queueFailedLocalVoice: pending with a fresh set of attempts, no error, no note, created now; backlog = 1 only when
 * its message is processed and not queued again for an edit or a reaction.
 */
const REQUEUE_SET = `status = 'pending', attempts = 0, next_attempt_at = NULL, error_code = NULL, note = NULL, created_at = @at, updated_at = @at,
        backlog = (SELECT msg.processed_at IS NOT NULL AND msg.requeue_reason IS NULL FROM messages msg WHERE msg.id = media.message_id)`;

/** The 2a voice notes and audio files `cli transcribe-voice` can transcribe, oldest first; optionally one client's only. */
export function voiceBacklog(db: Db, o: { clientId?: number } = {}): VoiceBacklogRow[] {
  return db
    .prepare(`SELECT m.id, m.client_id AS clientId, m.file_size AS fileSize, m.mime_type AS mimeType ${VOICE_BACKLOG_FROM}
      AND (@clientId IS NULL OR m.client_id = @clientId) ORDER BY m.id`)
    .all({ clientId: o.clientId ?? null }) as VoiceBacklogRow[];
}

/**
 * Queues the given backlog files for transcription (V6): pending again with a fresh set of attempts and no note.
 * - backlog = 1 when the file's message is already processed: its transcript is stored for the record only and never
 *   queues the message again (REQUEUING_FILE). A message not processed yet (still queued, or queued again for an edit or
 *   a reaction) gets backlog = 0: its next run reads the transcript like a live file's.
 * - created_at moves to the queueing: the file's waits (Health's stale count, the processor's 24 hours, the
 *   reconciler's 30 minutes) count from now, not from an arrival days or weeks before.
 * Each file is checked against the backlog conditions again, so one that changed since it was listed (now transcribed,
 * its message deleted for everyone, its client inactive) is left alone. One statement, so the files are queued all
 * together or not at all. Returns how many were queued.
 */
export function queueVoiceBacklog(db: Db, ids: number[], at: string): number {
  if (ids.length === 0) return 0;
  return db
    .prepare(`UPDATE media SET ${REQUEUE_SET}
      WHERE id IN (SELECT value FROM json_each(@ids)) AND id IN (SELECT m.id ${VOICE_BACKLOG_FROM})`)
    .run({ ids: JSON.stringify(ids), at }).changes;
}

/**
 * Voice notes and audio files that failed on this computer (the local engine or ffmpeg, never a paid provider), which
 * `cli transcribe-voice --failed` can queue again; oldest first, optionally one client's only. Same shape as the backlog.
 */
export function failedLocalVoice(db: Db, o: { clientId?: number } = {}): VoiceBacklogRow[] {
  return db
    .prepare(`SELECT m.id, m.client_id AS clientId, m.file_size AS fileSize, m.mime_type AS mimeType ${FAILED_LOCAL_VOICE_FROM}
      AND (@clientId IS NULL OR m.client_id = @clientId) ORDER BY m.id`)
    .all({ clientId: o.clientId ?? null }) as VoiceBacklogRow[];
}

/**
 * Queues the given failed files again (`cli transcribe-voice --failed`), exactly as queueVoiceBacklog queues the backlog:
 * pending, attempts 0, no error, no next attempt, no note, created now, backlog by the same rule. Each file is checked
 * against FAILED_LOCAL_VOICE_FROM again, so one that changed since it was listed, or that failed at a paid provider, is
 * left alone. One statement. Returns how many were queued.
 */
export function queueFailedLocalVoice(db: Db, ids: number[], at: string): number {
  if (ids.length === 0) return 0;
  return db
    .prepare(`UPDATE media SET ${REQUEUE_SET}
      WHERE id IN (SELECT value FROM json_each(@ids)) AND id IN (SELECT m.id ${FAILED_LOCAL_VOICE_FROM})`)
    .run({ ids: JSON.stringify(ids), at }).changes;
}

/** A speech provider's stored copy of a voice transcript still to delete (N1). ref is the provider's id for the copy, never content. */
export interface MediaForgetRow {
  id: number;
  mediaId: number;
  provider: ProviderId;
  ref: string;
  attempts: number;
}

/** Copies due for a try at nowIso with fewer than maxAttempts tries, oldest first; optionally one file's only. */
export function pendingMediaForgets(db: Db, o: { nowIso: string; maxAttempts: number; mediaId?: number }): MediaForgetRow[] {
  return db
    .prepare(`SELECT id, media_id AS mediaId, provider, ref, attempts FROM media_stt_forget
      WHERE attempts < @maxAttempts AND (next_try_at IS NULL OR next_try_at <= @nowIso) AND (@mediaId IS NULL OR media_id = @mediaId) ORDER BY id`)
    .all({ maxAttempts: o.maxAttempts, nowIso: o.nowIso, mediaId: o.mediaId ?? null }) as MediaForgetRow[];
}

/**
 * Counts one try and sets when the next may start, before the provider is asked: a try cut off by a crash still counts,
 * and a restart does not try again before nextTryAt.
 */
export function countMediaForgetAttempt(db: Db, id: number, nextTryAt: string): void {
  db.prepare('UPDATE media_stt_forget SET attempts = attempts + 1, next_try_at = @nextTryAt WHERE id = @id').run({ id, nextTryAt });
}

/** The provider has deleted its copy. */
export function deleteMediaForget(db: Db, id: number): void {
  db.prepare('DELETE FROM media_stt_forget WHERE id = ?').run(id);
}

/**
 * Voice-note copies the agent gave up deleting at the provider: the last try is used, or the provider that kept the copy
 * is not the one set up now (`provider`: VOICE_STT_PROVIDER; 'none' when voice notes are off, 'local' for the engine on
 * this machine, which keeps no copies), so the forget queue skips it. A count only, for `cli status`, as
 * sttForgetsGivenUp is for meetings.
 */
export function mediaSttForgetsGivenUp(db: Db, o: { maxAttempts: number; provider: ProviderId | 'local' | 'none' }): number {
  return (
    db.prepare('SELECT COUNT(*) AS n FROM media_stt_forget WHERE attempts >= ? OR provider <> ?').get(o.maxAttempts, o.provider) as { n: number }
  ).n;
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

/**
 * A file that belongs in Drive, whatever its upload attempts: a saved image or document, not yet in Drive, sent by a
 * client member in a message not deleted for everyone. Needs m (media), msg (its message) and p (its sender in people).
 * Shared by the uploader's queries and mediaStats, so Health never counts a file the uploader would not try.
 */
const UPLOADABLE = `m.local_path IS NOT NULL AND m.drive_file_id IS NULL AND m.kind IN ('image', 'document')
        AND msg.revoked = 0 AND msg.from_me = 0 AND p.role = 'client'`;

/** The rows uploadCandidates returns, shared with isUploadCandidate so the two never disagree. Its one parameter is now. */
const UPLOAD_CANDIDATES_FROM = `FROM media m JOIN messages msg ON msg.id = m.message_id JOIN clients c ON c.id = m.client_id
      JOIN people p ON p.client_id = m.client_id AND p.jid = msg.sender_jid
      WHERE ${UPLOADABLE} AND m.drive_failed = 0
        AND (m.drive_next_at IS NULL OR m.drive_next_at <= ?) AND c.active = 1`;

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

/** One failed upload try: counts the attempt. failed: stop trying until the next service start. */
export function markUploadFailed(db: Db, id: number, f: { failed: boolean; nextAt: string | null }): void {
  db.prepare('UPDATE media SET drive_attempts = drive_attempts + 1, drive_failed = @failed, drive_next_at = @nextAt WHERE id = @id').run({
    id,
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

export interface MediaStats {
  /** Files waiting to be downloaded or read. */
  pending: number;
  /**
   * Pending longer than staleMs, counted from the file's arrival or from the service start, whichever is later
   * (amendment 15a, the same clock as the reconciler's wait). Files waiting for the daily budget are counted in spendCap
   * instead, and files waiting for a speech-to-text key in sttRefused. Backlog files (`cli transcribe-voice`) are never
   * counted: a long backlog run holds nothing up and is not a fault.
   */
  stale: number;
  /** Pending files deferred by the daily spend cap (amendment 15b). */
  spendCap: number;
  /** Files that could not be read in the last 24 hours. */
  failedRecent: number;
  /**
   * Drive uploads that gave up and are still not in Drive. Only files the uploader would try again after a restart:
   * not once the message is deleted for everyone or its sender is no longer a client member.
   */
  uploadFailed: number;
  /** Pending voice notes and audio files waiting because the speech-to-text provider refused the key (stt_unavailable). */
  sttRefused: number;
  /**
   * Voice notes and audio files that failed on this computer in the last 24 hours: the local engine's errors (local_*)
   * or ffmpeg's (audio_convert_failed, audio_no_duration, audio_split_failed), never a paid provider's (Phase 2b final
   * review). `cli transcribe-voice --failed` queues them again.
   */
  voiceFailed: number;
}

/**
 * Counts for Health and `cli status`. Files of clients no longer on the allow-list are left out: they wait untouched
 * until the client is back (dueMediaIds), and Health forgets a removed client's warnings too.
 */
export function mediaStats(db: Db, now: Date, startedAt: Date = new Date(0), staleMs = 30 * 60_000): MediaStats {
  const staleBefore = new Date(now.getTime() - staleMs).toISOString();
  return db
    .prepare(`SELECT
        COALESCE(SUM(m.status = 'pending'), 0) AS pending,
        COALESCE(SUM(m.status = 'pending' AND m.backlog = 0 AND m.created_at < @staleBefore AND @startedAt < @staleBefore
          AND COALESCE(m.error_code, '') NOT IN ('spend_cap', 'stt_unavailable')), 0) AS stale,
        COALESCE(SUM(m.status = 'pending' AND m.error_code = 'spend_cap'), 0) AS spendCap,
        COALESCE(SUM(m.status = 'failed' AND m.updated_at >= @dayAgo), 0) AS failedRecent,
        COALESCE(SUM(m.drive_failed = 1 AND EXISTS (SELECT 1 FROM messages msg
          JOIN people p ON p.client_id = m.client_id AND p.jid = msg.sender_jid
          WHERE msg.id = m.message_id AND ${UPLOADABLE})), 0) AS uploadFailed,
        COALESCE(SUM(m.status = 'pending' AND m.error_code = 'stt_unavailable'), 0) AS sttRefused,
        COALESCE(SUM(m.kind IN ('voice', 'audio') AND m.status = 'failed' AND m.updated_at >= @dayAgo AND ${LOCAL_FAILURE}), 0) AS voiceFailed
      FROM media m JOIN clients c ON c.id = m.client_id AND c.active = 1`)
    .get({ staleBefore, startedAt: startedAt.toISOString(), dayAgo: new Date(now.getTime() - 86_400_000).toISOString() }) as MediaStats;
}
