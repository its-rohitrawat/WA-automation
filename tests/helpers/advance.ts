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
        // Bound now, tx too: a spy put on the wrapper (vi.spyOn(wrapped, 'tx')) then calls this, not itself again.
        const fn = (v as (...a: unknown[]) => unknown).bind(target);
        if (prop === 'tx') {
          const tx = fn as <T>(f: (q: Sql) => Promise<T>) => Promise<T>;
          return <T>(f: (q: Sql) => Promise<T>) => track(tx(f));
        }
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

  /**
   * A real pause of `ms`, then the timers due now fire, without moving the clock. For work that mixes real I/O (files)
   * with fake timers due at once (setImmediate): it goes on, and nothing waiting on a later timer is let off early.
   */
  async settle(ms = 50): Promise<void> {
    await new Promise((r) => realSetTimeout(r, ms));
    await vi.advanceTimersByTimeAsync(0);
    await this.quiet();
  }

  /**
   * Waits for `p` under fake time: advance(stepMs) while it is pending, up to fakeMs of fake time; then settle() (real
   * waits, the clock held) up to realCapMs of real time. Still pending after that, it waits on something that never
   * settles: the test fails loudly, naming `label` and the stage, never passes quietly. Returns (or throws) what p does.
   */
  async until<T>(p: Promise<T>, o: { fakeMs: number; stepMs: number; realCapMs: number; label: string }): Promise<T> {
    let done = false;
    p.then(() => void (done = true), () => void (done = true));
    for (let spent = 0; spent < o.fakeMs && !done; spent += o.stepMs) await this.advance(o.stepMs);
    const settleMs = 50;
    for (let waited = 0; waited < o.realCapMs && !done; waited += settleMs) await this.settle(settleMs);
    if (!done) {
      throw new Error(`${o.label} never finished: still pending after ${o.fakeMs} ms of fake time and ${o.realCapMs} ms of real waits with the due timers fired`);
    }
    return p;
  }
}

/**
 * No timer left behind. On Postgres the driver's pool keeps idle timers of its own (fake ones under fake timers), so the
 * count is the code's alone only on SQLite.
 */
export function expectNoTimers(): void {
  if (onSqlite) expect(vi.getTimerCount()).toBe(0);
}
