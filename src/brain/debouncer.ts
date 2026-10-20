import type { ReconcileOutcome } from './reconciler.ts';

type Timer = ReturnType<typeof setTimeout>;

interface ClientState {
  quiet?: Timer;
  max?: Timer;
  retry?: Timer;
  queued: boolean;
  running: boolean;
  dirty: boolean;
}

export interface DebouncerOptions {
  quietMs: number;
  maxWaitMs: number;
  maxConcurrent: number;
  retryMs?: number;
  run: (clientId: number) => Promise<ReconcileOutcome>;
  onError?: (clientId: number, err: unknown) => void;
}

/** Waits for a group to go quiet (or for the max wait) before reconciling, so a burst becomes one AI call. */
export class GroupDebouncer {
  readonly #quietMs: number;
  readonly #maxWaitMs: number;
  readonly #maxConcurrent: number;
  readonly #retryMs: number;
  readonly #run: DebouncerOptions['run'];
  readonly #onError: DebouncerOptions['onError'];
  readonly #states = new Map<number, ClientState>();
  readonly #queue: number[] = [];
  #active = 0;
  #stopped = false;

  constructor(o: DebouncerOptions) {
    this.#quietMs = o.quietMs;
    this.#maxWaitMs = o.maxWaitMs;
    this.#maxConcurrent = o.maxConcurrent;
    this.#retryMs = o.retryMs ?? 3_600_000;
    this.#run = o.run;
    this.#onError = o.onError;
  }

  /** A new message arrived for this client. */
  notify(clientId: number): void {
    if (this.#stopped) return;
    const s = this.#state(clientId);
    if (s.running) {
      s.dirty = true;
      return;
    }
    if (s.queued) return;
    clearTimeout(s.quiet);
    s.quiet = setTimeout(() => this.#fire(clientId), this.#quietMs);
    s.max ??= setTimeout(() => this.#fire(clientId), this.#maxWaitMs);
  }

  /** Make sure pending work is scheduled, without delaying a timer that is already counting down. */
  ensure(clientId: number): void {
    const s = this.#states.get(clientId);
    if (s && (s.quiet || s.queued || s.running || s.retry)) return;
    this.notify(clientId);
  }

  stop(): void {
    this.#stopped = true;
    for (const s of this.#states.values()) {
      clearTimeout(s.quiet);
      clearTimeout(s.max);
      clearTimeout(s.retry);
    }
  }

  #state(clientId: number): ClientState {
    let s = this.#states.get(clientId);
    if (!s) {
      s = { queued: false, running: false, dirty: false };
      this.#states.set(clientId, s);
    }
    return s;
  }

  #fire(clientId: number): void {
    const s = this.#state(clientId);
    clearTimeout(s.quiet);
    clearTimeout(s.max);
    clearTimeout(s.retry);
    s.quiet = s.max = s.retry = undefined;
    if (s.running) {
      s.dirty = true;
      return;
    }
    if (s.queued) return;
    s.queued = true;
    this.#queue.push(clientId);
    this.#pump();
  }

  #pump(): void {
    while (!this.#stopped && this.#active < this.#maxConcurrent && this.#queue.length > 0) {
      const clientId = this.#queue.shift()!;
      const s = this.#state(clientId);
      s.queued = false;
      s.running = true;
      this.#active++;
      this.#run(clientId)
        .then((outcome) => {
          if (outcome.status === 'failed' || outcome.status === 'paused') this.#scheduleRetry(clientId);
        })
        .catch((err: unknown) => {
          this.#onError?.(clientId, err);
          this.#scheduleRetry(clientId);
        })
        .finally(() => {
          this.#active--;
          s.running = false;
          if (s.dirty) {
            s.dirty = false;
            this.notify(clientId);
          }
          this.#pump();
        });
    }
  }

  #scheduleRetry(clientId: number): void {
    if (this.#stopped) return;
    const s = this.#state(clientId);
    clearTimeout(s.retry);
    s.retry = setTimeout(() => this.#fire(clientId), this.#retryMs);
  }
}
