import type { Db } from '../store/db.ts';
import type { Clock } from '../util/clock.ts';
import { istDate } from '../util/time.ts';

/** Daily cap on AI and transcription spend. The day resets at midnight IST. */
export class SpendGuard {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #cap: number;
  readonly #pending = new Map<number, number>();
  #nextId = 1;

  constructor(opts: { db: Db; clock: Clock; capUsd: number }) {
    this.#db = opts.db;
    this.#clock = opts.clock;
    this.#cap = opts.capUsd;
  }

  get capUsd(): number {
    return this.#cap;
  }

  spentToday(): number {
    const r = this.#db.prepare('SELECT COALESCE(SUM(usd), 0) AS total FROM spend WHERE day = ?').get(istDate(this.#clock.now())) as { total: number };
    return r.total;
  }

  #pendingTotal(): number {
    let t = 0;
    for (const v of this.#pending.values()) t += v;
    return t;
  }

  canSpend(estimateUsd: number): boolean {
    if (this.isPaused()) return false;
    if (!Number.isFinite(estimateUsd) || estimateUsd < 0) return false;
    return this.spentToday() + this.#pendingTotal() + estimateUsd <= this.#cap;
  }

  isPaused(): boolean {
    return this.spentToday() >= this.#cap;
  }

  /** Holds an estimate while a paid call is in flight. Returns a reservation id, or null if it would pass the cap. */
  reserve(estimateUsd: number): number | null {
    if (!this.canSpend(estimateUsd)) return null;
    const id = this.#nextId++;
    this.#pending.set(id, estimateUsd);
    return id;
  }

  /** Records the actual cost and frees the reservation (the reservation is freed even if recording throws). */
  settle(id: number, kind: 'ai' | 'stt', usd: number, detail: string): void {
    try {
      this.record(kind, usd, detail);
    } finally {
      this.#pending.delete(id);
    }
  }

  /** Frees a reservation without recording anything (the call was never billed). */
  release(id: number): void {
    this.#pending.delete(id);
  }

  /**
   * A bad amount (NaN, Infinity, negative) is recorded as the cap, which pauses spending for the rest of the IST day.
   * `detail`: IDs and counts only, never message text.
   */
  record(kind: 'ai' | 'stt', usd: number, detail: string): void {
    const bad = !Number.isFinite(usd) || usd < 0;
    const amount = bad ? this.#cap : usd;
    const note = bad ? `${detail} (invalid amount, recorded as the cap)` : detail;
    const now = this.#clock.now();
    this.#db.prepare('INSERT INTO spend (day, kind, usd, detail, at) VALUES (?, ?, ?, ?, ?)').run(istDate(now), kind, amount, note, now.toISOString());
  }
}
