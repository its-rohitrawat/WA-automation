import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { manualClock } from '../../src/util/clock.ts';
import type { GatewayLike, GatewayState, GatewayStatus, HistoryAnswer } from '../../src/wa/gateway.ts';
import type { NormalizedEvent } from '../../src/wa/normalize.ts';
import { NotConnectedError, SwitchableGateway } from '../../src/wa/switchableGateway.ts';

const T0 = '2026-10-27T08:00:00.000Z';

/** An inner gateway the test drives: emit events and statuses, count start/stop, hang stop on demand. */
class FakeGateway implements GatewayLike {
  readonly #e = new EventEmitter();
  state: GatewayState = 'stopped';
  starts = 0;
  stops = 0;
  hangStop = false;
  /** What idle() returns: the events this gateway is still storing. */
  storing: Promise<void> = Promise.resolve();
  failed = 0;
  dropped = 0;
  groups = [{ id: '120363777000000001@g.us', subject: 'A' }];
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
  onEvent(fn: (e: NormalizedEvent) => void) {
    this.#e.on('event', fn);
  }
  onStatus(fn: (s: GatewayStatus) => void) {
    this.#e.on('status', fn);
  }
  status(): GatewayStatus {
    return { state: this.state, since: T0, lastErrorCode: null, credsSaveFailures: 0 };
  }
  idle() {
    return this.storing;
  }
  start() {
    this.starts++;
  }
  async stop() {
    this.stops++;
    if (this.hangStop) await new Promise(() => {});
    this.state = 'stopped';
  }
  async listGroups() {
    return this.groups;
  }
  failedCount() {
    return this.failed;
  }
  droppedCount() {
    return this.dropped;
  }
  emit(e: NormalizedEvent) {
    this.#e.emit('event', e);
  }
  setState(state: GatewayState) {
    this.state = state;
    this.#e.emit('status', this.status());
  }
}

const event = (id: string) => ({ kind: 'message', waId: id }) as unknown as NormalizedEvent;

function collect(g: SwitchableGateway) {
  const events: NormalizedEvent[] = [];
  const statuses: GatewayStatus[] = [];
  g.onEvent((e) => events.push(e));
  g.onStatus((s) => statuses.push(s));
  return { events, statuses };
}

describe('SwitchableGateway', () => {
  it('forwards start, stop, status, events, listGroups and the counters to the inner gateway', async () => {
    const inner = new FakeGateway('a');
    const g = new SwitchableGateway({ inner, clock: manualClock(T0) });
    const { events, statuses } = collect(g);
    g.start();
    expect(inner.starts).toBe(1);
    inner.setState('open');
    inner.emit(event('1'));
    expect(events).toEqual([event('1')]);
    expect(statuses.at(-1)!.state).toBe('open');
    expect(g.status().state).toBe('open');
    expect(await g.listGroups()).toEqual(inner.groups);
    inner.failed = 3;
    inner.dropped = 7;
    expect(g.failedCount()).toBe(3);
    expect(g.droppedCount()).toBe(7);
    await g.stop();
    expect(inner.stops).toBe(1);
  });

  it('handlers survive a swap; the old gateway is stopped and its later events and statuses are ignored', async () => {
    const a = new FakeGateway('a');
    const b = new FakeGateway('b');
    const g = new SwitchableGateway({ inner: a, clock: manualClock(T0) });
    const { events, statuses } = collect(g);
    g.start();
    a.setState('open');
    await g.swap(b);
    expect(a.stops).toBe(1);
    expect(b.starts).toBe(1);
    a.emit(event('old'));
    a.setState('open');
    b.emit(event('new'));
    b.setState('open');
    expect(events).toEqual([event('new')]);
    expect(statuses.map((s) => s.state)).toEqual(['open', 'stopped', 'open']); // a open, b's status on swap, b open
    expect(g.status().state).toBe('open');
  });

  // Bug 11: the service waits for idle() before its database closes. After a relink that must include the old
  // gateway's event still being stored (on Postgres a network write), not only the new gateway's.
  it('idle() waits for what the old gateway was storing when it was swapped out, as well as the current one', async () => {
    const a = new FakeGateway('a');
    const b = new FakeGateway('b');
    let stored!: () => void;
    a.storing = new Promise((r) => (stored = r));
    const g = new SwitchableGateway({ inner: a, clock: manualClock(T0) });
    g.start();
    await g.swap(b);
    let idle = false;
    void g.idle().then(() => (idle = true));
    await new Promise((r) => setImmediate(r));
    expect(idle).toBe(false);
    stored();
    await new Promise((r) => setImmediate(r));
    expect(idle).toBe(true);
  });

  it('keeps the failure and drop counts of earlier gateways', async () => {
    const a = new FakeGateway('a');
    const b = new FakeGateway('b');
    const g = new SwitchableGateway({ inner: a, clock: manualClock(T0) });
    a.failed = 2;
    a.dropped = 5;
    await g.swap(b);
    b.failed = 1;
    expect(g.failedCount()).toBe(3);
    expect(g.droppedCount()).toBe(5);
  });

  it('a swap does not wait more than 5 s for a stop that hangs', async () => {
    const a = new FakeGateway('a');
    a.hangStop = true;
    const b = new FakeGateway('b');
    const g = new SwitchableGateway({ inner: a, clock: manualClock(T0), stopCapMs: 20 });
    g.start();
    await g.swap(b);
    expect(b.starts).toBe(1);
  });

  it('clear leaves no inner gateway: status reports the held state, and listGroups throws NotConnectedError', async () => {
    const a = new FakeGateway('a');
    const clock = manualClock(T0);
    const g = new SwitchableGateway({ inner: a, clock });
    const { statuses } = collect(g);
    clock.advance(1000);
    await g.clear('linking');
    expect(a.stops).toBe(1);
    expect(g.status()).toEqual({ state: 'linking', since: '2026-10-27T08:00:01.000Z', lastErrorCode: null, credsSaveFailures: 0 });
    expect(statuses.at(-1)!.state).toBe('linking');
    await expect(g.listGroups()).rejects.toBeInstanceOf(NotConnectedError);
    a.emit(event('late'));
    g.start(); // nothing to start: no throw
    await g.stop();
  });

  it('starts with no inner gateway in setup mode (not_linked)', async () => {
    const g = new SwitchableGateway({ clock: manualClock(T0), initialState: 'not_linked' });
    expect(g.status().state).toBe('not_linked');
    g.start();
    await expect(g.listGroups()).rejects.toMatchObject({ code: 'whatsapp_not_connected' });
    const b = new FakeGateway('b');
    await g.swap(b);
    expect(b.starts).toBe(1);
  });

  it('listGroups throws NotConnectedError while the inner gateway is not open', async () => {
    const a = new FakeGateway('a');
    a.state = 'connecting';
    const g = new SwitchableGateway({ inner: a, clock: manualClock(T0) });
    await expect(g.listGroups()).rejects.toBeInstanceOf(NotConnectedError);
  });

  it('a swap after the service stopped never leaves the new gateway running', async () => {
    const a = new FakeGateway('a');
    const g = new SwitchableGateway({ inner: a, clock: manualClock(T0) });
    g.start();
    await g.stop();
    const b = new FakeGateway('b');
    await g.swap(b);
    expect(b.starts).toBe(0);
    expect(b.stops).toBe(1);
  });

  it('a swap before the service started installs the gateway, which start() then starts', async () => {
    const g = new SwitchableGateway({ clock: manualClock(T0) });
    const b = new FakeGateway('b');
    await g.swap(b);
    expect([b.starts, b.stops]).toEqual([0, 0]);
    g.start();
    expect(b.starts).toBe(1);
  });

  it('a second swap while the first waits for a hung stop: only the last gateway is started', async () => {
    const a = new FakeGateway('a');
    a.hangStop = true;
    const g = new SwitchableGateway({ inner: a, clock: manualClock(T0), stopCapMs: 30 });
    g.start();
    const b = new FakeGateway('b');
    const c = new FakeGateway('c');
    const first = g.swap(b);
    await g.swap(c);
    await first;
    expect(b.starts).toBe(0);
    expect(b.stops).toBe(1);
    expect(c.starts).toBe(1);
    expect(g.status().state).toBe(c.state);
  });

  it('a clear while a swap waits: the new gateway is not started, and the held state stays', async () => {
    const a = new FakeGateway('a');
    a.hangStop = true;
    const g = new SwitchableGateway({ inner: a, clock: manualClock(T0), stopCapMs: 30 });
    g.start();
    const b = new FakeGateway('b');
    const swapping = g.swap(b);
    await g.clear('linking');
    await swapping;
    expect(b.starts).toBe(0);
    expect(g.status().state).toBe('linking');
  });

  it('clear reports the held state at once, before a hung stop ends', async () => {
    const a = new FakeGateway('a');
    a.hangStop = true;
    const g = new SwitchableGateway({ inner: a, clock: manualClock(T0), stopCapMs: 50 });
    const { statuses } = collect(g);
    const clearing = g.clear('linking');
    expect(statuses.map((s) => s.state)).toEqual(['linking']);
    await clearing;
  });

  it('a handler that throws reaches the inner gateway, which counts the failure', () => {
    const a = new FakeGateway('a');
    const g = new SwitchableGateway({ inner: a, clock: manualClock(T0) });
    g.onEvent(() => {
      throw new Error('ingest failed');
    });
    expect(() => a.emit(event('1'))).toThrow('ingest failed');
  });

  it('swapping in the gateway already installed changes nothing and does not double the events', async () => {
    const a = new FakeGateway('a');
    const g = new SwitchableGateway({ inner: a, clock: manualClock(T0) });
    const { events } = collect(g);
    g.start();
    await g.swap(a);
    expect(a.stops).toBe(0);
    a.emit(event('1'));
    expect(events).toEqual([event('1')]);
  });

  it('a faulty listener does not break forwarding', async () => {
    const a = new FakeGateway('a');
    const g = new SwitchableGateway({ inner: a, clock: manualClock(T0) });
    g.onStatus(() => {
      throw new Error('listener bug');
    });
    const { statuses } = collect(g);
    a.setState('open');
    expect(statuses.at(-1)!.state).toBe('open');
  });
});

describe('SwitchableGateway: earlier messages (history backfill)', () => {
  /** A gateway that can ask for history: its answers go out on the history channel. */
  class HistoryGateway extends FakeGateway {
    readonly #h = new EventEmitter();
    asked = 0;
    onHistory(fn: (a: HistoryAnswer) => void) {
      this.#h.on('h', fn);
    }
    answer(a: HistoryAnswer) {
      this.#h.emit('h', a);
    }
    async fetchHistory() {
      this.asked++;
      return true;
    }
  }
  const anchor = { waId: 'A', fromMe: false, ts: new Date(T0) };

  it('asks the current gateway only while it is open; nothing in setup mode', async () => {
    const empty = new SwitchableGateway({ clock: manualClock(T0) });
    expect(await empty.fetchHistory('g@g.us', anchor, 50)).toBe(false);
    const inner = new HistoryGateway('a');
    const sw = new SwitchableGateway({ inner, clock: manualClock(T0) });
    expect(await sw.fetchHistory('g@g.us', anchor, 50)).toBe(false);
    inner.state = 'open';
    expect(await sw.fetchHistory('g@g.us', anchor, 50)).toBe(true);
    expect(inner.asked).toBe(1);
  });

  it('passes on the current gateway\'s answers, never an old one\'s after a relink', async () => {
    const first = new HistoryGateway('first');
    const sw = new SwitchableGateway({ inner: first, clock: manualClock(T0) });
    const got: HistoryAnswer[] = [];
    sw.onHistory((a) => got.push(a));
    first.answer({ groups: [] });
    const second = new HistoryGateway('second');
    await sw.swap(second);
    first.answer({ groups: [{ groupId: 'old@g.us', events: [] }] });
    second.answer({ groups: [{ groupId: 'new@g.us', events: [] }] });
    expect(got).toEqual([{ groups: [] }, { groups: [{ groupId: 'new@g.us', events: [] }] }]);
  });
});
