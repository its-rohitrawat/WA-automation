import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GroupDebouncer } from '../../src/brain/debouncer.ts';
import type { ReconcileOutcome } from '../../src/brain/reconciler.ts';

const OK: ReconcileOutcome = { status: 'ok', accepted: 1, rejected: 0 };
const adv = (ms: number) => vi.advanceTimersByTimeAsync(ms);

function gated() {
  const gates: (() => void)[] = [];
  const run = vi.fn((_id: number) => new Promise<ReconcileOutcome>((resolve) => gates.push(() => resolve(OK))));
  return { gates, run, d: new GroupDebouncer({ quietMs: 240_000, maxWaitMs: 1_200_000, maxConcurrent: 3, retryMs: 3_600_000, run }) };
}

/** A function held open until the returned release is called. */
function heldFn<T>(value: T) {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const fn = vi.fn(async () => { await gate; return value; });
  return { fn, release: () => release() };
}

describe('GroupDebouncer.runExclusive', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs the function and returns its value when the client is idle', async () => {
    const { d } = gated();
    expect(await d.runExclusive(1, async () => 42)).toBe(42);
  });

  it('returns busy without running when a normal run is in flight', async () => {
    const { d, run, gates } = gated();
    d.notify(1);
    await adv(240_000);
    expect(run).toHaveBeenCalledTimes(1);
    const fn = vi.fn(async () => 1);
    expect(await d.runExclusive(1, fn)).toBe('busy');
    expect(fn).not.toHaveBeenCalled();
    gates[0]!();
    await adv(0);
    expect(await d.runExclusive(1, fn)).toBe(1);
  });

  it('returns busy when another exclusive run holds the client; other clients are not blocked', async () => {
    const { d } = gated();
    const held = heldFn('first');
    const first = d.runExclusive(1, held.fn);
    expect(await d.runExclusive(1, async () => 'second')).toBe('busy');
    expect(await d.runExclusive(2, async () => 'other')).toBe('other');
    held.release();
    expect(await first).toBe('first');
  });

  it('a normal run cannot start while an exclusive run holds the client, and runs afterwards', async () => {
    const { d, run, gates } = gated();
    const held = heldFn(null);
    const p = d.runExclusive(1, held.fn);
    d.notify(1);
    await adv(1_300_000); // past the quiet and max waits
    expect(run).not.toHaveBeenCalled();
    held.release();
    await p;
    await adv(239_000);
    expect(run).not.toHaveBeenCalled();
    await adv(1_000);
    expect(run).toHaveBeenCalledTimes(1);
    gates[0]!();
    await adv(0);
  });

  it('a run already counting down when the exclusive run starts waits for it', async () => {
    const { d, run } = gated();
    d.notify(1);
    await adv(100_000);
    const held = heldFn(null);
    const p = d.runExclusive(1, held.fn);
    await adv(200_000); // the quiet timer fires during the exclusive run
    expect(run).not.toHaveBeenCalled();
    held.release();
    await p;
    await adv(240_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a queued run waiting for a free slot does not start during an exclusive run', async () => {
    const gates: (() => void)[] = [];
    const run = vi.fn((_id: number) => new Promise<ReconcileOutcome>((resolve) => gates.push(() => resolve(OK))));
    const d = new GroupDebouncer({ quietMs: 1_000, maxWaitMs: 10_000, maxConcurrent: 1, retryMs: 3_600_000, run });
    d.notify(2);
    await adv(1_000);
    d.notify(1);
    await adv(1_000); // client 1 is queued behind client 2
    const held = heldFn(null);
    const p = d.runExclusive(1, held.fn);
    gates[0]!(); // client 2 ends; the slot is free while client 1 is held
    await adv(0);
    expect(run).toHaveBeenCalledTimes(1);
    held.release();
    await p;
    await adv(1_000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith(1);
    gates[1]!();
    await adv(0);
  });

  it('frees the client when the function throws', async () => {
    const { d } = gated();
    await expect(d.runExclusive(1, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await d.runExclusive(1, async () => 'again')).toBe('again');
  });

  it('a client cancelled during the exclusive run gets no follow-up run', async () => {
    const { d, run } = gated();
    const held = heldFn(null);
    const p = d.runExclusive(1, held.fn);
    d.notify(1);
    d.cancel(1);
    held.release();
    await p;
    await adv(1_300_000);
    expect(run).not.toHaveBeenCalled();
  });
});
