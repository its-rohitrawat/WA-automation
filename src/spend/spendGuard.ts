import type { Db } from '../store/db.ts';
import type { Clock } from '../util/clock.ts';
import { istDate } from '../util/time.ts';

/** Daily cap on AI and transcription spend. The day resets at midnight IST. */
export class SpendGuard {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #cap: number;

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

  canSpend(estimateUsd: number): boolean {
    return this.spentToday() + estimateUsd <= this.#cap;
  }

  isPaused(): boolean {
    return this.spentToday() >= this.#cap;
  }

  record(kind: 'ai' | 'stt', usd: number, detail: string): void {
    const now = this.#clock.now();
    this.#db.prepare('INSERT INTO spend (day, kind, usd, detail, at) VALUES (?, ?, ?, ?, ?)').run(istDate(now), kind, usd, detail, now.toISOString());
  }
}
