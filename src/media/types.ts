import type { MediaKind } from '../store/media.ts';

export type { MediaKind };

/**
 * What is needed to download one file from WhatsApp's media servers. Secret: never logged, and stored only sealed
 * (src/media/ref.ts) until the download ends.
 */
export interface MediaRef {
  contentType: 'imageMessage' | 'documentMessage' | 'audioMessage';
  url: string | null;
  directPath: string | null;
  /** base64 */
  mediaKey: string;
}

/** A shared file as the normaliser sees it. Every field comes from the sender's phone and is untrusted. */
export interface MediaInfo {
  kind: MediaKind;
  mimeType: string | null;
  fileName: string | null;
  /** As declared by the sender. The download enforces the real limit. */
  fileSize: number | null;
  seconds: number | null;
  viewOnce: boolean;
  /** Forwarded by the sender (contextInfo.isForwarded, or a forwarding score above 0). Never sent to Claude for a paid description. */
  forwarded: boolean;
  /** Download details; null for kinds that are never downloaded, view-once media and incomplete messages. */
  ref: MediaRef | null;
}

export const MEDIA_LIMITS = {
  /** Larger files are not downloaded. */
  maxDownloadBytes: 50 * 1024 * 1024,
  downloadTimeoutMs: 120_000,
  /** A parser that runs longer is stopped. */
  parseTimeoutMs: 30_000,
  /** Local PDF text extraction reads at most this many pages. */
  maxPdfPages: 200,
  /** PDFs without a text layer (scans) go to Claude only up to this many pages and bytes. */
  maxScannedPdfPages: 20,
  maxScannedPdfBytes: 20 * 1024 * 1024,
  /** DOCX zip-bomb guard: word/document.xml may inflate to at most this many bytes. */
  maxDocxXmlBytes: 20 * 1024 * 1024,
  maxZipEntries: 2_000,
  /** Images with more pixels are not decoded (decompression-bomb guard). */
  maxImagePixels: 50_000_000,
  /** Extracted text kept per file. The prompt gets far less (src/media/promptText.ts). */
  maxStoredTextChars: 1_000_000,
} as const;

/**
 * Phase 2b seam, not implemented in 2a: speech-to-text for voice notes and audio files. extract.ts will call it for the
 * kinds 'voice' and 'audio' (2a already saves their originals) and book the cost as 'stt' spend.
 */
export interface Transcriber {
  transcribe(audio: Buffer, opts: { mimeType: string | null; languageHint: 'hi-en' }): Promise<{ text: string; costUsd: number }>;
}
