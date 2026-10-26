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
import { AudioError } from '../stt/audio.ts';
import { SttHttpError, SttNoAnswerError } from '../stt/http.ts';
import { SttBookingError, withSttHold } from '../stt/paidStt.ts';
import type { ProviderId } from '../stt/types.ts';
import {
  sizeBoundSeconds, SttPartialError, VOICE_LENGTH_TOLERANCE_S, type LocalVoiceTranscriber, type PreparedVoice, type VoiceResult, type VoiceTranscriber,
} from '../stt/voice.ts';
import { prepareImageForClaude, type PreparedImage } from './image.ts';
import { FORMAT_NOT_SUPPORTED, FORWARDED_NOT_TRANSCRIBED, NO_SPEECH, TOO_LONG } from './labels.ts';
import { parseFile } from './parse/runner.ts';
import { countVisible, cutText } from './parse/text.ts';
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
  /**
   * Absolute path of the saved original: a voice note or audio file is read from it by the voice transcriber. Its
   * declared length (the row's seconds) is not passed: the sender sets it, so it is shown only, never used for length or
   * spend (V5, Task 5 review round 1).
   */
  path: string;
  /**
   * Asked just before a paid call: true when the file's message was deleted for everyone meanwhile, for example during
   * the decode. The file is then not sent to Claude and comes back with note 'revoked' (final review FR3a).
   */
  revoked?: () => boolean;
}

export interface Extraction {
  textKind: TextKind | null;
  text: string | null;
  pageCount: number | null;
  /**
   * 'first_pages_only' | 'scan_too_long' | 'scan_read_by_ai' | 'forwarded_not_described' | 'too_costly' | 'revoked' |
   * 'forwarded_not_transcribed' | 'too_long' | 'no_speech' | 'format_not_supported' | null
   */
  note: string | null;
  /**
   * The speech provider kept a copy of this transcript (ElevenLabs), to be deleted (N1). finishMedia notes it. Never set
   * for the local engine, which keeps no copies.
   */
  forget?: { provider: ProviderId; ref: string } | null;
}

/** Reads one saved original: describes images, reads PDFs and DOCX files, and transcribes voice notes and audio files. */
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
  /** The voice transcriber VOICE_STT_PROVIDER names; null or absent with 'none', when voice notes are kept as in 2a. */
  voice?: VoiceTranscriber | null;
  /** STT_MAX_SECONDS: the hard cap on one voice note or audio file (V2, V5). Default 600. */
  maxVoiceSeconds?: number;
  /**
   * The service's stop signal (Task 10): it stops a local engine run in flight (LocalEngineError('aborted'), and the
   * processor gives the attempt back). A paid call is never aborted, so it is not passed there.
   */
  signal?: AbortSignal;
}

const NONE: Extraction = { textKind: null, text: null, pageCount: null, note: null };
/** A forwarded image, or a forwarded scan that would need Claude, is kept and listed but not described (D2). */
const FORWARDED = 'forwarded_not_described';
/** A paid read whose ceiling is above the whole daily cap could never run, so it is not tried or deferred. */
const TOO_COSTLY = 'too_costly';
/** Deleted for everyone before the paid call: not sent to Claude, finished like the processor's own 'revoked' path. */
const REVOKED: Extraction = { ...NONE, note: 'revoked' };
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
/** STT_MAX_SECONDS' default (N3). */
const DEFAULT_MAX_VOICE_SECONDS = 600;

const baseMime = (m: string | null): string => ((m ?? '').toLowerCase().split(';')[0] ?? '').trim();
const isPdf = (b: Buffer): boolean => b.subarray(0, 5).toString('latin1') === '%PDF-';
const isZip = (b: Buffer): boolean => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
/**
 * Text kept per file. The parsers already stop at this cap; Claude's text is cut here. The cut is O(1), so a huge text
 * never stalls the service (review of Task 9).
 */
const capStored = (text: string): string => cutText(text, MEDIA_LIMITS.maxStoredTextChars);

const imageCostUsd = (imageTokens: number, p: Prices): number =>
  estimateCostUsd(MEDIA_SYSTEM_PROMPT.length + INSTRUCTION_CHARS, p, IMAGE_MAX_TOKENS) + (imageTokens * p.inputPerMTok) / 1_000_000;

/**
 * Errors of a scanned PDF's paid read. A retry could book up to the whole scan ceiling again, so the processor does
 * not retry them (amendment 10e). They are noted here, not wrapped, so the error itself still reaches the caller.
 */
const scanReadErrors = new WeakSet<object>();

/** Notes a failed scan read and rethrows. The spend cap is not one of these: nothing was tried. */
function scanReadFailed(e: unknown): never {
  if (!(e instanceof SpendCapReachedError) && typeof e === 'object' && e !== null) scanReadErrors.add(e);
  throw e;
}

/** Whether an error came from a scanned PDF's paid read (amendment 10e). */
export function isScanReadError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && scanReadErrors.has(e);
}

/**
 * Errors thrown after a voice note's paid call was answered, when its booking failed (Task 5 review round 1, Fix 3), or
 * after a failed call that may have been billed, when its ceiling booking failed (Task 6 review round 1, fix 1). The
 * provider may have billed it, so a retry could pay again: the processor fails the file at once. Noted, not wrapped, as
 * scanReadErrors are.
 */
const paidVoiceErrors = new WeakSet<object>();

/** Notes an error as one that came after a paid, answered voice call; an error that is not an object is wrapped first. */
function paidVoiceError(e: unknown): object {
  const err = typeof e === 'object' && e !== null ? e : new Error('A paid speech call could not be booked');
  paidVoiceErrors.add(err);
  return err;
}

/** Whether an error came after a voice note's paid call was answered: never retried, it would pay again. */
export function isPaidVoiceError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && paidVoiceErrors.has(e);
}

/**
 * Provider copies named by a voice call that got no usable answer (Phase 3's M7: an ElevenLabs reply that could not be
 * read may still carry the id of the transcript it stored, as SttNoAnswerError.forgetRef). The extractor has no
 * database, so it notes the copy on the error it throws, with its own transcriber's provider, and the processor writes
 * it to media_stt_forget (N1), from where forgetVoiceCopies deletes it. Noted, not wrapped, as scanReadErrors are, so
 * the error itself still reaches the processor's rules.
 */
const unansweredCopies = new WeakMap<object, { provider: ProviderId; ref: string }>();

/** The longest id kept for a stored copy: media_stt_forget's CHECK, and MAX_REF_LENGTH in src/stt/voice.ts. */
const MAX_COPY_REF_LENGTH = 200;

/**
 * The copy id an SttNoAnswerError carries, itself or as the cause of an SttPartialError or an SttBookingError (or both).
 * Read by shape: forgetRef is optional on SttNoAnswerError, and only an id of 1 to 200 characters is kept.
 */
function unansweredRef(e: unknown): string | null {
  let cur: unknown = e;
  for (let depth = 0; depth < 3; depth++) {
    if (cur instanceof SttNoAnswerError) {
      const ref = (cur as { forgetRef?: unknown }).forgetRef;
      return typeof ref === 'string' && ref.length >= 1 && ref.length <= MAX_COPY_REF_LENGTH ? ref : null;
    }
    if (!(cur instanceof SttBookingError || cur instanceof SttPartialError)) return null;
    cur = cur.cause;
  }
  return null;
}

/** Notes the copy a failed voice call names, if any, on the error, and returns the error as it is. */
function noteUnansweredCopy(e: unknown, provider: ProviderId): unknown {
  const ref = unansweredRef(e);
  if (ref !== null && typeof e === 'object' && e !== null) unansweredCopies.set(e, { provider, ref });
  return e;
}

/**
 * The provider copy a voice call that failed without a usable answer still named, for the processor to note in
 * media_stt_forget; null for any other error. An id only, never what was said.
 */
export function voiceCopyOf(e: unknown): { provider: ProviderId; ref: string } | null {
  return typeof e === 'object' && e !== null ? (unansweredCopies.get(e) ?? null) : null;
}

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
    if (!d.spend.canSpend(ceiling)) throw new SpendCapReachedError({ busy: d.spend.fitsIgnoringHolds(ceiling) });
    const img = await prepareImage(input.bytes);
    if (input.revoked?.()) return REVOKED;
    const r = await withReservation(d.spend, imageEstimateUsd(img, d.prices), label(input), () => d.ai.describeImage(img), MEDIA_ATTEMPTS);
    return { textKind: 'description', text: capStored(r.text), pageCount: null, note: null };
  };

  const readPdf = async (input: ExtractInput): Promise<Extraction> => {
    // No transfer: the bytes are still needed for a scan, by the size check and by the paid call (amendment 9f).
    const size = input.bytes.length;
    const parsed = await parse({ kind: 'pdf', bytes: input.bytes, maxPages: MEDIA_LIMITS.maxPdfPages, maxTextChars: MEDIA_LIMITS.maxStoredTextChars });
    // From the file's own /Count entry: shown as it is, never a limit on spend (amendment 9g).
    const pages = parsed.pageCount ?? 1;
    const read = Math.min(pages, MEDIA_LIMITS.maxPdfPages);
    const needed = MIN_CHARS_PER_PAGE * Math.max(1, read);
    if (countVisible(parsed.text, needed) >= needed) {
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
    if (input.revoked?.()) return REVOKED;
    const r = await withReservation(d.spend, ceiling, label(input), () => d.ai.readScannedPdf(input.bytes), MEDIA_ATTEMPTS).catch(scanReadFailed);
    return { textKind: 'extract', text: capStored(r.text), pageCount: pages, note: 'scan_read_by_ai' };
  };

  const readDocx = async (input: ExtractInput): Promise<Extraction> => {
    // Moved to the parser without a copy: nothing reads a DOCX's bytes after this (amendment 9f).
    const parsed = await parse(
      {
        kind: 'docx',
        bytes: input.bytes,
        maxXmlBytes: MEDIA_LIMITS.maxDocxXmlBytes,
        maxEntries: MEDIA_LIMITS.maxZipEntries,
        maxTextChars: MEDIA_LIMITS.maxStoredTextChars,
      },
      { transfer: true },
    );
    return parsed.text ? { textKind: 'extract', text: capStored(parsed.text), pageCount: null, note: null } : NONE;
  };

  /** Books a paid voice call's cost late, best effort: a failure is ignored, the first error is the one thrown. */
  const bookLate = (usd: number, input: ExtractInput): void => {
    try {
      d.spend.record('stt', usd, `${label(input)} (booked late)`);
    } catch {
      // the first error is the one thrown
    }
  };

  /**
   * A voice call that failed without an answer, whose booking then failed too (Task 6 review round 1, fix 1): withSttHold
   * threw an SttBookingError, and nothing is booked. Unless its cause is an SttHttpError (the provider refused the work:
   * never billed, the hold was only to be freed), the call may have been billed: no answer, a failed job, a later part,
   * or anything unknown, each of which withSttHold books at the ceiling. So the ceiling is booked late, best effort, and
   * the error marked paid: the processor fails the file at once as stt_paid_unbooked instead of paying again.
   */
  const failedAndUnbooked = (e: unknown, ceiling: number, input: ExtractInput): unknown => {
    if (!(e instanceof SttBookingError) || e.cause instanceof SttHttpError) return e;
    bookLate(ceiling, input);
    return paidVoiceError(e);
  };

  /**
   * After a voice note's paid call was answered, its booking failed (Fix 3): withSttHold threw from settle or record,
   * or, if costUsd threw, from booking the ceiling. Best effort, each failure ignored: the cost is booked late (the
   * ceiling when nothing was priced and withSttHold could not book it), and the provider's copy is deleted (free), since
   * finishMedia never notes it. The error is then marked paid, so the processor fails the file instead of paying again.
   */
  const paidButUnbooked = async (e: unknown, paid: { result: VoiceResult; costUsd?: number }, ceiling: number, input: ExtractInput): Promise<object> => {
    const lateUsd = paid.costUsd ?? (e instanceof SttBookingError ? ceiling : null);
    if (lateUsd !== null) bookLate(lateUsd, input);
    const ref = paid.result.forgetRef;
    if (ref !== null && d.voice) {
      try {
        await d.voice.forget(ref);
      } catch {
        // the copy stays on the provider's account; the first error is the one thrown
      }
    }
    return paidVoiceError(e);
  };

  /**
   * A voice note or audio file (V2, V4, V5, N2). The cap goes to prepare, which converts the note (stopped just past the
   * cap) and refuses it when measured longer than the cap plus VOICE_LENGTH_TOLERANCE_S: the only too_long check. The
   * file's size refuses nothing (Task 5 review round 2: a 1-minute 128 kbit/s MP3 is about 960 KB, a size bound of 640 s),
   * and the sender's declared length is never used. The hold is the measured length plus the tolerance. Without ffmpeg
   * nothing can be converted, so canSend is false and the note is format_not_supported, for transcribe-voice later. The
   * transcript is stored as an 'extract': the media kind already says it is a transcript.
   * The local engine (Phase 2b amendment L2) costs nothing: no hold, no too_costly and no spend row (transcribeFree).
   */
  const transcribe = async (input: ExtractInput): Promise<Extraction> => {
    const v = d.voice ?? null;
    if (v === null) return NONE; // VOICE_STT_PROVIDER none: kept as in 2a, transcribed later with cli transcribe-voice
    if (input.forwarded) return { ...NONE, note: FORWARDED_NOT_TRANSCRIBED };
    const maxSeconds = d.maxVoiceSeconds ?? DEFAULT_MAX_VOICE_SECONDS;
    if (!v.canSend(input.mimeType)) return { ...NONE, note: FORMAT_NOT_SUPPORTED }; // no ffmpeg
    // Free and local, outside the hold: a conversion or measuring failure books nothing.
    let prepared: PreparedVoice;
    try {
      prepared = await v.prepare({ mediaId: input.mediaId, path: input.path, maxSeconds });
    } catch (e) {
      if (e instanceof AudioError && e.code === 'too_long') return { ...NONE, note: TOO_LONG };
      throw e;
    }
    try {
      if (v.costsNothing) return await transcribeFree(v, prepared, input);
      // The measured length is trusted and capped by prepare; the tolerance is headroom over a provider's billed rounding.
      const ceiling = v.ceilingUsd(prepared.measuredSeconds + VOICE_LENGTH_TOLERANCE_S);
      if (ceiling > d.spend.capUsd) return { ...NONE, note: TOO_COSTLY };
      if (input.revoked?.()) return REVOKED;
      // Kept outside the hold, so a booking that fails after the provider answered is still known to be paid (Fix 3).
      const paid: { result?: VoiceResult; costUsd?: number } = {};
      let result: VoiceResult;
      try {
        ({ result } = await withSttHold(d.spend, ceiling, label(input), async () => {
          const r = await v.transcribe(prepared);
          paid.result = r;
          // Billed, else measured, else the size bound as the last fallback: never the declared length (Fix 2).
          const bound = sizeBoundSeconds(input.bytes.length);
          const costUsd = v.costUsd({ maxSeconds: bound, billedSeconds: r.billedSeconds, measuredSeconds: prepared.measuredSeconds });
          paid.costUsd = costUsd;
          return { result: r, costUsd };
        }));
      } catch (e) {
        // The call failed: withSttHold booked it by its outcome. A copy its error names is noted for the processor. If
        // that booking failed too, the ceiling is booked late and the error marked paid (fix 1).
        if (paid.result === undefined) throw failedAndUnbooked(noteUnansweredCopy(e, v.provider), ceiling, input);
        throw await paidButUnbooked(e, { ...paid, result: paid.result }, ceiling, input);
      }
      const forget = result.forgetRef === null || result.provider === 'local' ? null : { provider: result.provider, ref: result.forgetRef };
      if (result.text === '') return { ...NONE, note: NO_SPEECH, forget };
      return { textKind: 'extract', text: capStored(result.text), pageCount: null, note: null, forget };
    } finally {
      prepared.dispose(); // transcribe disposes too; this covers too_costly, revoked and a refused hold. Safe twice.
    }
  };

  /**
   * The local engine's run (Phase 2b amendment L2): free, so no hold, no too_costly and no spend row, and no forget (it
   * keeps no copies). Revoked is still asked just before the run. A LocalEngineError (empty_output, timeout, exit_<n>,
   * aborted, ...) goes to the processor unchanged, which retries it at no cost. The caller disposes.
   */
  const transcribeFree = async (v: LocalVoiceTranscriber, prepared: PreparedVoice, input: ExtractInput): Promise<Extraction> => {
    if (input.revoked?.()) return REVOKED;
    const result = await v.transcribe(prepared, d.signal);
    if (result.text === '') return { ...NONE, note: NO_SPEECH };
    return { textKind: 'extract', text: capStored(result.text), pageCount: null, note: null };
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
      case 'voice':
      case 'audio':
        return transcribe(input);
      default:
        // video and sticker are never downloaded, so they never get here.
        return NONE;
    }
  };
}
