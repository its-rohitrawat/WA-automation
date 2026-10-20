import type { ReconcileOutcome } from './reconciler.ts';

type Timer = ReturnType<typeof setTimeout>;

interface ClientState {
  quiet?: Timer;
  max?: Timer;
  retry?: Timer;
  queued: boolean;
  running: boolean;
  dirty: boolean;
  failures: number;
  cancelled: boolean;
}

/** After this many failed runs in a row, new messages wait for the hourly retry instead of re-sending the batch. */
export const FAILURES_BEFORE_BACKOFF = 3;

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
  readonly #drainWaiters: (() => void)[] = [];

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
    s.cancelled = false;
    if (s.running) {
      s.dirty = true;
      return;
    }
    if (s.queued) return;
    if (s.failures >= FAILURES_BEFORE_BACKOFF && s.retry) return;
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

  /** The client was removed from the allow-list: drop its timers and queue slot. A run in flight finishes, with no follow-up or retry. */
  cancel(clientId: number): void {
    const s = this.#states.get(clientId);
    if (!s) return;
    clearTimeout(s.quiet);
    clearTimeout(s.max);
    clearTimeout(s.retry);
    s.quiet = s.max = s.retry = undefined;
    const i = this.#queue.indexOf(clientId);
    if (i >= 0) this.#queue.splice(i, 1);
    s.queued = false;
    s.dirty = false;
    s.failures = 0;
    if (s.running) s.cancelled = true;
  }

  /** Resolves when no run is in flight, or after timeoutMs. Call after stop(). Starts nothing. */
  drain(timeoutMs: number): Promise<void> {
    if (this.#active === 0) return Promise.resolve();
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
      s = { queued: false, running: false, dirty: false, failures: 0, cancelled: false };
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
      Promise.resolve()
        .then(() => this.#run(clientId))
        .then((outcome) => {
          if (s.cancelled) return;
          if (outcome.status === 'ok' || outcome.status === 'noop') s.failures = 0;
          if (outcome.status === 'failed') s.failures++;
          if (outcome.status === 'failed' || outcome.status === 'paused') this.#scheduleRetry(clientId);
        })
        .catch((err: unknown) => {
          if (s.cancelled) return;
          s.failures++;
          this.#scheduleRetry(clientId);
          try {
            this.#onError?.(clientId, err);
          } catch {
            /* the callback must not break scheduling */
          }
        })
        .finally(() => {
          this.#active--;
          s.running = false;
          if (s.cancelled) {
            s.cancelled = false;
            s.dirty = false;
          } else if (s.dirty) {
            s.dirty = false;
            this.notify(clientId);
          }
          this.#pump();
          if (this.#active === 0) for (const w of [...this.#drainWaiters]) w();
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
