import { getClient } from '../store/clients.ts';
import type { Db } from '../store/db.ts';
import { earlierCount, listBackfills, oldestMessage, saveBackfill, type Backfill } from '../store/historyBackfill.ts';
import type { Clock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';
import type { GatewayLike, HistoryAnswer, Scheduler } from './gateway.ts';
import type { NormalizedEvent } from './normalize.ts';

// Reads up to 7 days of a newly approved group's earlier messages (owner decision, 28 Oct 2026). syncClients queues the
// group when it is approved; this pages back from the group's oldest stored message, one group and one request at a
// time, while WhatsApp is open and the day's spend cap is not reached. Answers go through the same ingest as live
// messages (duplicates are ignored there), minus anything older than 7 days. WhatsApp may not have every old message:
// it ends at 7 days back, after two answers in a row bring nothing older, or after MAX_REQUESTS. An unapproved group is
// never asked for (here, in the gateway's allow-list and in the ingest). Logs carry client ids and counts only.

/** Messages asked for per request (WhatsApp's limit). */
export const PAGE_SIZE = 50;
/** Requests per group at most: 20 x 50 messages. */
export const MAX_REQUESTS = 20;
/** The wait between two requests. */
export const REQUEST_GAP_MS = 4_000;
/** An answer that has not come by then counts as an empty one. */
export const ANSWER_TIMEOUT_MS = 30_000;
/** Empty answers in a row that end the backfill. */
export const EMPTIES_TO_FINISH = 2;
/** Requests with no answer (the phone offline) that end it, the next one asked after TIMEOUT_GAP_MS. */
export const TIMEOUTS_TO_FINISH = 5;
export const TIMEOUT_GAP_MS = 5 * 60_000;
/** Requests that could not be sent that end it; the wait doubles from REQUEST_GAP_MS each time. */
export const FAILURES_TO_FINISH = 5;
/** A group's AI processing is held while its earlier messages are read, at most this long. */
export const HOLD_MAX_MS = 15 * 60_000;

export interface HistoryBackfillOptions {
  db: Db;
  gateway: Pick<GatewayLike, 'status'> & Required<Pick<GatewayLike, 'fetchHistory' | 'onHistory'>>;
  /** The app's ingest of a live event (the same path). May throw; a failure is counted, never the event logged. */
  ingest: (e: NormalizedEvent) => void;
  /** The day's spend cap is reached: no more requests until it resets. */
  spendPaused: () => boolean;
  clock: Clock;
  log: Logger;
  /** A group's backfill ended (done or stopped): the Activity row, and the client's held processing goes on. */
  onFinished?: (f: { clientId: number; found: number; stopped: boolean }) => void;
  scheduler?: Scheduler;
}

const defaultScheduler: Scheduler = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return { cancel: () => clearTimeout(t) };
};

export class HistoryBackfill {
  readonly #o: HistoryBackfillOptions;
  readonly #schedule: Scheduler;
  #outstanding: { groupId: string; timeout: { cancel(): void } } | undefined;
  #next: { cancel(): void } | undefined;
  #busy = false;
  #stopped = true;

  constructor(o: HistoryBackfillOptions) {
    this.#o = o;
    this.#schedule = o.scheduler ?? defaultScheduler;
    o.gateway.onHistory((a) => this.#onAnswer(a));
  }

  start(): void {
    this.#stopped = false;
    this.#soon(0);
  }

  /** Stops asking. Entries stay as they are: the next start carries on (a request in flight is asked again). */
  stop(): void {
    this.#stopped = true;
    this.#next?.cancel();
    this.#next = undefined;
    this.#outstanding?.timeout.cancel();
    this.#outstanding = undefined;
  }

  /** From the app's tick (and after the allow-list changes): moves on when it can. Never throws. */
  tick(): void {
    void this.#step();
  }

  /** The client's earlier messages are being read right now: its AI processing waits (the debouncer's hold). */
  held(clientId: number): boolean {
    if (this.#stopped || this.#o.gateway.status().state !== 'open') return false;
    try {
      const b = listBackfills(this.#o.db).find((x) => x.clientId === clientId && x.state === 'fetching');
      if (!b?.fetchingSince) return false;
      return this.#o.clock.now().getTime() - Date.parse(b.fetchingSince) < HOLD_MAX_MS;
    } catch {
      return false; // never hold on an error
    }
  }

  #soon(ms: number): void {
    if (this.#stopped) return;
    this.#next?.cancel();
    this.#next = this.#schedule(() => {
      this.#next = undefined;
      void this.#step();
    }, ms);
  }

  async #step(): Promise<void> {
    if (this.#stopped || this.#busy || this.#outstanding) return;
    this.#busy = true;
    try {
      await this.#stepOnce();
    } catch (err) {
      this.#o.log.error({ err }, 'history backfill step failed');
    } finally {
      this.#busy = false;
    }
  }

  async #stepOnce(): Promise<void> {
    const { db, gateway, clock } = this.#o;
    for (const b of listBackfills(db)) {
      if (b.state !== 'waiting' && b.state !== 'fetching') continue;
      if (!this.#stillApproved(b)) {
        this.#finish(b, true);
        continue;
      }
      if (gateway.status().state !== 'open' || this.#o.spendPaused()) return; // waits; the tick tries again
      const anchor = oldestMessage(db, b.clientId);
      if (!anchor) continue; // waiting for the group's first message
      if (anchor.ts <= b.since || b.requests >= MAX_REQUESTS || b.empties >= EMPTIES_TO_FINISH || b.timeouts >= TIMEOUTS_TO_FINISH || b.failures >= FAILURES_TO_FINISH) {
        this.#finish(b, false);
        continue;
      }
      const now = clock.now();
      const asking: Backfill = { ...b, state: 'fetching', fetchingSince: b.fetchingSince ?? now.toISOString(), requests: b.requests + 1 };
      saveBackfill(db, asking);
      const timeout = this.#schedule(() => this.#timedOut(b.groupId), ANSWER_TIMEOUT_MS);
      this.#outstanding = { groupId: b.groupId, timeout };
      const asked = await gateway.fetchHistory(b.groupId, { waId: anchor.waId, fromMe: anchor.fromMe, ts: new Date(anchor.ts) }, PAGE_SIZE);
      if (!asked && this.#outstanding?.groupId === b.groupId) {
        // Not asked (the connection dropped, or the request failed): not a request, but a failure, with a growing wait,
        // so a request that keeps failing is never sent again and again.
        this.#outstanding.timeout.cancel();
        this.#outstanding = undefined;
        saveBackfill(db, { ...asking, requests: b.requests, failures: b.failures + 1 });
        this.#soon(REQUEST_GAP_MS * 2 ** Math.min(b.failures + 1, 8));
      }
      return; // one request at a time
    }
  }

  #stillApproved(b: Backfill): boolean {
    try {
      const c = getClient(this.#o.db, b.clientId);
      return c.active && c.groupId === b.groupId;
    } catch {
      return false;
    }
  }

  #timedOut(groupId: string): void {
    if (this.#outstanding?.groupId !== groupId) return;
    this.#outstanding = undefined;
    try {
      const b = listBackfills(this.#o.db).find((x) => x.groupId === groupId);
      if (b && b.state === 'fetching') saveBackfill(this.#o.db, { ...b, timeouts: b.timeouts + 1 });
    } catch (err) {
      this.#o.log.error({ err }, 'history backfill timeout could not be recorded');
    }
    this.#soon(TIMEOUT_GAP_MS); // the phone may be offline for a while
  }

  /** An on-demand answer: each group with a backfill under way keeps what is within its 7 days. */
  #onAnswer(a: HistoryAnswer): void {
    const { db, log } = this.#o;
    const out = this.#outstanding;
    let handled = false;
    try {
      for (const g of a.groups) {
        const b = listBackfills(db).find((x) => x.groupId === g.groupId);
        if (!b || (b.state !== 'fetching' && b.state !== 'waiting') || !this.#stillApproved(b)) continue; // dropped
        handled = true;
        const before = oldestMessage(db, b.clientId)?.ts;
        let reachedSince = false;
        let failed = 0;
        for (const e of g.events) {
          if (e.ts.toISOString() < b.since) {
            reachedSince = true; // older than 7 days: dropped
            continue;
          }
          try {
            this.#o.ingest(e);
          } catch {
            failed++;
          }
        }
        if (failed) log.warn({ clientId: b.clientId, failed }, 'history backfill: some earlier messages could not be saved');
        const after = oldestMessage(db, b.clientId)?.ts;
        const older = after !== undefined && (before === undefined || after < before);
        const next: Backfill = { ...b, empties: older ? 0 : b.empties + 1 };
        saveBackfill(db, next);
        if (reachedSince) this.#finish(next, false);
      }
    } catch (err) {
      log.error({ err }, 'history backfill answer failed');
    }
    // The answer to the request in flight: this group's, or an empty one.
    if (out && (a.groups.length === 0 || a.groups.some((g) => g.groupId === out.groupId))) {
      out.timeout.cancel();
      if (this.#outstanding === out) this.#outstanding = undefined;
      if (a.groups.length === 0) {
        try {
          const b = listBackfills(db).find((x) => x.groupId === out.groupId);
          if (b && b.state === 'fetching') saveBackfill(db, { ...b, empties: b.empties + 1 });
        } catch (err) {
          log.error({ err }, 'history backfill empty answer could not be recorded');
        }
      }
      this.#soon(REQUEST_GAP_MS);
    } else if (handled && !this.#outstanding) {
      this.#soon(REQUEST_GAP_MS); // a late answer: the phone is reachable again, no need for the long wait
    }
  }

  #finish(b: Backfill, stopped: boolean): void {
    const { db, clock, log } = this.#o;
    saveBackfill(db, { ...b, state: stopped ? 'stopped' : 'done', finishedAt: clock.now().toISOString() });
    const found = stopped ? 0 : earlierCount(db, b);
    log.info({ clientId: b.clientId, found, requests: b.requests, stopped }, stopped ? 'history backfill stopped: the group is no longer approved' : 'history backfill finished');
    try {
      this.#o.onFinished?.({ clientId: b.clientId, found, stopped });
    } catch (err) {
      log.error({ err }, 'history backfill finish hook failed');
    }
  }
}
