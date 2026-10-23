import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { SpendCapReachedError } from '../brain/paidCall.ts';
import { requireKey, type Env } from '../config/env.ts';
import type { SpendGuard } from '../spend/spendGuard.ts';
import type { Db } from '../store/db.ts';
import { tx } from '../store/db.ts';
import { advanceStage, getMeeting, queuedMeetingIdsWithSttParts, setSttParts, type SttPartRow } from '../store/meetings.ts';
import { AudioError, type Ffmpeg } from '../stt/audio.ts';
import { SttHttpError, SttJobError, SttJobLostError, type HttpFetch } from '../stt/http.ts';
import { withSttHold, type SttBooking } from '../stt/paidStt.ts';
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
  /** One part. Never aborted. forget() deletes the provider's copy and is called after the transcript is stored. */
  transcribePart(
    part: AudioPart,
    o: { resumeJobId?: string; onJobId?: (id: string) => void },
  ): Promise<{ model: string; segments: Segment[]; billedSeconds: number | null; forget?: () => Promise<void> }>;
}

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
      const out = { model: r.model, segments: r.segments, billedSeconds: r.billedSeconds };
      // The provider's own answer (raw) stays inside this closure: it is never stored or logged.
      return provider.forget ? { ...out, forget: () => provider.forget!(r) } : out;
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
 *    then forget() for this run's answers (failures logged by id only); then the parts folder is removed, best-effort.
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
  const save = () => setSttParts(db, id, parts, deps.clock.now().toISOString());
  const put = (i: number, patch: Partial<SttPartRow>) => {
    parts[i] = { ...parts[i]!, ...patch };
    save();
  };

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

  const forgets: { part: number; forget: () => Promise<void> }[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part.state === 'done') continue;
    signal?.throwIfAborted();
    const audio: AudioPart = { path: paths[i]!, seconds: part.seconds, offset: part.offset };
    const r = t.provider === 'sarvam' ? await sarvamPart(id, i, audio, parts, put, t, deps) : await heldPart(id, i, audio, parts, put, t, deps);
    if (r.forget) forgets.push({ part: part.index, forget: r.forget });
  }

  const merged = mergeParts(parts.map((p) => ({ offset: p.offset, segments: p.segments ?? [] })));
  const noSpeech = merged.every((s) => s.text.trim() === '');
  const transcript = noSpeech ? [] : merged;
  advanceStage(db, id, 'transcribed', noSpeech ? { transcript, note: 'no_speech' } : { transcript }, deps.clock.now().toISOString());
  log.info({ meetingId: id, parts: parts.length, segments: transcript.length, noSpeech }, 'meeting transcribed');

  // Only now that the transcript is stored: the provider's own copies go.
  for (const f of forgets) {
    try {
      await f.forget();
    } catch (e) {
      log.warn({ meetingId: id, part: f.part, provider: t.provider, code: errorCode(e) }, 'meeting speech copy could not be deleted at the provider');
    }
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
type Put = (i: number, patch: Partial<SttPartRow>) => void;

/** For a callback that must not throw (settlePending's): the part record is written, or the failure logged. */
function putQuietly(put: Put, i: number, patch: Partial<SttPartRow>, id: number, log: Logger): void {
  try {
    put(i, patch);
  } catch (e) {
    log.warn({ meetingId: id, part: i + 1, code: errorCode(e) }, 'meeting speech part record could not be written');
  }
}

/** ElevenLabs and OpenAI: one synchronous call, held and settled by withSttHold. */
async function heldPart(id: number, i: number, audio: AudioPart, parts: SttPartRow[], put: Put, t: MeetingTranscriber, deps: TranscribeMeetingDeps): Promise<PartAnswer> {
  const before = parts[i]!;
  const label = `meeting ${id} part ${before.index}`;
  const ceiling = t.partCeilingUsd(before.seconds);
  // A part sent again is a new call: what was booked before belongs to the earlier call.
  put(i, { state: 'inflight', booked: 'none', jobId: null });
  let booking: SttBooking | null = null;
  try {
    const { result, costUsd: cost } = await withSttHold(
      deps.spend,
      ceiling,
      label,
      async () => {
        const r = await t.transcribePart(audio, {});
        return { result: r, costUsd: t.partCostUsd(before.seconds, r.billedSeconds) };
      },
      {
        onBooked: (b) => (booking = b),
        onBookedAtShutdown: () => putQuietly(put, i, { state: 'unknown', booked: 'ceiling' }, id, deps.log),
      },
    );
    put(i, { state: 'done', booked: 'actual', segments: result.segments, billedSeconds: result.billedSeconds });
    deps.log.info({ meetingId: id, part: before.index, provider: t.provider, seconds: Math.round(before.seconds), costUsd: cost }, 'meeting speech part transcribed');
    return result;
  } catch (e) {
    const b = booking as SttBooking | null;
    if (b === null) put(i, before); // never sent (no room under the cap): as it was
    else if (b.outcome === 'none') put(i, { state: 'todo', booked: 'none' });
    else put(i, { state: 'unknown', booked: 'ceiling' });
    deps.log.warn({ meetingId: id, part: before.index, provider: t.provider, code: errorCode(e), bookedUsd: b?.usd ?? 0 }, 'meeting speech part failed');
    throw e;
  }
}

/**
 * Sarvam: a batch job. A stored job id is waited on again, booking nothing more. A new job holds the ceiling while it is
 * sent; when Sarvam accepts it, the ceiling is booked and the job id stored in one transaction, and the hold freed.
 */
async function sarvamPart(id: number, i: number, audio: AudioPart, parts: SttPartRow[], put: Put, t: MeetingTranscriber, deps: TranscribeMeetingDeps): Promise<PartAnswer> {
  const { db, spend, log } = deps;
  const before = parts[i]!;
  const label = `meeting ${id} part ${before.index}`;
  const ceiling = t.partCeilingUsd(before.seconds);
  const resumeJobId = before.jobId ?? undefined;
  let hold: number | null = null;
  let bookedAtShutdown = false;

  if (resumeJobId !== undefined) {
    if (before.booked === 'none') {
      // Never written this way (the id and the booking are stored together), but a job id means a job was started.
      tx(db, () => {
        spend.record('stt', ceiling, label);
        put(i, { booked: 'ceiling' });
      });
    }
    put(i, { state: 'inflight' });
  } else {
    // A new job: what was booked before belongs to an earlier job.
    put(i, { state: 'inflight', booked: 'none' });
    hold = spend.reserve(ceiling, 'stt', () => {
      bookedAtShutdown = true;
      putQuietly(put, i, { state: 'unknown', booked: 'ceiling' }, id, log);
    });
    if (hold === null) {
      put(i, before);
      throw new SpendCapReachedError({ busy: spend.fitsIgnoringHolds(ceiling) });
    }
  }

  let seenJobId: string | null = resumeJobId ?? null;
  const onJobId = (jobId: string): void => {
    if (hold === null) return; // only a new job is booked here
    seenJobId = jobId;
    if (!bookedAtShutdown) {
      tx(db, () => {
        spend.record('stt', ceiling, label);
        put(i, { jobId, booked: 'ceiling' });
      });
    } else {
      put(i, { jobId, booked: 'ceiling' });
    }
    spend.release(hold);
    hold = null;
    log.info({ meetingId: id, part: before.index, provider: t.provider, seconds: Math.round(before.seconds), costUsd: ceiling }, 'meeting speech job accepted');
  };

  try {
    const r = await t.transcribePart(audio, resumeJobId !== undefined ? { resumeJobId } : { onJobId });
    if (hold !== null) {
      // An answer without a job id first: book it now, at the ceiling.
      spend.settle(hold, 'stt', ceiling, label);
      hold = null;
      put(i, { booked: 'ceiling' });
    }
    put(i, { state: 'done', segments: r.segments, billedSeconds: r.billedSeconds });
    log.info({ meetingId: id, part: before.index, provider: t.provider, seconds: Math.round(before.seconds) }, 'meeting speech part transcribed');
    return r;
  } catch (e) {
    let bookedUsd = 0;
    if (hold !== null) {
      // The job was never accepted, or its booking failed to be written.
      if (e instanceof SttHttpError) {
        spend.release(hold);
        hold = null;
        put(i, { state: 'todo', booked: 'none', jobId: null });
      } else {
        spend.settle(hold, 'stt', ceiling, `${label} (unknown, estimated)`);
        hold = null;
        bookedUsd = ceiling;
        put(i, { state: 'unknown', booked: 'ceiling', jobId: seenJobId });
      }
    } else {
      // The job is booked. A lost or failed job cannot be waited on again: its id goes, and a retry sends a new job.
      const gone = e instanceof SttJobLostError || e instanceof SttJobError;
      put(i, gone ? { state: 'unknown', jobId: null } : { state: 'unknown' });
    }
    log.warn({ meetingId: id, part: before.index, provider: t.provider, code: errorCode(e), bookedUsd }, 'meeting speech part failed');
    throw e;
  }
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
