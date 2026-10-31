import { expect, vi } from 'vitest';
import type { Db, Sql } from '../../src/store/db.ts';
import { onSqlite } from './db.ts';

// Fake time and a real database. vi.advanceTimersByTimeAsync fires timers but never waits for I/O: on Postgres a
// statement is a real round trip, so the work a timer starts (and the timers that work sets) lands after the time it was
// due. DbWork counts the statements a Db has in flight, and its advance() moves timer by timer, waiting for them after
// each. On SQLite it fires the same timers in the same order.

// Kept when this module loads, before any test fakes the timers: the waits below are on real I/O.
const realImmediate = setImmediate;
const realSetTimeout = setTimeout;

export class DbWork {
  readonly #inFlight = new Set<Promise<unknown>>();

  /** The same Db, counting its statements and transactions in flight (a transaction counts as one). */
  wrap(db: Db): Db {
    const track = <T>(p: Promise<T>): Promise<T> => {
      const done = p.finally(() => void this.#inFlight.delete(done));
      this.#inFlight.add(done);
      return done;
    };
    return new Proxy(db, {
      get(target, prop) {
        const v = Reflect.get(target, prop) as unknown;
        if (typeof v !== 'function') return v;
        const fn = (v as (...a: unknown[]) => unknown).bind(target);
        if (prop === 'tx') return <T>(f: (q: Sql) => Promise<T>) => track(target.tx(f));
        return ['run', 'get', 'all', 'exec'].includes(String(prop)) ? (...a: unknown[]) => track(fn(...a) as Promise<unknown>) : fn;
      },
    });
  }

  /**
   * Resolves once nothing is in flight: two real turns of the event loop in a row with no statement running (a
   * statement's continuation starts the next one within the same turn). Waits at most 5 s for a statement.
   */
  async quiet(): Promise<void> {
    const turn = () => new Promise<void>((r) => realImmediate(r));
    for (let i = 0; i < 200; i++) {
      await turn();
      if (this.#inFlight.size > 0) {
        await Promise.race([Promise.allSettled([...this.#inFlight]), new Promise((r) => realSetTimeout(r, 5_000))]);
        continue;
      }
      await turn();
      if (this.#inFlight.size === 0) return;
    }
  }

  /**
   * vi.advanceTimersByTimeAsync(ms) with the database work done between timers: moves timer by timer up to `ms` (a timer
   * of its own marks the end), waiting for quiet() after each. Timers must be faked.
   */
  async advance(ms: number): Promise<void> {
    const end = Date.now() + ms;
    let reached = ms <= 0;
    if (!reached) setTimeout(() => void (reached = true), ms);
    while (!reached) {
      await vi.advanceTimersToNextTimerAsync();
      await this.quiet();
    }
    await vi.advanceTimersByTimeAsync(Math.max(0, end - Date.now()));
    await this.quiet();
  }
}

/**
 * No timer left behind. On Postgres the driver's pool keeps idle timers of its own (fake ones under fake timers), so the
 * count is the code's alone only on SQLite.
 */
export function expectNoTimers(): void {
  if (onSqlite) expect(vi.getTimerCount()).toBe(0);
}
