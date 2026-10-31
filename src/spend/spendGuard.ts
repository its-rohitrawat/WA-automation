import type { Db, Sql } from '../store/db.ts';
import type { GlobalSpend } from './globalSpend.ts';
import type { Clock } from '../util/clock.ts';
import { istDate } from '../util/time.ts';

/**
 * A reservation older than this no longer counts (600 s timeout x 3 SDK attempts, plus margin).
 * Safety net only: every caller settles or releases its reservations.
 */
const RESERVATION_TTL_MS = 45 * 60_000;

/** Called by settlePending inside the transaction that books a hold at shutdown, with its handle. */
export type BookedAtShutdown = (q: Sql) => unknown;

/** A live reservation: its estimate, when it was taken, what kind of spend it books as, and who to tell if shutdown books it. */
interface Hold {
  usd: number;
  at: number;
  kind: SpendKind;
  onBookedAtShutdown: BookedAtShutdown | undefined;
}

export type SpendKind = 'ai' | 'stt';

/** Today's totals by kind, for one IST day. */
interface Today {
  day: string;
  ai: number;
  stt: number;
}

const INSERT = 'INSERT INTO spend (day, kind, usd, detail, at) VALUES (?, ?, ?, ?, ?)';
const SUMS = 'SELECT kind, COALESCE(SUM(usd), 0) AS total FROM spend WHERE day = ? GROUP BY kind';

export interface SpendGuardOptions {
  db: Db;
  clock: Clock;
  /**
   * The daily cap: a fixed number (the founder's DAILY_SPEND_CAP_USD), or read at every check (a customer's own limit
   * from its settings, so a lowered limit applies to the next call, without a restart).
   */
  capUsd: number | (() => number);
  onError?: (err: unknown) => void;
  /**
   * This guard's place under the platform-wide ceiling (S4.3), for spend billed to the founder only (the founder's
   * runtime). With it, every check (canSpend, reserve, isPaused, fitsIgnoringHolds) must also pass the ceiling; without
   * it (a customer on their own key, the founder until S4.4, and tests), only the own cap counts. SpendGuard.open joins
   * after loading today's totals, so a restarted runtime is never counted at zero.
   */
  platform?: { global: GlobalSpend; tenantId: string };
}

function totals(day: string, rows: { kind: string; total: number }[]): Today {
  const t: Today = { day, ai: 0, stt: 0 };
  for (const r of rows) if (r.kind === 'ai' || r.kind === 'stt') t[r.kind] = r.total;
  return t;
}

/**
 * Daily cap on AI and transcription spend. The day resets at midnight IST.
 *
 * Today's totals are kept in memory, so every check (isPaused, canSpend, reserve) stays synchronous. They are loaded
 * by SpendGuard.open, added to by every record, and read again by refresh() (the app tick, at most every 30 s), which
 * picks up spend another process booked (the CLI). A booking whose transaction rolls back, or whose write fails, stays
 * counted until the next refresh: an over-count, the safe side under a cap.
 */
export class SpendGuard {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #capOf: () => number;
  readonly #pending = new Map<number, Hold>();
  /** Reservations already booked at their estimate by settlePending(); a late settle() must not book them again. */
  readonly #bookedAtEstimate = new Set<number>();
  #nextId = 1;
  /** Set by settlePending() at shutdown: no new reservation after that, so a late retry pauses instead of starting a paid call. */
  #closed = false;
  #today: Today;
  /** Bumped by every record: a refresh that overlapped one keeps the larger total, never the smaller. */
  #recorded = 0;
  /** #recorded when the previous refresh began: a booking since then may not be in a read yet (see refresh). */
  #recordedAtLastRefresh = 0;
  /** Rows booked without a transaction handle that are still being written (see record, flushed). */
  readonly #writes = new Set<Promise<void>>();
  readonly #onError: (err: unknown) => void;
  #global: GlobalSpend | undefined;

  /**
   * Starts at zero for today: `SpendGuard.open` makes one and loads today's totals. onError: told when a row booked
   * without a transaction handle could not be written (unset: tests; the console then).
   */
  constructor(opts: SpendGuardOptions) {
    this.#db = opts.db;
    this.#clock = opts.clock;
    const cap = opts.capUsd;
    this.#capOf = typeof cap === 'function' ? cap : () => cap;
    this.#today = { day: istDate(this.#clock.now()), ai: 0, stt: 0 };
    this.#onError = opts.onError ?? ((err) => console.error('spend row not written', err));
    if (opts.platform) this.#join(opts.platform);
  }

  static async open(opts: SpendGuardOptions): Promise<SpendGuard> {
    const { platform, ...own } = opts;
    const guard = new SpendGuard(own);
    await guard.refresh();
    if (platform) guard.#join(platform);
    return guard;
  }

  #join(p: { global: GlobalSpend; tenantId: string }): void {
    this.#global = p.global;
    p.global.join(p.tenantId, this);
  }

  /**
   * Reads today's totals again (another process may have booked spend), and never counts less than this guard has
   * booked (real bug 9, on Postgres). Rows booked without a handle are written first (flushed). A booking since the
   * previous refresh began may still not be in the read: its row is in a transaction not yet committed, or, on the
   * pool, being written on another connection. So then the larger total is kept. A booking that was rolled back or
   * failed stays counted until a refresh with no booking since the one before: an over-count, the safe side.
   */
  async refresh(): Promise<void> {
    await this.flushed();
    const day = istDate(this.#clock.now());
    const since = this.#recordedAtLastRefresh;
    this.#recordedAtLastRefresh = this.#recorded;
    const read = totals(day, await this.#db.all<{ kind: string; total: number }>(SUMS, [day]));
    const now = this.#now();
    if (now.day !== day) return; // the IST day changed during the read: today starts at zero
    if (this.#recorded !== since) {
      read.ai = Math.max(read.ai, now.ai);
      read.stt = Math.max(read.stt, now.stt);
    }
    this.#today = read;
  }

  /** Today's totals; a new IST day starts at zero. */
  #now(): Today {
    const day = istDate(this.#clock.now());
    if (this.#today.day !== day) this.#today = { day, ai: 0, stt: 0 };
    return this.#today;
  }

  get capUsd(): number {
    return this.#cap;
  }

  /** The cap now. One that cannot be read as an amount is 0 (fail closed: spending pauses, never runs without a cap). */
  get #cap(): number {
    const cap = this.#capOf();
    return Number.isFinite(cap) && cap >= 0 ? cap : 0;
  }

  spentToday(): number {
    const t = this.#now();
    return t.ai + t.stt;
  }

  /** Today's spend by kind (IST day): AI calls and speech-to-text. */
  spentTodayByKind(): Record<SpendKind, number> {
    const t = this.#now();
    return { ai: t.ai, stt: t.stt };
  }

  /** Today's live reservations, at their estimates (expired ones forgotten). Read by the platform ceiling. */
  heldUsd(): number {
    return this.#pendingTotal();
  }

  /** Why spending is paused: this customer's own cap, the platform ceiling, or null when it is not. */
  pauseReason(): 'cap' | 'platform' | null {
    if (this.spentToday() >= this.#cap) return 'cap';
    if (this.#global?.isPaused()) return 'platform';
    return null;
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
    return this.spentToday() + this.#pendingTotal() + estimateUsd <= this.#cap && (this.#global?.fits(estimateUsd) ?? true);
  }

  /** This customer's cap reached, or the platform ceiling (see pauseReason). */
  isPaused(): boolean {
    return this.pauseReason() !== null;
  }

  /**
   * Whether the estimate would fit under the cap if no paid call were in flight. When canSpend() is false but this is
   * true, the cap is not the reason: holds of calls still running are (a scanned PDF holds about $4 while it is read),
   * and they clear when those calls end.
   */
  fitsIgnoringHolds(estimateUsd: number): boolean {
    if (this.isPaused()) return false;
    if (!Number.isFinite(estimateUsd) || estimateUsd < 0) return false;
    return this.spentToday() + estimateUsd <= this.#cap && (this.#global?.fitsIgnoringHolds(estimateUsd) ?? true);
  }

  /**
   * Holds an estimate while a paid call is in flight. Returns a reservation id, or null if it would pass the cap.
   * `kind`: what settlePending books the hold as if the call is still running at shutdown.
   * `onBookedAtShutdown`: called by settlePending inside the transaction that books this hold, so the owner can note
   * durably that the call is paid for (a meeting's speech part is marked booked, and is not booked again after the
   * restart). If it throws, its writes and the booking roll back, the hold is booked alone, and the other holds are
   * still booked.
   */
  reserve(estimateUsd: number, kind: SpendKind = 'ai', onBookedAtShutdown?: BookedAtShutdown): number | null {
    if (this.#closed || !this.canSpend(estimateUsd)) return null;
    const id = this.#nextId++;
    this.#pending.set(id, { usd: estimateUsd, at: this.#clock.now().getTime(), kind, onBookedAtShutdown });
    return id;
  }

  /**
   * Records the actual cost and frees the reservation (the reservation is freed even if recording fails). With `q`, the
   * row is written through that transaction handle; without it, behind the call (see `record`).
   */
  settle(id: number, kind: SpendKind, usd: number, detail: string): void;
  settle(id: number, kind: SpendKind, usd: number, detail: string, q: Sql): Promise<void>;
  settle(id: number, kind: SpendKind, usd: number, detail: string, q?: Sql): void | Promise<void> {
    if (this.#bookedAtEstimate.delete(id)) return q ? Promise.resolve() : undefined;
    if (q) return this.record(kind, usd, detail, q).finally(() => this.#pending.delete(id));
    try {
      this.record(kind, usd, detail);
    } finally {
      this.#pending.delete(id);
    }
  }

  /** Resolves once every row booked without a transaction handle has been written (or its failure told to onError). */
  async flushed(): Promise<void> {
    await Promise.all([...this.#writes]);
  }

  /** Frees a reservation without recording anything (the call was never billed). */
  release(id: number): void {
    this.#bookedAtEstimate.delete(id);
    this.#pending.delete(id);
  }

  /**
   * At shutdown: books each live reservation (a call still in flight) at its estimate, with `detail`, under the hold's
   * own kind ('ai' or 'stt'), frees it and tells its owner. Returns how many were booked.
   */
  async settlePending(detail: string): Promise<number> {
    this.#closed = true;
    this.#pendingTotal(); // forgets expired reservations: they no longer count
    let n = 0;
    for (const [id, r] of [...this.#pending]) {
      this.#pending.delete(id);
      const owner = r.onBookedAtShutdown;
      if (owner) {
        try {
          // The booking and the owner's own record of it (a meeting's speech part) are written together.
          await this.#db.tx(async (q) => {
            await this.record(r.kind, r.usd, detail, q);
            await owner(q);
          });
        } catch {
          // The owner's write failed and took the booking with it: book alone. The owner's record still says nothing is
          // booked, so its recovery books the call once more (the safe side).
          this.record(r.kind, r.usd, detail);
        }
      } else {
        this.record(r.kind, r.usd, detail);
      }
      this.#bookedAtEstimate.add(id);
      n++;
    }
    return n;
  }

  /**
   * A bad amount (NaN, Infinity, negative) is recorded as the cap, which pauses spending for the rest of the IST day.
   * `detail`: IDs and counts only, never message text.
   *
   * With `q`, the row is written through that transaction handle (it commits or rolls back with the caller's change).
   * Without it (a booking outside any transaction), it is counted at once and its row goes to the database queue at once,
   * so a later refresh() reads it; a failed write is told to onError and stays counted. Never call it without `q`
   * inside a transaction: the engine refuses the write there (TxMisuseError), and it is lost (told to onError).
   */
  record(kind: SpendKind, usd: number, detail: string): void;
  record(kind: SpendKind, usd: number, detail: string, q: Sql): Promise<void>;
  record(kind: SpendKind, usd: number, detail: string, q?: Sql): void | Promise<void> {
    const bad = !Number.isFinite(usd) || usd < 0;
    const amount = bad ? this.#cap : usd;
    const note = bad ? `${detail} (invalid amount, recorded as the cap)` : detail;
    const now = this.#clock.now();
    const row = [istDate(now), kind, amount, note, now.toISOString()];
    const count = () => {
      this.#now()[kind] += amount;
      this.#recorded++;
    };
    if (q) {
      // Counted first: a check made while the write is in flight already sees it.
      count();
      return q.run(INSERT, row).then(() => undefined);
    }
    count();
    let w: Promise<void>;
    try {
      w = this.#db.run(INSERT, row).then(() => undefined, (err: unknown) => this.#onError(err));
    } catch (err) {
      this.#onError(err); // refused at once (inside a transaction): a bug, logged
      return;
    }
    this.#writes.add(w);
    void w.finally(() => this.#writes.delete(w));
  }
}
