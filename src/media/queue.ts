import type { Db } from '../store/db.ts';
import { dueMediaIds } from '../store/media.ts';
import type { Clock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';
import type { ProcessOutcome, ProcessResult } from './processor.ts';

/** Outcomes after which the file's message can be reconciled. */
const SETTLED = new Set<ProcessOutcome>(['done', 'failed', 'unavailable']);
/** A file whose run crashed is not started again for this long; the wait doubles after each crash, up to CRASH_MAX_WAIT_MS. */
const CRASH_WAIT_MS = 15 * 60_000;
const CRASH_MAX_WAIT_MS = 2 * 60 * 60_000;

export interface MediaQueueOptions {
  db: Db;
  clock: Clock;
  log: Logger;
  processor: { process(mediaId: number): Promise<ProcessResult> };
  /** Files downloaded and read at once. */
  concurrency: number;
  /** A file reached a final state: the reconciler that waited for it can run. */
  onSettled: (clientId: number) => void;
  /**
   * The voice lane (Phase 2b Task 10): at most this many voice notes and audio files in flight at once, the rest of the
   * slots for images and documents. Set to 1 for the local engine, which runs one note at a time anyway: notes waiting
   * for it would otherwise hold every slot while pictures wait. Absent: no lane, any file takes any slot.
   */
  voiceLane?: number;
}

/** Works through due pending files from the database, at most `concurrency` at a time. The database is the queue. */
export class MediaQueue {
  readonly #o: MediaQueueOptions;
  readonly #inFlight = new Set<number>();
  /** The voice notes and audio files among #inFlight, started through the voice lane. */
  readonly #voiceInFlight = new Set<number>();
  /**
   * Files started since the last kick(). When a file finishes the queue refills itself, but never with one of these, so
   * a file that a run leaves pending and due (a processor bug) is tried once per kick (every tick and every stored
   * file), never in a loop (amendment 11a); a crashed one is held back longer (#crashed). Every real deferral waits at
   * least a minute, longer than a tick.
   */
  readonly #startedSinceKick = new Set<number>();
  /**
   * Final review FR1: files whose run crashed (process() rejected, which means the database failed), held back until
   * `until`. Such a run may have paid Claude without booking it, so it must not start again on every tick. The wait
   * starts at 15 minutes and doubles after each crash, up to 2 hours. A run that ends without a crash forgets it. In
   * memory only: across restarts the processor's claim limits the runs instead.
   */
  readonly #crashed = new Map<number, { until: number; waitMs: number }>();
  readonly #drainWaiters: (() => void)[] = [];
  #stopped = false;

  constructor(o: MediaQueueOptions) {
    this.#o = o;
  }

  get active(): number {
    return this.#inFlight.size;
  }

  /**
   * Starts due files up to the limit. Called right after ingest and on every tick. Never throws: the ingestor calls it
   * after a message is committed, and a throw there would count the stored message as lost.
   */
  kick(): void {
    this.#startedSinceKick.clear();
    this.#fill();
  }

  #fill(): void {
    if (this.#stopped) return;
    const free = this.#o.concurrency - this.#inFlight.size;
    if (free <= 0) return;
    const now = this.#o.clock.now();
    const held = new Set([...this.#crashed].filter(([, c]) => c.until > now.getTime()).map(([id]) => id));
    const startable = (ids: number[]) => ids.filter((i) => !this.#inFlight.has(i) && !this.#startedSinceKick.has(i) && !held.has(i));
    // Enough rows to fill every free slot even if the first ones are in flight, were started since the kick, or are held back.
    const limit = this.#o.concurrency + this.#startedSinceKick.size + held.size;
    const lane = this.#o.voiceLane;
    try {
      if (lane === undefined) {
        for (const id of startable(dueMediaIds(this.#o.db, now.toISOString(), limit)).slice(0, free)) this.#start(id, false);
        return;
      }
      // The voice lane: voice notes and audio files first (a client's update may wait for one, V1), up to the lane's free
      // places, then the other files in the slots left. Each list is read on its own, so a long run of due voice notes
      // never hides the images behind them.
      const laneFree = Math.max(0, lane - this.#voiceInFlight.size);
      const voice = laneFree > 0 ? startable(dueMediaIds(this.#o.db, now.toISOString(), limit, { audio: true })).slice(0, Math.min(laneFree, free)) : [];
      const others = free > voice.length ? startable(dueMediaIds(this.#o.db, now.toISOString(), limit, { audio: false })).slice(0, free - voice.length) : [];
      for (const id of voice) this.#start(id, true);
      for (const id of others) this.#start(id, false);
    } catch (err) {
      this.#o.log.error({ err }, 'media queue read failed');
    }
  }

  /** No new files start. Files in flight finish. */
  stop(): void {
    this.#stopped = true;
  }

  /** Resolves when no file is in flight, or after timeoutMs. Leaves no timer. */
  drain(timeoutMs: number): Promise<void> {
    if (this.#inFlight.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        const i = this.#drainWaiters.indexOf(done);
        if (i >= 0) this.#drainWaiters.splice(i, 1);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.#drainWaiters.push(done);
    });
  }

  #start(id: number, voice: boolean): void {
    this.#inFlight.add(id);
    if (voice) this.#voiceInFlight.add(id);
    this.#startedSinceKick.add(id);
    let crashed = false;
    Promise.resolve()
      .then(() => this.#o.processor.process(id))
      .then((r) => {
        this.#crashed.delete(id);
        if (r.clientId === null || !SETTLED.has(r.outcome)) return;
        try {
          this.#o.onSettled(r.clientId);
        } catch (err) {
          this.#o.log.error({ clientId: r.clientId, err }, 'media onSettled failed');
        }
      })
      .catch((err: unknown) => {
        // Only a broken database gets here (the processor turns file problems into statuses). The next tick goes on
        // with other files; this one waits (FR1).
        crashed = true;
        const last = this.#crashed.get(id)?.waitMs;
        const waitMs = last === undefined ? CRASH_WAIT_MS : Math.min(last * 2, CRASH_MAX_WAIT_MS);
        this.#crashed.set(id, { until: this.#o.clock.now().getTime() + waitMs, waitMs });
        this.#o.log.error({ mediaId: id, waitMinutes: waitMs / 60_000, err }, 'media processing crashed');
      })
      .finally(() => {
        this.#inFlight.delete(id);
        this.#voiceInFlight.delete(id);
        if (!crashed) this.#fill();
        if (this.#inFlight.size === 0) for (const w of [...this.#drainWaiters]) w();
      });
  }
}
