import type { MediaKind } from '../store/media.ts';
import { istDate, istTime } from '../util/time.ts';
import { extForMime, sanitizeFileName } from './paths.ts';

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
