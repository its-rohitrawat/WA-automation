import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAILURES_BEFORE_BACKOFF, GroupDebouncer } from '../../src/brain/debouncer.ts';
import type { ReconcileOutcome } from '../../src/brain/reconciler.ts';

const OK: ReconcileOutcome = { status: 'ok', accepted: 1, rejected: 0 };
const adv = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function make(run = vi.fn(async (_id: number): Promise<ReconcileOutcome> => OK)) {
  return { run, d: new GroupDebouncer({ quietMs: 240_000, maxWaitMs: 1_200_000, maxConcurrent: 3, retryMs: 3_600_000, run }) };
}

function gated() {
  const gates: (() => void)[] = [];
  const run = vi.fn((_id: number) => new Promise<ReconcileOutcome>((resolve) => gates.push(() => resolve(OK))));
  return { gates, run };
}

describe('GroupDebouncer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs after four quiet minutes', async () => {
    const { run, d } = make();
    d.notify(1);
    await adv(239_000);
    expect(run).not.toHaveBeenCalled();
    await adv(1_000);
    expect(run).toHaveBeenCalledWith(1);
  });

  it('restarts the quiet timer on every new message', async () => {
    const { run, d } = make();
    d.notify(1);
    await adv(200_000);
    d.notify(1);
    await adv(200_000);
    expect(run).not.toHaveBeenCalled();
    await adv(40_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('runs after twenty minutes even if the group never goes quiet', async () => {
    const { run, d } = make();
    for (let i = 0; i < 20; i++) {
      d.notify(1);
      await adv(60_000);
    }
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('limits parallel runs and queues the rest', async () => {
    const { gates, run } = gated();
    const { d } = make(run);
    for (const id of [1, 2, 3, 4, 5]) d.notify(id);
    await adv(240_000);
    expect(run).toHaveBeenCalledTimes(3);
    gates[0]!();
    await settle();
    expect(run).toHaveBeenCalledTimes(4);
    expect(run.mock.calls[3]![0]).toBe(4);
  });

  it('runs again after messages that arrived during a run', async () => {
    const { gates, run } = gated();
    const { d } = make(run);
    d.notify(1);
    await adv(240_000);
    d.notify(1);
    gates[0]!();
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
    await adv(240_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('retries a failed batch after an hour', async () => {
    const { run, d } = make(vi.fn(async (): Promise<ReconcileOutcome> => ({ status: 'failed', errorCode: 'network' })));
    d.notify(1);
    await adv(240_000);
    expect(run).toHaveBeenCalledTimes(1);
    await adv(3_599_000);
    expect(run).toHaveBeenCalledTimes(1);
    await adv(1_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('ensure() schedules idle clients without resetting a running quiet timer', async () => {
    const { run, d } = make();
    d.notify(1);
    await adv(200_000);
    d.ensure(1);
    await adv(40_000);
    expect(run).toHaveBeenCalledTimes(1);
    d.ensure(2);
    await adv(240_000);
    expect(run).toHaveBeenCalledWith(2);
  });

  it('stop() cancels pending timers', async () => {
    const { run, d } = make();
    d.notify(1);
    d.stop();
    await adv(1_200_000);
    expect(run).not.toHaveBeenCalled();
  });

  it('survives a rejected run, reports it and retries after an hour', async () => {
    const onError = vi.fn();
    const run = vi.fn(async (_id: number): Promise<ReconcileOutcome> => {
      throw new Error('boom');
    });
    const d = new GroupDebouncer({ quietMs: 240_000, maxWaitMs: 1_200_000, maxConcurrent: 3, retryMs: 3_600_000, run, onError });
    d.notify(1);
    await adv(240_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    await adv(3_600_000);
    expect(run).toHaveBeenCalledTimes(2);
    d.stop();
  });

  it('stop() leaves no timers behind', async () => {
    const { d } = make(vi.fn(async (): Promise<ReconcileOutcome> => ({ status: 'failed', errorCode: 'x' })));
    d.notify(1);
    await adv(240_000);
    d.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  const mk = (run: (id: number) => Promise<ReconcileOutcome>, extra: object = {}) =>
    new GroupDebouncer({ quietMs: 240_000, maxWaitMs: 1_200_000, maxConcurrent: 1, retryMs: 3_600_000, run, ...extra });

  it('a throwing onError still gets its retry and leaves no unhandled rejection', async () => {
    const seen: unknown[] = [];
    const h = (e: unknown) => seen.push(e);
    process.on('unhandledRejection', h);
    try {
      const run = vi.fn(async (_id: number): Promise<ReconcileOutcome> => { throw new Error('boom'); });
      const d = mk(run, { onError: () => { throw new Error('cb'); } });
      d.notify(1);
      await adv(240_000);
      await settle();
      await adv(3_600_000);
      expect(run).toHaveBeenCalledTimes(2);
      d.stop();
      await adv(1);
      await settle();
      expect(seen).toEqual([]);
    } finally {
      process.off('unhandledRejection', h);
    }
  });

  it('a synchronous throw from run cannot wedge a client', async () => {
    const run = vi.fn((id: number): Promise<ReconcileOutcome> => {
      if (id === 1) throw new Error('sync');
      return Promise.resolve(OK);
    });
    const d = mk(run);
    d.notify(1);
    d.notify(2);
    await adv(240_000);
    await settle();
    expect(run).toHaveBeenCalledWith(2);
    await adv(3_600_000);
    expect(run.mock.calls.filter((c) => c[0] === 1)).toHaveLength(2);
    d.stop();
  });

  it('retries a paused batch after an hour', async () => {
    const run = vi.fn(async (_id: number): Promise<ReconcileOutcome> => ({ status: 'paused' }));
    const d = mk(run);
    d.notify(1);
    await adv(240_000);
    await adv(3_599_000);
    expect(run).toHaveBeenCalledTimes(1);
    await adv(1_000);
    expect(run).toHaveBeenCalledTimes(2);
    d.stop();
  });

  it('ensure() while a retry is pending does not run early', async () => {
    const run = vi.fn(async (): Promise<ReconcileOutcome> => ({ status: 'failed', errorCode: 'x' }));
    const d = mk(run);
    d.notify(1);
    await adv(240_000);
    d.ensure(1);
    await adv(1_200_000);
    expect(run).toHaveBeenCalledTimes(1);
    d.stop();
  });

  it('a notify in the retry window runs once after the quiet period, not again at the old retry time', async () => {
    const outcomes: ReconcileOutcome[] = [{ status: 'failed', errorCode: 'x' }, OK, OK];
    const run = vi.fn(async (_id: number): Promise<ReconcileOutcome> => outcomes.shift()!);
    const d = mk(run);
    d.notify(1);
    await adv(240_000);
    await adv(600_000);
    d.notify(1);
    await adv(240_000);
    expect(run).toHaveBeenCalledTimes(2);
    await adv(4_000_000);
    expect(run).toHaveBeenCalledTimes(2);
    d.stop();
  });

  it('stop() during a gated run followed by a failure leaves 0 timers and no more runs', async () => {
    const { gates, run } = gated();
    const d = mk(run);
    d.notify(1);
    await adv(240_000);
    d.stop();
    gates[0]!();
    await settle();
    expect(vi.getTimerCount()).toBe(0);
    await adv(7_200_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('backs off after repeated failures until the hourly retry, then recovers', async () => {
    const outcomes: ReconcileOutcome[] = [];
    for (let i = 0; i < FAILURES_BEFORE_BACKOFF; i++) outcomes.push({ status: 'failed', errorCode: 'x' });
    outcomes.push(OK, OK);
    const run = vi.fn(async (_id: number): Promise<ReconcileOutcome> => outcomes.shift()!);
    const d = mk(run);
    d.notify(1);
    await adv(240_000);
    for (let i = 1; i < FAILURES_BEFORE_BACKOFF; i++) await adv(3_600_000);
    expect(run).toHaveBeenCalledTimes(FAILURES_BEFORE_BACKOFF);
    d.notify(1);
    await adv(1_500_000);
    expect(run).toHaveBeenCalledTimes(FAILURES_BEFORE_BACKOFF);
    await adv(3_600_000);
    expect(run).toHaveBeenCalledTimes(FAILURES_BEFORE_BACKOFF + 1);
    d.notify(1);
    await adv(240_000);
    expect(run).toHaveBeenCalledTimes(FAILURES_BEFORE_BACKOFF + 2);
    d.stop();
  });

  it('cancel() with a pending quiet timer prevents the run', async () => {
    const run = vi.fn(async (_id: number): Promise<ReconcileOutcome> => OK);
    const d = mk(run);
    d.notify(1);
    d.cancel(1);
    await adv(1_300_000);
    expect(run).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancel() during a run that then fails schedules no retry; a later notify works', async () => {
    const gates: ((o: ReconcileOutcome) => void)[] = [];
    const run = vi.fn((_id: number) => new Promise<ReconcileOutcome>((r) => gates.push(r)));
    const d = mk(run);
    d.notify(1);
    await adv(240_000);
    d.notify(1);
    d.cancel(1);
    gates[0]!({ status: 'failed', errorCode: 'x' });
    await settle();
    expect(vi.getTimerCount()).toBe(0);
    await adv(7_200_000);
    expect(run).toHaveBeenCalledTimes(1);
    d.notify(1);
    await adv(240_000);
    expect(run).toHaveBeenCalledTimes(2);
    d.stop();
  });

  it('cancel() removes a queued client', async () => {
    const { gates, run } = gated();
    const d = mk(run);
    d.notify(1);
    d.notify(2);
    await adv(240_000);
    d.cancel(2);
    gates[0]!();
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
    d.stop();
  });

  it('drain() resolves after a gated run finishes and leaves no timer', async () => {
    const { gates, run } = gated();
    const d = mk(run);
    d.notify(1);
    await adv(240_000);
    d.stop();
    let done = false;
    const p = d.drain(60_000).then(() => { done = true; });
    await settle();
    expect(done).toBe(false);
    gates[0]!();
    await p;
    expect(done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drain() resolves at the timeout if the run never finishes', async () => {
    const { run } = gated();
    const d = mk(run);
    d.notify(1);
    await adv(240_000);
    d.stop();
    let done = false;
    const p = d.drain(5_000).then(() => { done = true; });
    await adv(4_000);
    expect(done).toBe(false);
    await adv(1_000);
    await p;
    expect(done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drain() resolves immediately when idle', async () => {
    const d = mk(vi.fn(async () => OK));
    await d.drain(1_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
