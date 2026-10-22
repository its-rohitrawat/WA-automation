import type { MediaKind } from '../store/media.ts';
import { istDate } from '../util/time.ts';

/** Windows device names: a file or folder with such a name cannot be created. */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const SAFE = /^[A-Za-z0-9_-]{1,100}$/;

const isSafeSegment = (s: string): boolean => SAFE.test(s) && !RESERVED.test(s);

/** A single path segment that is safe on Windows, or the fallback. */
export function safeSegment(s: string, fallback: string): string {
  return isSafeSegment(s) ? s : fallback;
}

/**
 * Where an original is saved, relative to DATA_DIR, with forward slashes: "media/SHA/2026-10/3EB0C4F2A1-17.jpg".
 * Built from the client code, the India month, the WhatsApp message id and the media row id; never from the sender's file name.
 * The row id keeps every name unique on Windows, which ignores case: message ids "3EB0AB" and "3eb0ab" would otherwise collide.
 * A message id that is not safe in a file name is left out: "m17.jpg".
 */
export function mediaRelPath(o: { clientCode: string; ts: string; waId: string; mediaId: number; ext: string }): string {
  const folder = safeSegment(o.clientCode, `_${o.clientCode.replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'client'}`);
  const month = istDate(new Date(o.ts)).slice(0, 7);
  const ext = /^[a-z0-9]{1,5}$/.test(o.ext) ? o.ext : 'bin';
  const stem = isSafeSegment(o.waId) ? `${o.waId}-${o.mediaId}` : `m${o.mediaId}`;
  return ['media', folder, month, `${stem}.${ext}`].join('/');
}

/** Extension by MIME type. A Map, so a declared type such as "constructor" or "__proto__" matches nothing. */
const EXT = new Map<string, string>(
  Object.entries({
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/heic': 'heic',
    'application/pdf': 'pdf',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-powerpoint': 'ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/zip': 'zip',
    'text/plain': 'txt',
    'text/csv': 'csv',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'video/mp4': 'mp4',
  }),
);
const KIND_DEFAULT: Partial<Record<MediaKind, string>> = { image: 'jpg', voice: 'ogg' };

/** File extension from the MIME type the message declared. */
export function extForMime(mime: string | null, kind: MediaKind): string {
  const m = ((mime ?? '').toLowerCase().split(';')[0] ?? '').trim();
  return EXT.get(m) ?? KIND_DEFAULT[kind] ?? 'bin';
}

/**
 * Control and format characters (Unicode Cc and Cf): zero-width characters, direction marks, embeddings, overrides and
 * isolates (used to disguise names like "invoice\u202Efdp.exe"), and tag characters, which can hide text from a reader.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;

const EDGE = /[.\s]/;

/**
 * Drops dots and white space from both ends of a name. A loop, not a regex: /[.\s]+$/ backtracks on a long run of dots
 * or spaces inside a name and takes quadratic time.
 */
function trimDotsAndSpaces(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && EDGE.test(s.charAt(start))) start++;
  while (end > start && EDGE.test(s.charAt(end - 1))) end--;
  return s.slice(start, end);
}

/** A sender's file name made safe to show in the workbook and to use as a Drive name. Null when nothing is left. */
export function sanitizeFileName(name: string | null, maxLength = 120): string | null {
  if (!name) return null;
  const cleaned = trimDotsAndSpaces(
    name
      .replace(INVISIBLE, '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' '),
  );
  // Trimmed again after the cut, which can leave a space or a dot at the end.
  const cut = trimDotsAndSpaces([...cleaned].slice(0, maxLength).join(''));
  return cut.length > 0 ? cut : null;
}
