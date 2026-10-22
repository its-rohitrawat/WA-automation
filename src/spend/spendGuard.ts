import type { Db } from '../store/db.ts';
import type { Clock } from '../util/clock.ts';
import { istDate } from '../util/time.ts';

/**
 * A reservation older than this no longer counts (600 s timeout x 3 SDK attempts, plus margin).
 * Safety net only: every caller settles or releases its reservations.
 */
const RESERVATION_TTL_MS = 45 * 60_000;

/** Daily cap on AI and transcription spend. The day resets at midnight IST. */
export class SpendGuard {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #cap: number;
  readonly #pending = new Map<number, { usd: number; at: number }>();
  /** Reservations already booked at their estimate by settlePending(); a late settle() must not book them again. */
  readonly #bookedAtEstimate = new Set<number>();
  #nextId = 1;
  /** Set by settlePending() at shutdown: no new reservation after that, so a late retry pauses instead of starting a paid call. */
  #closed = false;

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

  /** Sums live reservations and forgets expired ones. */
  #pendingTotal(): number {
    const now = this.#clock.now().getTime();
    let t = 0;
    for (const [id, r] of this.#pending) {
      if (now - r.at > RESERVATION_TTL_MS) this.#pending.delete(id);
      else t += r.usd;
    }
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

  /**
   * Whether the estimate would fit under the cap if no paid call were in flight. When canSpend() is false but this is
   * true, the cap is not the reason: holds of calls still running are (a scanned PDF holds about $4 while it is read),
   * and they clear when those calls end.
   */
  fitsIgnoringHolds(estimateUsd: number): boolean {
    if (this.isPaused()) return false;
    if (!Number.isFinite(estimateUsd) || estimateUsd < 0) return false;
    return this.spentToday() + estimateUsd <= this.#cap;
  }

  /** Holds an estimate while a paid call is in flight. Returns a reservation id, or null if it would pass the cap. */
  reserve(estimateUsd: number): number | null {
    if (this.#closed || !this.canSpend(estimateUsd)) return null;
    const id = this.#nextId++;
    this.#pending.set(id, { usd: estimateUsd, at: this.#clock.now().getTime() });
    return id;
  }

  /** Records the actual cost and frees the reservation (the reservation is freed even if recording throws). */
  settle(id: number, kind: 'ai' | 'stt', usd: number, detail: string): void {
    if (this.#bookedAtEstimate.delete(id)) return;
    try {
      this.record(kind, usd, detail);
    } finally {
      this.#pending.delete(id);
    }
  }

  /** Frees a reservation without recording anything (the call was never billed). */
  release(id: number): void {
    this.#bookedAtEstimate.delete(id);
    this.#pending.delete(id);
  }

  /**
   * At shutdown: books each live reservation (a call still in flight) at its estimate, with `detail`, and frees it.
   * Reservations are AI calls today, so they are recorded as 'ai'. Returns how many were booked.
   */
  settlePending(detail: string): number {
    this.#closed = true;
    this.#pendingTotal(); // forgets expired reservations: they no longer count
    let n = 0;
    for (const [id, r] of [...this.#pending]) {
      this.#pending.delete(id);
      this.record('ai', r.usd, detail); // if this throws, the id is not marked booked, so a late settle() still records
      this.#bookedAtEstimate.add(id);
      n++;
    }
    return n;
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
