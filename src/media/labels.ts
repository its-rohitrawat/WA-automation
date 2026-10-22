import type { MediaKind, MediaStatus, TextKind } from '../store/media.ts';
import { istDate, istTime } from '../util/time.ts';
import { extForMime, sanitizeFileName, showsText } from './paths.ts';
import { MEDIA_LIMITS } from './types.ts';

/** Label by MIME type. A Map, so a declared type such as "constructor" or "__proto__" matches nothing. */
const TYPE_BY_MIME = new Map<string, string>(
  Object.entries({
    'application/pdf': 'PDF',
    'application/msword': 'Word document',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word document',
    'application/vnd.ms-excel': 'Excel sheet',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel sheet',
    'application/vnd.ms-powerpoint': 'PowerPoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint',
    'application/zip': 'ZIP archive',
    'text/plain': 'Text file',
    'text/csv': 'CSV file',
  }),
);

/** "PDF", "Word document", "Image", ... from the declared MIME type. */
export function typeLabel(mime: string | null, kind: MediaKind): string {
  const m = ((mime ?? '').toLowerCase().split(';')[0] ?? '').trim();
  const known = TYPE_BY_MIME.get(m);
  if (known) return known;
  if (m.startsWith('image/')) return 'Image';
  if (m.startsWith('video/') || kind === 'video') return 'Video';
  if (m.startsWith('audio/')) return 'Audio';
  return kind === 'image' ? 'Image' : 'File';
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The name shown in Files received and used in Drive: the sanitised file name, or "image-2026-10-19-1405-7.jpg". */
export function displayName(o: { kind: MediaKind; fileName: string | null; mimeType: string | null; ts: string; mediaId: number }): string {
  const clean = sanitizeFileName(o.fileName);
  if (clean) return clean;
  const d = new Date(o.ts);
  return `${o.kind}-${istDate(d)}-${istTime(d).replace(':', '')}-${o.mediaId}.${extForMime(o.mimeType, o.kind)}`;
}

export interface FileFacts {
  kind: MediaKind;
  status: MediaStatus;
  mimeType: string | null;
  fileSize: number | null;
  seconds: number | null;
  pageCount: number | null;
  textKind: TextKind | null;
  textStart: string | null;
  note: string | null;
  /** Why a file was not downloaded or read, e.g. 'too_large' (ClientFileRow.errorCode). */
  errorCode: string | null;
  revoked: boolean;
}

/** The extractor's note for a forwarded image or scanned PDF that was not sent to Claude (owner decision D2). */
export const FORWARDED_NOT_DESCRIBED = 'forwarded_not_described';

/**
 * The extractor's note for an image or scanned PDF that was not read because the paid read's ceiling is above the whole
 * daily spend cap (amendment 9a): only a DAILY_SPEND_CAP_USD below about $0.10 (images) or $4.16 (scans) does that.
 * The file is finished (done), so it never blocks its message.
 */
export const TOO_COSTLY = 'too_costly';

/**
 * Control and format characters (direction overrides, zero-width marks), lone surrogates (T4-02) and U+FFFE/U+FFFF,
 * which XML does not allow. The zero-width non-joiner and joiner (U+200C, U+200D) are kept (T14-12): emoji sequences
 * and some Indic spellings need them, and they cannot reorder text.
 */
const HIDDEN = /(?![\u200C\u200D])[\p{Cc}\p{Cf}\p{Cs}\uFFFE\uFFFF]/gu;

/** File text on one line, without hidden characters that could disguise it, cut to max characters. */
function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').replace(HIDDEN, '').replace(/ {2,}/g, ' ').trim();
  const cps = [...flat];
  return cps.length <= max ? flat : `${cps.slice(0, max).join('')}…`;
}

/**
 * The Files received description: what the file is, and the start of what was read. Deterministic, no AI.
 * A file whose message was deleted for everyone shows only "(deleted by sender)": it stays listed, but what it said is not shown.
 */
export function fileDescription(f: FileFacts): string {
  if (f.revoked) return '(deleted by sender)';
  const type = typeLabel(f.mimeType, f.kind);
  const pages = f.pageCount ? `, ${f.pageCount} ${f.pageCount === 1 ? 'page' : 'pages'}` : '';
  if (f.kind === 'video') return `Video${f.seconds ? `, ${formatDuration(f.seconds)}` : ''} (not downloaded)`;
  if (f.status === 'pending') return `${type}, being read`;
  if (f.status === 'unavailable') {
    if (f.errorCode !== 'too_large') return `${type}, could not be downloaded from WhatsApp`;
    // The agent chose not to download it (T14-03). The size is the sender's claim, shown only when it is over the limit:
    // a file found too large during the download may have declared less.
    const limit = MEDIA_LIMITS.maxDownloadBytes;
    const size = f.fileSize && f.fileSize > limit ? `, ${formatSize(f.fileSize)}` : '';
    return `${type}${size}, too large to download (over ${Math.round(limit / (1024 * 1024))} MB)`;
  }
  if (f.status === 'failed') return `${type}, could not be read`;
  if (f.note === FORWARDED_NOT_DESCRIBED) return f.kind === 'image' || type === 'Image' ? '(forwarded image)' : '(forwarded scanned PDF)';
  // Cleaned first (T14-02): a start made only of spaces or hidden characters (a PDF whose broken font gave only NULs,
  // stored as spaces) shows nothing, so it falls through to the type, rather than leaving "PDF, 2 pages: ".
  const text = f.textStart ? oneLine(f.textStart, f.textKind === 'description' ? 300 : 200) : '';
  if (showsText(text)) {
    if (f.textKind === 'description') return text;
    if (f.textKind === 'extract') return `${type}${pages}: ${text}`;
  }
  if (f.note === 'scan_too_long') return `${type}${pages}, scanned, too long to read`;
  if (f.note === TOO_COSTLY) return `${type}${pages} (not read: too costly for the daily limit)`;
  return `${type}${pages || (f.fileSize ? `, ${formatSize(f.fileSize)}` : '')}`;
}
