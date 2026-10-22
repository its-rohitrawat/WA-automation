import type { Db } from '../store/db.ts';
import { mediaForMessages, type MediaKind, type MediaRow } from '../store/media.ts';
import type { MessageRow } from '../store/messages.ts';
import { fromIstDate, istDate } from '../util/time.ts';
import { formatDuration, formatSize, FORWARDED_NOT_DESCRIBED, typeLabel } from './labels.ts';
import { sanitizeFileName } from './paths.ts';
import { MEDIA_LIMITS } from './types.ts';

export interface MediaPromptLimits {
  /** File text per new message. */
  perMessage: number;
  /** File text across all new messages of one batch. */
  perBatch: number;
  /** File text per already-processed context message. */
  perContextMessage: number;
}

export const MEDIA_PROMPT_LIMITS: MediaPromptLimits = { perMessage: 20_000, perBatch: 60_000, perContextMessage: 600 };

/**
 * A file still pending after this long no longer holds up its message. The time counts from when the file arrived or
 * from the service start, whichever is later, so files saved by `cli link` or left pending at shutdown still get it.
 */
export const MEDIA_MAX_WAIT_MS = 30 * 60_000;

/** A file waiting for the daily budget blocks until this long after the next midnight IST, when the budget is back. */
const AFTER_MIDNIGHT_MS = 30 * 60_000;
const DAY_MS = 86_400_000;

/**
 * A shared file's block on its message line, which prompt.ts renders as {head} or {head: body}.
 * Raw: prompt.ts sanitises the head as one line and the body like message text, so neither can close the block.
 */
export interface MediaBlock {
  head: string;
  /** What was read from the file (a description or its text), or null when nothing was read. */
  body: string | null;
}

const NOUN: Record<MediaKind, string> = { image: 'image', video: 'video', document: 'document', sticker: 'sticker', voice: 'voice note', audio: 'audio file' };

function quotedName(row: MediaRow): string {
  // sanitizeFileName drops hidden characters and turns quotes into "_", so the name cannot end its own quotes.
  const n = sanitizeFileName(row.fileName, 80);
  return n ? ` "${n}"` : '';
}

/**
 * The text cut to max characters (code points). The store may have loaded only the start of a long text, so how much
 * was left out comes from the full length (textChars).
 */
function cut(text: string, textChars: number | null, max: number): string {
  const cps = [...text];
  const total = Math.max(textChars ?? cps.length, cps.length);
  if (total <= max) return text;
  if (max <= 0) return `(${total} characters not shown)`;
  const shown = cps.slice(0, max);
  return `${shown.join('')} … (${total - shown.length} more characters not shown)`;
}

function headOf(row: MediaRow): string {
  if (row.kind === 'image') return row.forwarded ? 'image (forwarded)' : 'image';
  // D2: a forwarded scan that was not read shows no page count, though the extractor stored one.
  const pages = row.pageCount && row.note !== FORWARDED_NOT_DESCRIBED ? `, ${row.pageCount} ${row.pageCount === 1 ? 'page' : 'pages'}` : '';
  return `document${quotedName(row)} (${typeLabel(row.mimeType, row.kind)}${pages}${row.forwarded ? ', forwarded' : ''})`;
}

/**
 * The block for a message's file, for example {head: 'image', body: 'A blue banner'} or
 * {head: 'document "brief.pdf" (PDF, 3 pages), text', body: '...'}. Null when the plain placeholder (placeholderFor in
 * prompt.ts) says it all: stickers, and voice notes and audio files until Phase 2b. View-once media of any kind is never
 * saved, and its block says so.
 */
export function mediaPromptText(row: MediaRow, maxChars: number): MediaBlock | null {
  if (row.errorCode === 'view_once') return { head: `view-once ${NOUN[row.kind]}, not saved`, body: null };
  if (row.kind === 'sticker' || row.kind === 'voice' || row.kind === 'audio') return null;
  if (row.kind === 'video') return { head: `video${row.seconds ? `, ${formatDuration(row.seconds)}` : ''}`, body: null };
  const head = headOf(row);
  const just = (state: string): MediaBlock => ({ head: `${head}, ${state}`, body: null });
  switch (row.status) {
    case 'pending':
      return just('still being read');
    case 'unavailable':
      return just(row.errorCode === 'too_large' ? 'too large to download' : 'could not be downloaded');
    case 'failed':
      return just('could not be read');
    case 'metadata':
      return { head, body: null };
    case 'done': {
      // Owner decision D2: forwarded media is never sent to Claude for a paid description.
      if (row.note === FORWARDED_NOT_DESCRIBED) return just(row.kind === 'image' || typeLabel(row.mimeType, row.kind) === 'Image' ? 'not described' : 'not read');
      if (!row.text) {
        if (row.note === 'scan_too_long') return just('scanned, too long to read');
        return row.kind === 'document' ? just(`${row.fileSize ? `${formatSize(row.fileSize)}, ` : ''}contents not read`) : { head, body: null };
      }
      const body = cut(row.text, row.textChars, maxChars);
      if (row.textKind === 'description') return { head, body };
      const partial = row.note === 'first_pages_only' ? `, first ${MEDIA_LIMITS.maxPdfPages} pages only` : '';
      return { head: `${head}${partial}, text`, body };
    }
  }
}

/**
 * Blocks for the new messages (sharing one budget) and the context messages (short excerpts), by message row id.
 * Descriptions (a picture's only text, which was paid for) get the first claim on the batch budget; file extracts
 * share what is left, so a receipt sent after long PDFs is still shown whole. The batch never shows more than perBatch.
 * `media` comes from mediaForPrompt with the same limits.
 */
export function mediaPromptTexts(
  media: Map<number, MediaRow>,
  batch: MessageRow[],
  recent: MessageRow[],
  limits: MediaPromptLimits = MEDIA_PROMPT_LIMITS,
): Map<number, MediaBlock> {
  const blocks = new Map<number, MediaBlock>();
  let left = limits.perBatch;
  const give = (m: MessageRow, row: MediaRow): void => {
    const allowance = Math.max(0, Math.min(limits.perMessage, left));
    const block = mediaPromptText(row, allowance);
    if (!block) return;
    blocks.set(m.id, block);
    if (block.body !== null && row.text) left -= Math.min(row.textChars ?? [...row.text].length, allowance);
  };
  const files = batch.flatMap((m) => {
    const row = media.get(m.id);
    return row ? [{ m, row }] : [];
  });
  for (const { m, row } of files) if (row.textKind === 'description') give(m, row);
  for (const { m, row } of files) if (row.textKind !== 'description') give(m, row);
  // In message order, as before.
  const out = new Map<number, MediaBlock>();
  for (const m of batch) {
    const block = blocks.get(m.id);
    if (block) out.set(m.id, block);
  }
  for (const m of recent) {
    const row = media.get(m.id);
    const block = row ? mediaPromptText(row, limits.perContextMessage) : null;
    if (block) out.set(m.id, block);
  }
  return out;
}

/**
 * The files of the new and the context messages, by message row id, for mediaPromptTexts. Each text is loaded only as
 * far as the prompt can show it, plus one character so a cut is noticed: limits.perMessage for new messages,
 * limits.perContextMessage for context messages. The full length is in textChars.
 */
export function mediaForPrompt(
  db: Db,
  batch: Pick<MessageRow, 'id'>[],
  recent: Pick<MessageRow, 'id'>[],
  limits: MediaPromptLimits = MEDIA_PROMPT_LIMITS,
): Map<number, MediaRow> {
  const out = mediaForMessages(db, recent.map((m) => m.id), limits.perContextMessage + 1);
  // Set after the context rows, so a message in both lists gets the longer text.
  for (const [id, row] of mediaForMessages(db, batch.map((m) => m.id), limits.perMessage + 1)) out.set(id, row);
  return out;
}

/** The first midnight IST after the given time, in ms. IST has no daylight saving, so a day is always 24 hours. */
function nextIstMidnight(iso: string): number {
  return fromIstDate(istDate(new Date(iso))).getTime() + DAY_MS;
}

/**
 * True while the reconciler should wait for this file (spec §6.1, amendments 12a, 12c, 12e, 10d).
 * - Only images and documents that are still pending can block: nothing is read from voice notes or audio files in Phase 2a.
 * - A pending file blocks for MEDIA_MAX_WAIT_MS, counted from its arrival or from startedAt (the service start), whichever is later.
 *   This includes a file the media queue keeps retrying because Claude is unavailable (error code ai_unavailable), for up to 24 hours.
 * - A file deferred by the daily spend cap blocks until 30 minutes after the next midnight IST after it was deferred,
 *   when the budget is back; the reconciler could not run before then either. A service start still gives it the 30 minutes above.
 * A file that no longer blocks shows as "still being read".
 */
export function isBlocking(row: MediaRow | undefined, now: Date, startedAt: Date, maxWaitMs = MEDIA_MAX_WAIT_MS): boolean {
  if (!row || row.status !== 'pending') return false;
  if (row.kind !== 'image' && row.kind !== 'document') return false;
  let until = Math.max(Date.parse(row.createdAt), startedAt.getTime()) + maxWaitMs;
  if (row.errorCode === 'spend_cap') until = Math.max(until, nextIstMidnight(row.updatedAt) + AFTER_MIDNIGHT_MS);
  return now.getTime() < until;
}

/** The queued messages before the first one whose file is still being read. Order is kept. */
export function readyPrefix(batch: MessageRow[], media: Map<number, MediaRow>, now: Date, startedAt: Date): MessageRow[] {
  const i = batch.findIndex((m) => isBlocking(media.get(m.id), now, startedAt));
  return i < 0 ? batch : batch.slice(0, i);
}
