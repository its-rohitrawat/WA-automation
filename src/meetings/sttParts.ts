import { existsSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { SpendCapReachedError } from '../brain/paidCall.ts';
import type { SpendGuard } from '../spend/spendGuard.ts';
import { tx, type Db } from '../store/db.ts';
import { addSttForget, getMeeting, PART_FILE, setSttParts, writeStuckSttParts, type SttPartRow } from '../store/meetings.ts';
import { AudioError } from '../stt/audio.ts';
import { SttHttpError, SttJobError, SttJobLostError } from '../stt/http.ts';
import { SttBookingError, withSttHold } from '../stt/paidStt.ts';
import { costUsd, modelFor } from '../stt/prices.ts';
import type { AudioPart, ProviderId } from '../stt/types.ts';
import { systemClock, type Clock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';
import { meetingsTmpDir } from './audio.ts';
import type { MeetingTranscriber, TranscribeMeetingDeps } from './transcribe.ts';

// The durable speech parts of one meeting (Task 6): planning them, sending one, and booking what a crash left in flight.
// See src/meetings/transcribe.ts for the whole flow and what the processor calls.

/** A short code for a log line: never an error message, which could echo a path or a key. */
export function errorCode(e: unknown): string {
  if (e instanceof SttHttpError) return `http_${e.status}`;
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return code;
  const name = (e as { name?: unknown } | null)?.name;
  return typeof name === 'string' ? name : 'unknown';
}

/** The list price, with speaker labels, of a part of this length at this provider, in US dollars. */
export function partCeilingFor(provider: ProviderId, seconds: number, inrPerUsd: number): number {
  return costUsd(modelFor(provider, true), seconds, inrPerUsd);
}

/**
 * Books every part of the meeting that was left inflight with nothing booked (it may have been billed) at the ceiling of
 * the provider it was sent to, as 'stt' "(unknown, estimated)", and sets it unknown/ceiling, in one transaction. Works
 * whatever the meeting's status: the processor calls it before failMeeting, so a part of a meeting that fails is still
 * booked, and recoverInflightParts calls it for every meeting at start. Booking twice is impossible: the parts it books
 * are no longer inflight/none. Returns how many were booked. Throws when the meeting is missing or its record cannot be
 * read or written (nothing is booked then).
 */
export function bookStuckParts(db: Db, spend: SpendGuard, meetingId: number, o: { inrPerUsd: number; clock?: Clock; log?: Logger }): number {
  const m = getMeeting(db, meetingId);
  if (m === undefined) throw new Error(`bookStuckParts: no meeting ${meetingId}`);
  const stuck = (p: SttPartRow) => p.state === 'inflight' && p.booked === 'none';
  const n = m.sttParts.filter(stuck).length;
  if (n === 0) return 0;
  tx(db, () => {
    for (const p of m.sttParts.filter(stuck)) {
      spend.record('stt', partCeilingFor(p.provider, p.seconds, o.inrPerUsd), `meeting ${meetingId} part ${p.index} (unknown, estimated)`);
    }
    const parts = m.sttParts.map((p): SttPartRow => (stuck(p) ? { ...p, state: 'unknown', booked: 'ceiling' } : p));
    writeStuckSttParts(db, meetingId, parts, (o.clock ?? systemClock).now().toISOString());
  });
  o.log?.info({ meetingId, parts: n }, 'meeting speech parts left in flight booked at their ceiling');
  return n;
}

type PartAnswer = Awaited<ReturnType<MeetingTranscriber['transcribePart']>>;

/** One meeting's parts, as stored, and the writes on them. */
export interface PartContext {
  id: number;
  parts: SttPartRow[];
  t: MeetingTranscriber;
  deps: TranscribeMeetingDeps;
  /** The kept MP3 of the whole meeting. */
  whole: AudioPart;
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
  /** The absolute path of a part's MP3. Throws for a stored name that is not one of this meeting's part files. */
  pathOf(p: SttPartRow): string;
}

export function partContext(id: number, parts: SttPartRow[], t: MeetingTranscriber, deps: TranscribeMeetingDeps, whole: AudioPart): PartContext {
  const { db, clock } = deps;
  const tmp = meetingsTmpDir(deps.dataDir);
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
  const pathOf = (p: SttPartRow) => {
    if (p.file === null) return whole.path;
    if (!PART_FILE.test(p.file) || !p.file.startsWith(`${id}-parts`)) throw new Error(`meeting ${id}: a stored part file name is not valid`);
    return join(tmp, ...p.file.split('/'));
  };
  return { id, parts, t, deps, whole, save, put, atomically, markDone, pathOf };
}

const todo = (index: number, provider: ProviderId, offset: number, seconds: number, file: string | null): SttPartRow => ({
  index, provider, file, offset, seconds, state: 'todo', jobId: null, booked: 'none', segments: null, billedSeconds: null,
});

/**
 * The first plan: the whole MP3 as one part, or, when it is longer than the provider's maxPartSeconds, the parts
 * Ffmpeg.split cuts into tmp/<id>-parts/. Stored before any call.
 */
export async function planParts(ctx: PartContext, signal: AbortSignal | undefined): Promise<void> {
  const { id, parts, t, whole, deps } = ctx;
  if (whole.seconds > t.maxPartSeconds) {
    const folder = `${id}-parts`;
    const cut = await deps.ffmpeg.split(whole, join(meetingsTmpDir(deps.dataDir), folder), t.maxPartSeconds, signal);
    cut.forEach((c, i) => parts.push(todo(i + 1, t.provider, c.offset, c.seconds, `${folder}/${basename(c.path)}`)));
  } else {
    parts.push(todo(1, t.provider, 0, whole.seconds, null));
  }
  ctx.save();
}

/**
 * STT_PROVIDER changed while parts were still to do. Done parts are kept as they are, with their segments. Every part
 * not done (stuck ones are already booked by bookStuckParts, at the old provider's price) goes to the new provider as
 * todo: as it is when it fits the new maxPartSeconds, otherwise cut again from its own MP3 into tmp/<id>-parts-<n>/.
 * The parts are numbered again in order. A Sarvam job of the old provider is not waited on any more (it was booked).
 * Cutting each part that is too long, instead of the remaining audio as a whole, needs no new ffmpeg step and keeps
 * every boundary that is already done.
 */
export async function replanForProvider(ctx: PartContext, signal: AbortSignal | undefined): Promise<void> {
  const { id, parts, t, deps } = ctx;
  const used = parts.map((p) => Number(/-parts-(\d+)\//.exec(p.file ?? '')?.[1] ?? 0));
  let n = Math.max(0, ...used) + 1;
  const out: SttPartRow[] = [];
  for (const p of parts) {
    if (p.state === 'done') {
      out.push(p);
      continue;
    }
    const fresh: SttPartRow = { ...p, provider: t.provider, state: 'todo', booked: 'none', jobId: null, segments: null, billedSeconds: null };
    if (p.seconds <= t.maxPartSeconds) {
      out.push(fresh);
      continue;
    }
    const folder = `${id}-parts-${n++}`;
    const cut = await deps.ffmpeg.split({ path: ctx.pathOf(p), seconds: p.seconds, offset: p.offset }, join(meetingsTmpDir(deps.dataDir), folder), t.maxPartSeconds, signal);
    for (const c of cut) out.push({ ...fresh, offset: c.offset, seconds: c.seconds, file: `${folder}/${basename(c.path)}` });
  }
  parts.splice(0, parts.length, ...out.map((p, i) => ({ ...p, index: i + 1 })));
  ctx.save();
  deps.log.info({ meetingId: id, provider: t.provider, parts: parts.length }, 'meeting speech parts planned again for a new provider');
}

/**
 * The files of the parts still to do must be there. Parts of the first split are cut again (Ffmpeg.split makes a folder
 * that lost its .done again, and the count must match); a part file that cannot be made again is part_missing.
 */
export async function ensurePartFiles(ctx: PartContext, signal: AbortSignal | undefined): Promise<void> {
  const { id, parts, t, whole, deps } = ctx;
  if (!parts.some((p) => p.state !== 'done' && p.file !== null && !existsSync(ctx.pathOf(p)))) return;
  const firstSplit = parts.length > 1 && parts.every((p) => p.provider === t.provider && p.file !== null && p.file.startsWith(`${id}-parts/`));
  if (!firstSplit) throw new AudioError('part_missing');
  const cut = await deps.ffmpeg.split(whole, join(meetingsTmpDir(deps.dataDir), `${id}-parts`), t.maxPartSeconds, signal);
  if (cut.length !== parts.length) throw new AudioError('split_changed');
}

/**
 * Before a new send: the part's file must be there. A local failure here is thrown as it is (retryable): nothing was
 * sent, so nothing is booked.
 */
function checkPartFile(path: string): void {
  if (!statSync(path).isFile()) throw new AudioError('part_missing');
}

/** The call's own error, for a booking that could not be written after it (see SttBookingError). */
const callErrorOf = (e: unknown): unknown => (e instanceof SttBookingError ? e.cause : e);

/**
 * ElevenLabs and OpenAI: one synchronous call, held and settled by withSttHold, which writes the booking and the part's
 * outcome in one transaction. If that write fails, the part stays inflight with nothing booked, and bookStuckParts books
 * it at the ceiling before it is sent again.
 */
export async function heldPart(ctx: PartContext, i: number): Promise<void> {
  const { id, parts, t, deps, put } = ctx;
  const before = parts[i]!;
  const audio: AudioPart = { path: ctx.pathOf(before), seconds: before.seconds, offset: before.offset };
  const label = `meeting ${id} part ${before.index}`;
  const ceiling = t.partCeilingUsd(before.seconds);
  checkPartFile(audio.path);
  // A part sent again is a new call: what was booked before belongs to the earlier call.
  put(i, { state: 'inflight', booked: 'none', jobId: null });
  let sent = false;
  let bookedAtShutdown = false;
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
          // An answer after shutdown booked the hold stays booked at the ceiling: that is what was recorded.
          if (r !== undefined) ctx.markDone(i, r, bookedAtShutdown ? 'ceiling' : 'actual');
          else if (b.outcome === 'none') put(i, { state: 'todo', booked: 'none' });
          else put(i, { state: 'unknown', booked: 'ceiling' });
        },
        onBookedAtShutdown: () => {
          bookedAtShutdown = true; // booked even when the write below fails (settlePending then books the hold alone)
          put(i, { state: 'unknown', booked: 'ceiling' });
        },
      },
    ));
  } catch (e) {
    // Never sent (no room under the cap): as it was. Anything else is already written with its booking, or left
    // inflight with nothing booked for bookStuckParts.
    if (e instanceof SpendCapReachedError && !sent) put(i, before);
    const fields = { meetingId: id, part: before.index, provider: t.provider, code: errorCode(callErrorOf(e)), state: parts[i]!.state };
    deps.log.warn(e instanceof SttBookingError ? { ...fields, writeCode: errorCode(e.writeError) } : fields, 'meeting speech part failed');
    throw e;
  }
  deps.log.info({ meetingId: id, part: before.index, provider: t.provider, seconds: Math.round(before.seconds), costUsd: cost }, 'meeting speech part transcribed');
}

/**
 * Sarvam: a batch job. A stored job id is waited on again, booking nothing more. A new job holds the ceiling while it is
 * sent; when Sarvam accepts it, the hold is settled at the ceiling and the job id stored in one transaction.
 */
export async function sarvamPart(ctx: PartContext, i: number): Promise<void> {
  const { id, parts, t, deps, put, atomically } = ctx;
  const { spend, log } = deps;
  const before = parts[i]!;
  const audio: AudioPart = { path: ctx.pathOf(before), seconds: before.seconds, offset: before.offset };
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
    try {
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
    } catch (writeErr) {
      // Left inflight with nothing booked (or booked, with its job id), for bookStuckParts or the resume.
      log.warn({ meetingId: id, part: before.index, provider: t.provider, code: errorCode(e), writeCode: errorCode(writeErr) }, 'meeting speech part failed');
      throw new SttBookingError(writeErr, e);
    }
    log.warn({ meetingId: id, part: before.index, provider: t.provider, code: errorCode(e) }, 'meeting speech part failed');
    throw e;
  }
}
