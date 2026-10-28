import type { SpendGuard } from '../spend/spendGuard.ts';
import type { Db } from '../store/db.ts';
import { dueMeetingIds, releaseSttNoneWaits } from '../store/meetings.ts';
import type { Clock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';
import { cleanupTemp } from './audio.ts';
import type { MeetingProcessResult } from './processor.ts';
import { forgetPending, recoverInflightParts, type MeetingTranscriber } from './transcribe.ts';

/** A meeting whose run crashed (the database failed) is not started again for this long in this service run. */
const CRASH_WAIT_MS = 15 * 60_000;

export interface MeetingQueueOptions {
  db: Db;
  clock: Clock;
  log: Logger;
  spend: SpendGuard;
  dataDir: string;
  /** For forgetPending at start (null: STT_PROVIDER none; copies noted earlier are left and logged). */
  transcriber: MeetingTranscriber | null;
  /** INR_PER_USD, for booking speech parts left in flight at start. */
  inrPerUsd: number;
  processor: { process(id: number, signal: AbortSignal): Promise<MeetingProcessResult> };
  /** A meeting's run ended (done, waiting, failed, stopped or skipped). */
  onSettled?: (r: MeetingProcessResult) => void;
}

/**
 * Works through due queued meetings one at a time (meetings are rare and large). The database is the queue.
 * - start(): before any meeting runs, speech parts a crash left in flight are booked (recoverInflightParts), meetings
 *   that waited for a transcriber (stt_none) are made due when there is one now (releaseSttNoneWaits), the providers'
 *   copies still to delete are deleted (forgetPending), and leftover work files removed (cleanupTemp).
 * - kick(): from the tick; starts the next due meeting when none is running.
 * - stop(): no new meeting starts, and the running one's signal is aborted: only a download or ffmpeg run stops; speech
 *   and Claude calls never take the signal.
 * - drain(ms): waits for the start-up work and the running meeting (its tracker step included), up to ms.
 */
export class MeetingQueue {
  readonly #o: MeetingQueueOptions;
  readonly #abort = new AbortController();
  #ready = false;
  #startup: Promise<void> | undefined;
  #running: Promise<void> | undefined;
  #runningId: number | undefined;
  /** Meetings started since the last kick(): a run that leaves its meeting due (a bug) is tried once per kick, never in a loop. */
  readonly #startedSinceKick = new Set<number>();
  /** Meetings whose run crashed, held back until this time (ms). In memory only. */
  readonly #crashed = new Map<number, number>();
  #stopped = false;

  constructor(o: MeetingQueueOptions) {
    this.#o = o;
  }

  /** Whether a meeting is being processed. */
  get active(): boolean {
    return this.#running !== undefined;
  }

  /** The start-up work, then the first due meeting. Calling it again does nothing. */
  start(): void {
    if (this.#startup) return;
    this.#startup = this.#prepare().then(
      () => {
        this.#ready = true;
        this.#fill();
      },
      (err: unknown) => this.#o.log.error({ err }, 'meeting queue start-up failed; meetings wait until the next start'),
    );
  }

  async #prepare(): Promise<void> {
    const { db, spend, inrPerUsd, log, clock, dataDir, transcriber } = this.#o;
    // Before any speech call: a part that may have been billed is booked once, at its ceiling.
    recoverInflightParts(db, spend, inrPerUsd, log, clock);
    // Started with a transcriber (for example after switching to STT_PROVIDER=local): meetings that waited for one
    // (stt_none) are due now, not at the end of their hour.
    if (transcriber !== null) {
      try {
        const count = releaseSttNoneWaits(db, clock.now().toISOString());
        if (count > 0) log.info({ count, provider: transcriber.provider }, 'meetings waiting for speech-to-text are due now');
      } catch (err) {
        log.warn({ err }, 'meetings waiting for speech-to-text could not be made due; they wait out their hour');
      }
    }
    try {
      cleanupTemp(db, dataDir, log);
    } catch (err) {
      log.warn({ err }, 'meeting work files could not be cleaned');
    }
    try {
      await forgetPending(db, transcriber, log, { clock });
    } catch (err) {
      log.warn({ err }, 'meeting speech copies could not be deleted at the provider');
    }
  }

  /** Starts the next due meeting if none is running. Never throws. */
  kick(): void {
    this.#startedSinceKick.clear();
    // The running meeting counts as started since this kick: if its run leaves it due, the next kick tries it again.
    if (this.#runningId !== undefined) this.#startedSinceKick.add(this.#runningId);
    this.#fill();
  }

  #fill(): void {
    if (this.#stopped || !this.#ready || this.#running) return;
    const now = this.#o.clock.now();
    for (const [id, until] of this.#crashed) if (until <= now.getTime()) this.#crashed.delete(id);
    const held = new Set(this.#crashed.keys());
    let ids: number[];
    try {
      ids = dueMeetingIds(this.#o.db, now.toISOString(), 1 + this.#startedSinceKick.size + held.size);
    } catch (err) {
      this.#o.log.error({ err }, 'meeting queue read failed');
      return;
    }
    const id = ids.find((i) => !this.#startedSinceKick.has(i) && !held.has(i));
    if (id !== undefined) this.#start(id);
  }

  #start(id: number): void {
    this.#startedSinceKick.add(id);
    this.#runningId = id;
    let crashed = false;
    this.#running = Promise.resolve()
      .then(() => this.#o.processor.process(id, this.#abort.signal))
      .then((r) => {
        this.#crashed.delete(id);
        try {
          this.#o.onSettled?.(r);
        } catch (err) {
          this.#o.log.error({ meetingId: id, err }, 'meeting onSettled failed');
        }
      })
      .catch((err: unknown) => {
        // Only a broken database gets here (the processor turns every stage problem into a status or a wait).
        crashed = true;
        this.#crashed.set(id, this.#o.clock.now().getTime() + CRASH_WAIT_MS);
        this.#o.log.error({ meetingId: id, err }, 'meeting processing crashed');
      })
      .finally(() => {
        this.#running = undefined;
        this.#runningId = undefined;
        if (!crashed) this.#fill();
      });
  }

  /** No new meeting starts; the running meeting's download or ffmpeg step is aborted. */
  stop(): void {
    this.#stopped = true;
    this.#abort.abort();
  }

  /** Resolves when the start-up work and the running meeting have ended, or after timeoutMs. Leaves no timer. */
  async drain(timeoutMs: number): Promise<void> {
    const work = async () => {
      await this.#startup;
      while (this.#running) await this.#running;
    };
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([work(), new Promise<void>((r) => (timer = setTimeout(r, timeoutMs)))]);
    } finally {
      clearTimeout(timer);
    }
  }
}
