import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { SpendCapReachedError } from '../brain/paidCall.ts';
import { requireKey, type Env } from '../config/env.ts';
import type { SpendGuard } from '../spend/spendGuard.ts';
import type { Db } from '../store/db.ts';
import { advanceStage, getMeeting, meetingIdsWithInflightParts, type SttPartRow } from '../store/meetings.ts';
import type { Ffmpeg } from '../stt/audio.ts';
import { SttHttpError, type HttpFetch } from '../stt/http.ts';
import { SttBookingError } from '../stt/paidStt.ts';
import { costUsd, modelFor } from '../stt/prices.ts';
import { ElevenLabsProvider } from '../stt/providers/elevenlabs.ts';
import { OpenAiProvider } from '../stt/providers/openai.ts';
import { SarvamProvider } from '../stt/providers/sarvam.ts';
import { mergeParts } from '../stt/segments.ts';
import type { AudioPart, ProviderId, Segment, SttProvider } from '../stt/types.ts';
import { systemClock, type Clock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';
import { MeetingDeferral, meetingsTmpDir, removePartsFolder } from './audio.ts';
import { forgetPending } from './sttForget.ts';
import { bookStuckParts, ensurePartFiles, errorCode, heldPart, partContext, planParts, replanForProvider, sarvamPart } from './sttParts.ts';

export { bookStuckParts } from './sttParts.ts';
export { forgetPending, MAX_FORGET_ATTEMPTS } from './sttForget.ts';

/*
 * Meeting transcription (Task 6). Every paid speech call is booked as 'stt' spend exactly once, across crashes, retries
 * and shutdowns, through the durable part records in meetings.stt_parts (see the plan's behaviour notes):
 * - ElevenLabs and OpenAI: the part is set inflight, then the ceiling is held (withSttHold) and settled at the reported
 *   cost, or at the ceiling when the outcome is unknown. A hold that shutdown books (settlePending) marks the part booked.
 * - Sarvam: the ceiling is held while the job is sent and booked, durably with the job id, when the job is accepted. The
 *   list price for the measured length is exactly the ceiling, so nothing more is booked when the answer comes; no
 *   in-memory hold has to outlive a batch job of up to 3 hours.
 * - A booking and the part state it goes with are written in one transaction; if that fails, the part is left inflight
 *   with nothing booked, and bookStuckParts books it at the ceiling of the provider it was sent to.
 * - A provider copy of an answer (ElevenLabs) is noted in stt_forget with the finished part and deleted once the
 *   transcript is stored (M7); forgetPending tries again later.
 * Logs carry the meeting id, part number, provider, seconds and cost only: never what was said, paths or keys.
 * The parts themselves (planning, sending, booking) are in src/meetings/sttParts.ts; copies in src/meetings/sttForget.ts.
 *
 * WHAT THE PROCESSOR (Task 10) MUST CALL
 * - At start, before any meeting runs: recoverInflightParts(db, spend, INR_PER_USD, log), then
 *   forgetPending(db, transcriber, log). Both run with STT_PROVIDER none too (forgetPending then only logs).
 * - Per meeting at stage audio: transcribeMeeting(id, deps, signal), and map what it throws:
 *   MeetingDeferral stt_none / stt_unavailable / spend_cap / spend_busy -> defer without counting an attempt;
 *   anything else (SttHttpError 429/5xx, SttNoAnswerError, SttJobError, SttBookingError, AudioError, disk errors) ->
 *   retry, counting an attempt.
 * - On a final failure (attempts used up, or any path to failMeeting for a meeting that has stt_parts):
 *   bookStuckParts(db, spend, id, { inrPerUsd, clock, log }) BEFORE failMeeting, so a part left in flight is booked.
 * - At shutdown: SpendGuard.settlePending runs while the database is still open (it writes the bookings and the parts'
 *   records), after the stage's signal is aborted and the drain has let speech calls finish or not.
 */

/** Provider timeouts for meetings, through the providers' constructor options. */
export const MEETING_STT_TIMEOUTS = {
  /** One call carries a whole meeting of up to 3 hours; under SpendGuard's 45-minute hold lifetime. */
  elevenlabsMs: 40 * 60_000,
  /** One 5-minute part per call. */
  openaiMs: 10 * 60_000,
  /** Waiting for a batch job, which holds no in-memory reservation (booked at acceptance). */
  sarvamWaitMs: 3 * 3_600_000,
};

export interface MeetingTranscriber {
  readonly provider: ProviderId;
  readonly maxPartSeconds: number;
  /** INR_PER_USD, for prices in rupees (also those of parts sent to an earlier provider). */
  readonly inrPerUsd: number;
  /** The list price of a part of this length, with speaker labels, in US dollars. */
  partCeilingUsd(seconds: number): number;
  /** What a part cost: the billed seconds when the provider reports them, otherwise the measured length. */
  partCostUsd(seconds: number, billedSeconds: number | null): number;
  /**
   * One part. Never aborted. forgetRef: the provider's id for its stored copy of the answer (an id only), stored with the
   * finished part and deleted through forget() once the transcript is stored; null when the provider keeps none.
   */
  transcribePart(
    part: AudioPart,
    o: { resumeJobId?: string; onJobId?: (id: string) => void },
  ): Promise<{ model: string; segments: Segment[]; billedSeconds: number | null; forgetRef: string | null }>;
  /** Whether this provider keeps copies that forget() deletes. */
  readonly canForget: boolean;
  /** Deletes the provider's stored copy named by a forgetRef. Free. */
  forget(ref: string): Promise<void>;
}

/** The longest provider id for a stored copy that is kept (the stt_forget CHECK); a longer one is not an id. */
const MAX_REF_LENGTH = 200;

/** A MeetingTranscriber over any provider, with speaker labels on. Exported for tests (a fake provider). */
export function meetingTranscriber(provider: SttProvider, inrPerUsd: number): MeetingTranscriber {
  const price = modelFor(provider.id, true);
  return {
    provider: provider.id,
    maxPartSeconds: provider.maxPartSeconds,
    inrPerUsd,
    partCeilingUsd: (seconds) => costUsd(price, seconds, inrPerUsd),
    partCostUsd: (seconds, billedSeconds) => {
      const usable = billedSeconds !== null && Number.isFinite(billedSeconds) && billedSeconds >= 0;
      return costUsd(price, usable ? billedSeconds : seconds, inrPerUsd);
    },
    async transcribePart(part, o) {
      const r = await provider.transcribe(part, {
        diarize: true,
        ...(o.resumeJobId !== undefined ? { resumeJobId: o.resumeJobId } : {}),
        ...(o.onJobId ? { onJobId: o.onJobId } : {}),
      });
      // The provider's own answer (raw) is never stored or logged: only the id of its stored copy is kept.
      const ref = provider.forgetRef?.(r) ?? null;
      const forgetRef = ref !== null && ref.length >= 1 && ref.length <= MAX_REF_LENGTH ? ref : null;
      return { model: r.model, segments: r.segments, billedSeconds: r.billedSeconds, forgetRef };
    },
    canForget: provider.forgetById !== undefined,
    async forget(ref) {
      await provider.forgetById?.(ref);
    },
  };
}

/**
 * The meeting transcriber STT_PROVIDER names, or null when it is 'none'. STT_API_KEY goes to the provider's constructor
 * and nowhere else. `deps.http` replaces the network in tests.
 * 'local' (the engine on this machine, no key) is null too until the local meeting transcriber is wired in: meetings
 * then wait safely at stage found (stt_none), as with 'none', and nothing is sent anywhere.
 */
export function createMeetingTranscriber(env: Env, deps: { http?: HttpFetch } = {}): MeetingTranscriber | null {
  if (env.STT_PROVIDER === 'none' || env.STT_PROVIDER === 'local') return null;
  const apiKey = requireKey(env, 'STT_API_KEY');
  const http = deps.http ? { http: deps.http } : {};
  let provider: SttProvider;
  switch (env.STT_PROVIDER) {
    case 'sarvam':
      provider = new SarvamProvider({ apiKey, ...http, maxWaitMs: MEETING_STT_TIMEOUTS.sarvamWaitMs });
      break;
    case 'elevenlabs':
      provider = new ElevenLabsProvider({ apiKey, ...http, timeoutMs: MEETING_STT_TIMEOUTS.elevenlabsMs });
      break;
    case 'openai':
      provider = new OpenAiProvider({ apiKey, ...http, timeoutMs: MEETING_STT_TIMEOUTS.openaiMs });
      break;
  }
  return meetingTranscriber(provider, env.INR_PER_USD);
}

export interface TranscribeMeetingDeps {
  db: Db;
  spend: SpendGuard;
  transcriber: MeetingTranscriber | null;
  /** Only for splitting; runs with minimalEnv() by default. */
  ffmpeg: Ffmpeg;
  dataDir: string;
  clock: Clock;
  log: Logger;
}

export interface TranscribeMeetingResult {
  parts: number;
  segments: number;
  note: 'no_speech' | null;
}

/** The SttHttpError statuses that mean the key is wrong or refused: waiting helps only once a person fixes it. */
const KEY_REFUSED = new Set([401, 403]);

/**
 * Takes a queued meeting at stage audio to stage transcribed, one part at a time, durably:
 * 1. Parts a crash left inflight with nothing booked are booked first (bookStuckParts).
 * 2. The parts are the stored stt_parts; the first time, the whole MP3 as one part, or the parts Ffmpeg.split cuts into
 *    tmp/<id>-parts/ when the audio is longer than the provider's maxPartSeconds (stored before any call). When
 *    STT_PROVIDER changed while parts were still to do, those are planned again for the new provider (replanForProvider).
 * 3. Parts already done are skipped; every state change of a part is stored at once.
 * 4. With every part done: mergeParts (times moved by each part's offset, speakers labelled per part when there are
 *    several) -> advanceStage('transcribed'), with the note no_speech and an empty transcript when nothing was said;
 *    then forgetPending for this meeting; then the parts folders are removed, best-effort.
 *
 * Outcomes the processor maps:
 * - returns: stage transcribed;
 * - MeetingDeferral (no attempt counted): stt_none (no provider: checked before anything), stt_unavailable (SttHttpError
 *   401 or 403, the key was refused; also when the part's record could not be written after it, an SttBookingError
 *   whose cause is that refusal: the refusal wins, and the part is left for bookStuckParts), spend_cap (the daily cap
 *   is reached), spend_busy (only holds of paid calls in flight are in the way);
 * - SttHttpError 429 and 5xx, SttNoAnswerError, SttJobLostError, SttJobError, SttBookingError, AudioError and others:
 *   thrown as they are, the processor retries (the part records make the retry book nothing twice);
 * - an abort: the signal's reason, before a new part starts or while splitting. A speech call is never aborted.
 * A Sarvam job that is lost after acceptance is booked again when it is sent again: a second job is a second charge.
 */
export async function transcribeMeeting(meetingId: number, deps: TranscribeMeetingDeps, signal?: AbortSignal): Promise<TranscribeMeetingResult> {
  const t = deps.transcriber;
  if (t === null) throw new MeetingDeferral('stt_none');
  try {
    return await runParts(meetingId, t, deps, signal);
  } catch (e) {
    const callError = e instanceof SttBookingError ? e.cause : e;
    if (callError instanceof SttHttpError && KEY_REFUSED.has(callError.status)) throw new MeetingDeferral('stt_unavailable');
    if (e instanceof SpendCapReachedError) throw new MeetingDeferral(e.busy ? 'spend_busy' : 'spend_cap');
    throw e;
  }
}

async function runParts(id: number, t: MeetingTranscriber, deps: TranscribeMeetingDeps, signal: AbortSignal | undefined): Promise<TranscribeMeetingResult> {
  signal?.throwIfAborted();
  const { db, log } = deps;
  // Normally done by recoverInflightParts at processor start; checked again here, so a part that may have been billed is
  // never sent again unbooked.
  bookStuckParts(db, deps.spend, id, { inrPerUsd: t.inrPerUsd, clock: deps.clock, log });
  const m = getMeeting(db, id);
  if (m === undefined) throw new Error(`transcribeMeeting: no meeting ${id}`);
  if (m.status !== 'queued' || m.stage !== 'audio') throw new Error(`transcribeMeeting: meeting ${id} is not queued at stage audio`);
  if (m.audioPath === null || m.audioSeconds === null) throw new Error(`transcribeMeeting: meeting ${id} has no audio`);
  const whole: AudioPart = { path: join(deps.dataDir, ...m.audioPath.split('/')), seconds: m.audioSeconds, offset: 0 };

  const parts: SttPartRow[] = m.sttParts.map((p) => ({ ...p }));
  const ctx = partContext(id, parts, t, deps, whole);
  if (parts.length === 0) await planParts(ctx, signal);
  else if (parts.some((p) => p.state !== 'done' && p.provider !== t.provider)) await replanForProvider(ctx, signal);
  await ensurePartFiles(ctx, signal);

  for (let i = 0; i < parts.length; i++) {
    if (parts[i]!.state === 'done') continue;
    signal?.throwIfAborted();
    if (t.provider === 'sarvam') await sarvamPart(ctx, i);
    else await heldPart(ctx, i);
  }

  const merged = mergeParts(parts.map((p) => ({ offset: p.offset, segments: p.segments ?? [] })));
  const noSpeech = merged.every((s) => s.text.trim() === '');
  const transcript = noSpeech ? [] : merged;
  advanceStage(db, id, 'transcribed', noSpeech ? { transcript, note: 'no_speech' } : { transcript }, deps.clock.now().toISOString());
  log.info({ meetingId: id, parts: parts.length, segmentCount: transcript.length, noSpeech }, 'meeting transcribed');

  // Only now that the transcript is stored: the provider's own copies go. What fails stays noted in stt_forget, and
  // forgetPending tries again at the next processor start.
  try {
    await forgetPending(db, t, log, { meetingId: id, clock: deps.clock });
  } catch (e) {
    log.warn({ meetingId: id, code: errorCode(e) }, 'meeting speech copies could not be deleted at the provider');
  }
  const folders = new Set([`${id}-parts`, ...parts.flatMap((p) => (p.file === null ? [] : [p.file.split('/')[0]!]))]);
  for (const f of folders) removeParts(id, join(meetingsTmpDir(deps.dataDir), f), log);
  return { parts: parts.length, segments: transcript.length, note: noSpeech ? 'no_speech' : null };
}

/** Removes a parts folder with the same rules as cleanupTemp; best-effort (cleanupTemp tries again at the next start). */
function removeParts(id: number, dir: string, log: Logger): void {
  try {
    if (!lstatSync(dir).isDirectory()) return;
    if (!removePartsFolder(dir)) log.warn({ meetingId: id }, 'meeting parts folder holds unexpected entries; left alone');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    log.warn({ meetingId: id, code: errorCode(e) }, 'meeting work file could not be removed');
  }
}

/**
 * At processor start, before any speech call: bookStuckParts for every meeting, of any status, with a part left inflight
 * with nothing booked, each at the ceiling of the provider it was sent to. A Sarvam part with a job id is already booked
 * and is resumed later; an unknown part without one is sent again with a new hold. Needs no transcriber, so it runs with
 * STT_PROVIDER none too. Returns how many parts were booked. A meeting whose record cannot be read or written is logged
 * by id and left for the next call (transcribeMeeting and the processor's final bookStuckParts check it again).
 */
export function recoverInflightParts(db: Db, spend: SpendGuard, inrPerUsd: number, log: Logger, clock: Clock = systemClock): number {
  let booked = 0;
  for (const id of meetingIdsWithInflightParts(db)) {
    try {
      booked += bookStuckParts(db, spend, id, { inrPerUsd, clock, log });
    } catch (e) {
      log.warn({ meetingId: id, code: errorCode(e) }, 'meeting speech parts could not be recovered');
    }
  }
  return booked;
}
