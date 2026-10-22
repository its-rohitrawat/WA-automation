import type { Db } from '../store/db.ts';
import { dueMediaIds } from '../store/media.ts';
import type { Clock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';
import type { ProcessOutcome, ProcessResult } from './processor.ts';

/** Outcomes after which the file's message can be reconciled. */
const SETTLED = new Set<ProcessOutcome>(['done', 'failed', 'unavailable']);

export interface MediaQueueOptions {
  db: Db;
  clock: Clock;
  log: Logger;
  processor: { process(mediaId: number): Promise<ProcessResult> };
  /** Files downloaded and read at once. */
  concurrency: number;
  /** A file reached a final state: the reconciler that waited for it can run. */
  onSettled: (clientId: number) => void;
}

/** Works through due pending files from the database, at most `concurrency` at a time. The database is the queue. */
export class MediaQueue {
  readonly #o: MediaQueueOptions;
  readonly #inFlight = new Set<number>();
  /**
   * Files started since the last kick(). When a file finishes the queue refills itself, but never with one of these, so
   * a file that a run leaves pending and due (a crash, or a processor bug) is tried once per kick (every tick and every
   * stored file), never in a loop (amendment 11a). Every real deferral waits at least a minute, longer than a tick.
   */
  readonly #startedSinceKick = new Set<number>();
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
    let ids: number[];
    try {
      // Enough rows to fill every free slot even if the first ones are in flight or were started since the kick.
      const limit = this.#o.concurrency + this.#startedSinceKick.size;
      ids = dueMediaIds(this.#o.db, this.#o.clock.now().toISOString(), limit);
    } catch (err) {
      this.#o.log.error({ err }, 'media queue read failed');
      return;
    }
    const startable = ids.filter((i) => !this.#inFlight.has(i) && !this.#startedSinceKick.has(i));
    for (const id of startable.slice(0, free)) this.#start(id);
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

  #start(id: number): void {
    this.#inFlight.add(id);
    this.#startedSinceKick.add(id);
    let crashed = false;
    Promise.resolve()
      .then(() => this.#o.processor.process(id))
      .then((r) => {
        if (r.clientId === null || !SETTLED.has(r.outcome)) return;
        try {
          this.#o.onSettled(r.clientId);
        } catch (err) {
          this.#o.log.error({ clientId: r.clientId, err }, 'media onSettled failed');
        }
      })
      .catch((err: unknown) => {
        // Only a broken database gets here (the processor turns file problems into statuses). The next tick retries.
        crashed = true;
        this.#o.log.error({ mediaId: id, err }, 'media processing crashed');
      })
      .finally(() => {
        this.#inFlight.delete(id);
        if (!crashed) this.#fill();
        if (this.#inFlight.size === 0) for (const w of [...this.#drainWaiters]) w();
      });
  }
}
