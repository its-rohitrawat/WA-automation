import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GroupDebouncer } from '../../src/brain/debouncer.ts';
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
});
