import { lstatSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SpendCapReachedError } from '../brain/paidCall.ts';
import { requireKey, type Env } from '../config/env.ts';
import type { SpendGuard } from '../spend/spendGuard.ts';
import type { Db } from '../store/db.ts';
import { tx } from '../store/db.ts';
import {
  addSttForget, advanceStage, countSttForgetAttempt, deleteSttForget, getMeeting, pendingSttForgets, queuedMeetingIdsWithSttParts, setSttParts,
  type SttPartRow,
} from '../store/meetings.ts';
import { AudioError, type Ffmpeg } from '../stt/audio.ts';
import { SttHttpError, SttJobError, SttJobLostError, type HttpFetch } from '../stt/http.ts';
import { withSttHold } from '../stt/paidStt.ts';
import { costUsd, modelFor } from '../stt/prices.ts';
import { ElevenLabsProvider } from '../stt/providers/elevenlabs.ts';
import { OpenAiProvider } from '../stt/providers/openai.ts';
import { SarvamProvider } from '../stt/providers/sarvam.ts';
import { mergeParts } from '../stt/segments.ts';
import type { AudioPart, ProviderId, Segment, SttProvider } from '../stt/types.ts';
import { systemClock, type Clock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';
import { MeetingDeferral, meetingsTmpDir, removePartsFolder } from './audio.ts';

// Meeting transcription (Task 6). Every paid speech call is booked as 'stt' spend exactly once, across crashes, retries
// and shutdowns, through the durable part records in meetings.stt_parts (see the plan's behaviour notes):
// - ElevenLabs and OpenAI: the part is set inflight, then the ceiling is held (withSttHold) and settled at the reported
//   cost, or at the ceiling when the outcome is unknown. A hold that shutdown books (settlePending) marks the part booked.
// - A booking and the part state it goes with are written in one transaction; if that fails, the part is left inflight
//   with nothing booked, and bookStuckParts books it at the ceiling before anything is sent again.
// - A provider copy of an answer (ElevenLabs) is noted in stt_forget with the finished part and deleted once the
//   transcript is stored (M7); forgetPending tries again later.
// - Sarvam: the ceiling is held while the job is sent and booked, durably with the job id, when the job is accepted. The
//   list price for the measured length is exactly the ceiling, so nothing more is booked when the answer comes; no
//   in-memory hold has to outlive a batch job of up to 3 hours.
// - recoverInflightParts, at processor start, books at the ceiling any part a crash left inflight with nothing booked.
// Logs carry the meeting id, part number, provider, seconds and cost only: never what was said, paths or keys.

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
 */
export function createMeetingTranscriber(env: Env, deps: { http?: HttpFetch } = {}): MeetingTranscriber | null {
  if (env.STT_PROVIDER === 'none') return null;
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
 * 1. The parts are the stored stt_parts, or, the first time, the whole MP3 as one part, or the parts Ffmpeg.split cuts
 *    into tmp/<id>-parts/ when the audio is longer than the provider's maxPartSeconds. They are stored before any call.
 * 2. Parts already done are skipped; every state change of a part is stored at once (see the header for the booking).
 * 3. With every part done: mergeParts (times moved by each part's offset, speakers labelled per part when there are
 *    several) -> advanceStage('transcribed'), with the note no_speech and an empty transcript when nothing was said;
 *    then forgetPending for this meeting (the provider copies noted in stt_forget, with each finished part); then the
 *    parts folder is removed, best-effort.
 *
 * Outcomes the processor maps:
 * - returns: stage transcribed;
 * - MeetingDeferral (no attempt counted): stt_none (no provider: checked before anything), stt_unavailable (SttHttpError
 *   401 or 403, the key was refused), spend_cap (the daily cap is reached), spend_busy (only holds of paid calls in
 *   flight are in the way);
 * - SttHttpError 429 and 5xx, SttNoAnswerError, SttJobLostError, SttJobError, AudioError and others: thrown as they are,
 *   the processor retries (the part records make the retry book nothing twice);
 * - an abort: the signal's reason, before a new part starts or while splitting. A speech call is never aborted.
 * A Sarvam job that is lost after acceptance is booked again when it is sent again: a second job is a second charge.
 */
export async function transcribeMeeting(meetingId: number, deps: TranscribeMeetingDeps, signal?: AbortSignal): Promise<TranscribeMeetingResult> {
  const t = deps.transcriber;
  if (t === null) throw new MeetingDeferral('stt_none');
  try {
    return await runParts(meetingId, t, deps, signal);
  } catch (e) {
    if (e instanceof SttHttpError && KEY_REFUSED.has(e.status)) throw new MeetingDeferral('stt_unavailable');
    if (e instanceof SpendCapReachedError) throw new MeetingDeferral(e.busy ? 'spend_busy' : 'spend_cap');
    throw e;
  }
}

const todo = (index: number, offset: number, seconds: number): SttPartRow => ({
  index, offset, seconds, state: 'todo', jobId: null, booked: 'none', segments: null, billedSeconds: null,
});

/** A short code for a log line: never an error message, which could echo a path or a key. */
function errorCode(e: unknown): string {
  if (e instanceof SttHttpError) return `http_${e.status}`;
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return code;
  const name = (e as { name?: unknown } | null)?.name;
  return typeof name === 'string' ? name : 'unknown';
}

async function runParts(id: number, t: MeetingTranscriber, deps: TranscribeMeetingDeps, signal: AbortSignal | undefined): Promise<TranscribeMeetingResult> {
  signal?.throwIfAborted();
  const { db, log } = deps;
  const m = getMeeting(db, id);
  if (m === undefined) throw new Error(`transcribeMeeting: no meeting ${id}`);
  if (m.status !== 'queued' || m.stage !== 'audio') throw new Error(`transcribeMeeting: meeting ${id} is not queued at stage audio`);
  if (m.audioPath === null || m.audioSeconds === null) throw new Error(`transcribeMeeting: meeting ${id} has no audio`);
  const audioAbs = join(deps.dataDir, ...m.audioPath.split('/'));
  const partsDir = join(meetingsTmpDir(deps.dataDir), `${id}-parts`);
  const whole: AudioPart = { path: audioAbs, seconds: m.audioSeconds, offset: 0 };

  const parts: SttPartRow[] = m.sttParts.map((p) => ({ ...p }));
  // Normally done by recoverInflightParts at processor start; checked again here, so a part that may have been billed is
  // never sent again unbooked.
  if (bookStuckParts(db, deps.spend, t, id, parts, deps.clock.now().toISOString()) > 0) {
    log.info({ meetingId: id, provider: t.provider }, 'meeting speech parts left in flight booked at their ceiling');
  }
  const ctx = partContext(id, parts, t, deps);
  const { save } = ctx;

  let paths: string[];
  if (parts.length === 0) {
    const cut = m.audioSeconds > t.maxPartSeconds ? await deps.ffmpeg.split(whole, partsDir, t.maxPartSeconds, signal) : [whole];
    cut.forEach((p, i) => parts.push(todo(i + 1, p.offset, p.seconds)));
    paths = cut.map((p) => p.path);
    save();
  } else if (parts.length === 1) {
    paths = [audioAbs];
  } else if (parts.some((p) => p.state !== 'done')) {
    // A finished split is reused (Ffmpeg.split only measures it); the stored parts must still match it.
    const cut = await deps.ffmpeg.split(whole, partsDir, t.maxPartSeconds, signal);
    if (cut.length !== parts.length) throw new AudioError('split_changed');
    paths = cut.map((p) => p.path);
  } else {
    paths = [];
  }

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part.state === 'done') continue;
    signal?.throwIfAborted();
    const audio: AudioPart = { path: paths[i]!, seconds: part.seconds, offset: part.offset };
    if (t.provider === 'sarvam') await sarvamPart(ctx, i, audio);
    else await heldPart(ctx, i, audio);
  }

  const merged = mergeParts(parts.map((p) => ({ offset: p.offset, segments: p.segments ?? [] })));
  const noSpeech = merged.every((s) => s.text.trim() === '');
  const transcript = noSpeech ? [] : merged;
  advanceStage(db, id, 'transcribed', noSpeech ? { transcript, note: 'no_speech' } : { transcript }, deps.clock.now().toISOString());
  log.info({ meetingId: id, parts: parts.length, segments: transcript.length, noSpeech }, 'meeting transcribed');

  // Only now that the transcript is stored: the provider's own copies go. What fails stays noted in stt_forget, and
  // forgetPending tries again at the next processor start.
  try {
    await forgetPending(db, t, log, { meetingId: id });
  } catch (e) {
    log.warn({ meetingId: id, code: errorCode(e) }, 'meeting speech copies could not be deleted at the provider');
  }
  removeParts(id, partsDir, log);
  return { parts: parts.length, segments: transcript.length, note: noSpeech ? 'no_speech' : null };
}

/** Removes the parts folder with the same rules as cleanupTemp; best-effort (cleanupTemp tries again at the next start). */
function removeParts(id: number, dir: string, log: Logger): void {
  try {
    if (!lstatSync(dir).isDirectory()) return;
    if (!removePartsFolder(dir)) log.warn({ meetingId: id }, 'meeting parts folder holds unexpected entries; left alone');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    log.warn({ meetingId: id, code: errorCode(e) }, 'meeting work file could not be removed');
  }
}

type PartAnswer = Awaited<ReturnType<MeetingTranscriber['transcribePart']>>;

/** One meeting's parts, as stored, and the writes on them. */
interface PartContext {
  id: number;
  parts: SttPartRow[];
  t: MeetingTranscriber;
  deps: TranscribeMeetingDeps;
  save(): void;
  /** Changes part i and stores the parts at once; on a failed write the part stays as it was. */
  put(i: number, patch: Partial<SttPartRow>): void;
  /**
   * Runs fn in one transaction (a savepoint inside another). A booking and the part state it goes with are written here,
   * so they are kept or lost together; on a failure the parts in memory go back to what is stored.
   */
  atomically(fn: () => void): void;
  /** Part i is done: its answer and, when the provider keeps a copy, that copy's id in stt_forget. Inside atomically. */
  markDone(i: number, r: PartAnswer, booked?: SttPartRow['booked']): void;
}

function partContext(id: number, parts: SttPartRow[], t: MeetingTranscriber, deps: TranscribeMeetingDeps): PartContext {
  const { db, clock } = deps;
  const save = () => setSttParts(db, id, parts, clock.now().toISOString());
  const put = (i: number, patch: Partial<SttPartRow>) => {
    const prev = parts[i]!;
    parts[i] = { ...prev, ...patch };
    try {
      save();
    } catch (e) {
      parts[i] = prev;
      throw e;
    }
  };
  const atomically = (fn: () => void) => {
    const stored = [...parts];
    try {
      tx(db, fn);
    } catch (e) {
      parts.splice(0, parts.length, ...stored);
      throw e;
    }
  };
  const markDone = (i: number, r: PartAnswer, booked?: SttPartRow['booked']) => {
    put(i, { state: 'done', segments: r.segments, billedSeconds: r.billedSeconds, ...(booked ? { booked } : {}) });
    if (r.forgetRef !== null) addSttForget(db, { meetingId: id, provider: t.provider, ref: r.forgetRef, at: clock.now().toISOString() });
  };
  return { id, parts, t, deps, save, put, atomically, markDone };
}

/**
 * Before a new send: the part's file must be there. A local failure here is thrown as it is (retryable): nothing was
 * sent, so nothing is booked.
 */
function checkPartFile(path: string): void {
  if (!statSync(path).isFile()) throw new AudioError('part_missing');
}

/**
 * ElevenLabs and OpenAI: one synchronous call, held and settled by withSttHold, which writes the booking and the part's
 * outcome in one transaction. If that write fails, the part stays inflight with nothing booked, and bookStuckParts books
 * it at the ceiling before it is sent again.
 */
async function heldPart(ctx: PartContext, i: number, audio: AudioPart): Promise<void> {
  const { id, parts, t, deps, put } = ctx;
  const before = parts[i]!;
  const label = `meeting ${id} part ${before.index}`;
  const ceiling = t.partCeilingUsd(before.seconds);
  checkPartFile(audio.path);
  // A part sent again is a new call: what was booked before belongs to the earlier call.
  put(i, { state: 'inflight', booked: 'none', jobId: null });
  let sent = false;
  let cost = 0;
  try {
    ({ costUsd: cost } = await withSttHold<PartAnswer>(
      deps.spend,
      ceiling,
      label,
      async () => {
        sent = true;
        const r = await t.transcribePart(audio, {});
        return { result: r, costUsd: t.partCostUsd(before.seconds, r.billedSeconds) };
      },
      {
        atomically: ctx.atomically,
        onBooked: (b, r) => {
          if (r !== undefined) ctx.markDone(i, r, 'actual');
          else if (b.outcome === 'none') put(i, { state: 'todo', booked: 'none' });
          else put(i, { state: 'unknown', booked: 'ceiling' });
        },
        onBookedAtShutdown: () => put(i, { state: 'unknown', booked: 'ceiling' }),
      },
    ));
  } catch (e) {
    // Never sent (no room under the cap): as it was. Anything else is already written with its booking, or left
    // inflight with nothing booked for bookStuckParts.
    if (e instanceof SpendCapReachedError && !sent) put(i, before);
    deps.log.warn({ meetingId: id, part: before.index, provider: t.provider, code: errorCode(e), state: parts[i]!.state }, 'meeting speech part failed');
    throw e;
  }
  deps.log.info({ meetingId: id, part: before.index, provider: t.provider, seconds: Math.round(before.seconds), costUsd: cost }, 'meeting speech part transcribed');
}

/**
 * Sarvam: a batch job. A stored job id is waited on again, booking nothing more. A new job holds the ceiling while it is
 * sent; when Sarvam accepts it, the hold is settled at the ceiling and the job id stored in one transaction.
 */
async function sarvamPart(ctx: PartContext, i: number, audio: AudioPart): Promise<void> {
  const { id, parts, t, deps, put, atomically } = ctx;
  const { spend, log } = deps;
  const before = parts[i]!;
  const label = `meeting ${id} part ${before.index}`;
  const ceiling = t.partCeilingUsd(before.seconds);
  const resumeJobId = before.jobId ?? undefined;
  let hold: number | null = null;

  if (resumeJobId !== undefined) {
    if (before.booked === 'none') {
      // Never written this way (the id and the booking are stored together), but a job id means a job was started.
      atomically(() => {
        spend.record('stt', ceiling, label);
        put(i, { booked: 'ceiling' });
      });
    }
    put(i, { state: 'inflight' });
  } else {
    checkPartFile(audio.path);
    // A new job: what was booked before belongs to an earlier job.
    put(i, { state: 'inflight', booked: 'none' });
    hold = spend.reserve(ceiling, 'stt', () => put(i, { state: 'unknown', booked: 'ceiling' }));
    if (hold === null) {
      put(i, before);
      throw new SpendCapReachedError({ busy: spend.fitsIgnoringHolds(ceiling) });
    }
  }

  let seenJobId: string | null = resumeJobId ?? null;
  const onJobId = (jobId: string): void => {
    const h = hold;
    if (h === null) return; // only a new job is booked here
    seenJobId = jobId;
    // settle books nothing when shutdown already booked the hold.
    atomically(() => {
      spend.settle(h, 'stt', ceiling, label);
      put(i, { jobId, booked: 'ceiling' });
    });
    hold = null;
    log.info({ meetingId: id, part: before.index, provider: t.provider, seconds: Math.round(before.seconds), costUsd: ceiling }, 'meeting speech job accepted');
  };

  try {
    const r = await t.transcribePart(audio, resumeJobId !== undefined ? { resumeJobId } : { onJobId });
    const h = hold;
    atomically(() => {
      if (h !== null) spend.settle(h, 'stt', ceiling, label); // an answer without a job id first: booked now
      ctx.markDone(i, r, h !== null ? 'ceiling' : undefined);
    });
    hold = null;
    log.info({ meetingId: id, part: before.index, provider: t.provider, seconds: Math.round(before.seconds) }, 'meeting speech part transcribed');
  } catch (e) {
    const h = hold;
    hold = null;
    if (h !== null) {
      // The job was never accepted, or its booking could not be written.
      if (e instanceof SttHttpError) {
        spend.release(h);
        put(i, { state: 'todo', booked: 'none', jobId: null });
      } else {
        atomically(() => {
          spend.settle(h, 'stt', ceiling, `${label} (unknown, estimated)`);
          put(i, { state: 'unknown', booked: 'ceiling', jobId: seenJobId });
        });
      }
    } else {
      // The job is booked. A lost or failed job cannot be waited on again: its id goes, and a retry sends a new job.
      const gone = e instanceof SttJobLostError || e instanceof SttJobError;
      put(i, gone ? { state: 'unknown', jobId: null } : { state: 'unknown' });
    }
    log.warn({ meetingId: id, part: before.index, provider: t.provider, code: errorCode(e) }, 'meeting speech part failed');
    throw e;
  }
}

/** Tries per stt_forget row; then it is left, logged, for a person to look at. */
export const MAX_FORGET_ATTEMPTS = 5;

/**
 * Deletes the provider copies noted in stt_forget (M7), for the transcriber's provider: each try is counted first, and
 * a row is removed only once the provider has deleted the copy (a 404: it is already gone). Run right after a meeting's
 * transcript is stored (that meeting only) and at processor start next to recoverInflightParts (all). After
 * MAX_FORGET_ATTEMPTS tries a row is left alone. Logs the meeting id and a code only. Returns how many were deleted.
 */
export async function forgetPending(db: Db, transcriber: MeetingTranscriber, log: Logger, o: { meetingId?: number } = {}): Promise<number> {
  if (!transcriber.canForget) return 0;
  const rows = pendingSttForgets(db, { provider: transcriber.provider, maxAttempts: MAX_FORGET_ATTEMPTS, ...(o.meetingId !== undefined ? { meetingId: o.meetingId } : {}) });
  let deleted = 0;
  for (const f of rows) {
    countSttForgetAttempt(db, f.id);
    try {
      await transcriber.forget(f.ref);
    } catch (e) {
      if (!(e instanceof SttHttpError && e.status === 404)) {
        const attempts = f.attempts + 1;
        const fields = { meetingId: f.meetingId, provider: f.provider, code: errorCode(e), attempts };
        if (attempts >= MAX_FORGET_ATTEMPTS) log.warn(fields, 'meeting speech copy could not be deleted at the provider; no more tries');
        else log.warn(fields, 'meeting speech copy could not be deleted at the provider; tried again later');
        continue;
      }
    }
    deleteSttForget(db, f.id);
    deleted++;
  }
  return deleted;
}

/**
 * Books at the ceiling, as 'stt' "(unknown, estimated)", every part that a crash left inflight with nothing booked (it
 * may have been billed), sets it unknown/ceiling and stores the parts, in one transaction. Mutates `parts`. Returns how
 * many were booked.
 */
function bookStuckParts(db: Db, spend: SpendGuard, t: MeetingTranscriber, id: number, parts: SttPartRow[], at: string): number {
  const stuck = parts.filter((p) => p.state === 'inflight' && p.booked === 'none');
  if (stuck.length === 0) return 0;
  tx(db, () => {
    for (const p of stuck) spend.record('stt', t.partCeilingUsd(p.seconds), `meeting ${id} part ${p.index} (unknown, estimated)`);
    setSttParts(db, id, parts.map((p) => (stuck.includes(p) ? { ...p, state: 'unknown', booked: 'ceiling' } : p)), at);
  });
  for (const p of stuck) {
    p.state = 'unknown';
    p.booked = 'ceiling';
  }
  return stuck.length;
}

/**
 * At processor start, before any speech call: every part of a queued meeting that a crash left inflight with nothing
 * booked is booked at its ceiling as 'stt' "(unknown, estimated)" and set unknown/ceiling (bookStuckParts). A Sarvam
 * part with a job id is already booked and is resumed later; an unknown part without one is sent again with a new hold.
 * The processor runs this only with a transcriber: with STT_PROVIDER none the parts wait, and are booked when a provider
 * is set again, before any call (transcribeMeeting does the same check for its own meeting). Returns how many parts were
 * booked. A meeting whose record cannot be read or written is logged by id and left for transcribeMeeting.
 */
export function recoverInflightParts(db: Db, spend: SpendGuard, transcriber: MeetingTranscriber, log: Logger, clock: Clock = systemClock): number {
  let booked = 0;
  for (const id of queuedMeetingIdsWithSttParts(db)) {
    try {
      const m = getMeeting(db, id);
      if (m === undefined) continue;
      const n = bookStuckParts(db, spend, transcriber, id, m.sttParts.map((p) => ({ ...p })), clock.now().toISOString());
      if (n === 0) continue;
      booked += n;
      log.info({ meetingId: id, parts: n, provider: transcriber.provider }, 'meeting speech parts left in flight booked at their ceiling');
    } catch (e) {
      log.warn({ meetingId: id, code: errorCode(e) }, 'meeting speech parts could not be recovered');
    }
  }
  return booked;
}
