import {
  IMAGE_MAX_TOKENS,
  IMAGE_TOKEN_CEILING,
  MEDIA_SDK_MAX_RETRIES,
  MEDIA_SYSTEM_PROMPT,
  PDF_MAX_TOKENS,
  PDF_TOKENS_PER_PAGE,
  type MediaAi,
} from '../brain/mediaClient.ts';
import { SpendCapReachedError, withReservation } from '../brain/paidCall.ts';
import { estimateCostUsd, type Prices } from '../spend/pricing.ts';
import type { SpendGuard } from '../spend/spendGuard.ts';
import type { MediaKind, TextKind } from '../store/media.ts';
import { prepareImageForClaude, type PreparedImage } from './image.ts';
import { parseFile } from './parse/runner.ts';
import type { ParseJob, ParseResult } from './parse/types.ts';
import { MEDIA_LIMITS } from './types.ts';

export interface ExtractInput {
  mediaId: number;
  kind: MediaKind;
  mimeType: string | null;
  fileName: string | null;
  /** Forwarded by the sender: never sent to Claude for a paid description (owner decision D2). */
  forwarded: boolean;
  /** The saved original. A DOCX's bytes are moved to the parser, so the caller must not read them after extract. */
  bytes: Buffer;
}

export interface Extraction {
  textKind: TextKind | null;
  text: string | null;
  pageCount: number | null;
  /** 'first_pages_only' | 'scan_too_long' | 'scan_read_by_ai' | 'forwarded_not_described' | 'too_costly' | null */
  note: string | null;
}

/** Reads one saved original. This is the seam where Phase 2b adds voice-note transcription. */
export type Extractor = (input: ExtractInput) => Promise<Extraction>;

export interface ExtractorDeps {
  ai: MediaAi;
  spend: SpendGuard;
  prices: Prices;
  /**
   * Test seams. `parse` behaves like parseFile: with `transfer`, bytes that own their memory are moved to the parser
   * and the caller's view is empty afterwards.
   */
  parse?: (job: ParseJob, o?: { transfer?: boolean }) => Promise<ParseResult>;
  prepareImage?: (bytes: Buffer) => Promise<PreparedImage>;
}

const NONE: Extraction = { textKind: null, text: null, pageCount: null, note: null };
/** A forwarded image, or a forwarded scan that would need Claude, is kept and listed but not described (D2). */
const FORWARDED = 'forwarded_not_described';
/** A paid read whose ceiling is above the whole daily cap could never run, so it is not tried or deferred. */
const TOO_COSTLY = 'too_costly';
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
/** A PDF whose text layer has fewer visible characters per page than this is treated as a scan. */
const MIN_CHARS_PER_PAGE = 16;
/** Room for the short instruction that goes with the file. */
const INSTRUCTION_CHARS = 200;
/** The most pages Claude reads from one PDF in one request (100 on 200k-context models). */
const CLAUDE_PDF_MAX_PAGES = 600;
/** Input ceiling for one scanned PDF: every page Claude may read, but no more than the largest context window. */
const MAX_PDF_INPUT_TOKENS = Math.min(CLAUDE_PDF_MAX_PAGES * PDF_TOKENS_PER_PAGE, 1_000_000);
/** The media client makes one SDK attempt per call, so a lost connection is booked once (amendment 9h). */
const MEDIA_ATTEMPTS = MEDIA_SDK_MAX_RETRIES + 1;

const baseMime = (m: string | null): string => ((m ?? '').toLowerCase().split(';')[0] ?? '').trim();
const isPdf = (b: Buffer): boolean => b.subarray(0, 5).toString('latin1') === '%PDF-';
const isZip = (b: Buffer): boolean => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
const visibleChars = (s: string): number => s.replace(/\s/g, '').length;

function capStored(text: string): string {
  return text.length <= MEDIA_LIMITS.maxStoredTextChars ? text : [...text].slice(0, MEDIA_LIMITS.maxStoredTextChars).join('');
}

const imageCostUsd = (imageTokens: number, p: Prices): number =>
  estimateCostUsd(MEDIA_SYSTEM_PROMPT.length + INSTRUCTION_CHARS, p, IMAGE_MAX_TOKENS) + (imageTokens * p.inputPerMTok) / 1_000_000;

/** Ceiling for one image description: the prompt, the image at its token count (capped), and the full output allowance. */
export function imageEstimateUsd(img: { width: number; height: number }, p: Prices): number {
  return imageCostUsd(Math.min(IMAGE_TOKEN_CEILING, Math.ceil((img.width * img.height) / 750)), p);
}

/** Ceiling for any image description, known before the image is decoded. */
export function imageCeilingUsd(p: Prices): number {
  return imageCostUsd(IMAGE_TOKEN_CEILING, p);
}

/**
 * Ceiling for reading any scanned PDF: as many pages as Claude may read, as image plus text, and the full output
 * allowance. The PDF's own page count is never used, since the sender can set it too low (amendment 9g).
 */
export function scannedPdfCeilingUsd(p: Prices): number {
  return estimateCostUsd(MEDIA_SYSTEM_PROMPT.length + INSTRUCTION_CHARS, p, PDF_MAX_TOKENS) + (MAX_PDF_INPUT_TOKENS * p.inputPerMTok) / 1_000_000;
}

/** Chooses how each kind of file is read. Every paid call reserves its ceiling under the daily cap first. */
export function createExtractor(d: ExtractorDeps): Extractor {
  const parse = d.parse ?? ((job: ParseJob, o?: { transfer?: boolean }) => parseFile(job, { timeoutMs: MEDIA_LIMITS.parseTimeoutMs, ...o }));
  const prepareImage = d.prepareImage ?? ((bytes: Buffer) => prepareImageForClaude(bytes));
  const label = (input: ExtractInput): string => `media ${input.mediaId}`;

  const describe = async (input: ExtractInput): Promise<Extraction> => {
    if (input.forwarded) return { ...NONE, note: FORWARDED };
    const ceiling = imageCeilingUsd(d.prices);
    if (ceiling > d.spend.capUsd) return { ...NONE, note: TOO_COSTLY };
    // The budget is checked before decoding, so an image deferred by the cap is not decoded again on every retry.
    if (!d.spend.canSpend(ceiling)) throw new SpendCapReachedError();
    const img = await prepareImage(input.bytes);
    const r = await withReservation(d.spend, imageEstimateUsd(img, d.prices), label(input), () => d.ai.describeImage(img), MEDIA_ATTEMPTS);
    return { textKind: 'description', text: capStored(r.text), pageCount: null, note: null };
  };

  const readPdf = async (input: ExtractInput): Promise<Extraction> => {
    // No transfer: the bytes are still needed for a scan, by the size check and by the paid call (amendment 9f).
    const size = input.bytes.length;
    const parsed = await parse({ kind: 'pdf', bytes: input.bytes, maxPages: MEDIA_LIMITS.maxPdfPages });
    // From the file's own /Count entry: shown as it is, never a limit on spend (amendment 9g).
    const pages = parsed.pageCount ?? 1;
    const read = Math.min(pages, MEDIA_LIMITS.maxPdfPages);
    if (visibleChars(parsed.text) >= MIN_CHARS_PER_PAGE * Math.max(1, read)) {
      return { textKind: 'extract', text: capStored(parsed.text), pageCount: pages, note: pages > read ? 'first_pages_only' : null };
    }
    // No usable text layer: a scan. Claude reads short scans; longer ones are listed with their page count only.
    // The page check catches honest long scans; the byte check is the one that holds against a forged page count.
    if (pages > MEDIA_LIMITS.maxScannedPdfPages || size > MEDIA_LIMITS.maxScannedPdfBytes) {
      return { ...NONE, pageCount: pages, note: 'scan_too_long' };
    }
    if (input.forwarded) return { ...NONE, pageCount: pages, note: FORWARDED };
    // Claude reads every real page whatever the file claims, so every scan reserves the same ceiling.
    const ceiling = scannedPdfCeilingUsd(d.prices);
    if (ceiling > d.spend.capUsd) return { ...NONE, pageCount: pages, note: TOO_COSTLY };
    const r = await withReservation(d.spend, ceiling, label(input), () => d.ai.readScannedPdf(input.bytes), MEDIA_ATTEMPTS);
    return { textKind: 'extract', text: capStored(r.text), pageCount: pages, note: 'scan_read_by_ai' };
  };

  const readDocx = async (input: ExtractInput): Promise<Extraction> => {
    // Moved to the parser without a copy: nothing reads a DOCX's bytes after this (amendment 9f).
    const parsed = await parse(
      { kind: 'docx', bytes: input.bytes, maxXmlBytes: MEDIA_LIMITS.maxDocxXmlBytes, maxEntries: MEDIA_LIMITS.maxZipEntries },
      { transfer: true },
    );
    return parsed.text ? { textKind: 'extract', text: capStored(parsed.text), pageCount: null, note: null } : NONE;
  };

  return async (input) => {
    switch (input.kind) {
      case 'image':
        return describe(input);
      case 'document': {
        const mime = baseMime(input.mimeType);
        if (IMAGE_MIMES.has(mime)) return describe(input);
        if (isPdf(input.bytes)) return readPdf(input);
        if (isZip(input.bytes) && (mime === DOCX_MIME || /\.docx$/i.test(input.fileName ?? ''))) return readDocx(input);
        return NONE; // any other file: the original is kept, nothing is read
      }
      default:
        // voice and audio: Phase 2b plugs a Transcriber in here; 2a already saves their originals.
        // video and sticker are never downloaded, so they never get here.
        return NONE;
    }
  };
}
