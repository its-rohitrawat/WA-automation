import { describe, expect, it } from 'vitest';
import { LiveReport, OPEN_FAILED_WARNING, type LiveReportSettings } from '../../src/report/liveReport.ts';
import { TRACKER_ID_KEY } from '../../src/report/morningReport.ts';
import type { ReportSettings } from '../../src/report/types.ts';
import { setKv } from '../../src/store/kv.ts';
import { claimReport, reportFor } from '../../src/store/reports.ts';
import { manualClock } from '../../src/util/clock.ts';
import { silentLogger } from '../../src/util/logger.ts';
import { seededDb } from '../helpers/db.ts';
import { FakeReportSender } from '../helpers/fakeReportSender.ts';

// 2026-10-23 is a Friday.
const at = (hm: string) => `2026-10-23T${hm}:00.000+05:30`;
const ON: ReportSettings = { enabled: true, time: '06:00', deadline: '12:00', days: 'weekdays' };
const A = '919812345678';
const B = '917012349999';

async function setup(initial: LiveReportSettings, o: { failOpen?: number } = {}) {
  const db = await seededDb();
  setKv(db, TRACKER_ID_KEY, '1AbCdEfGhIjKlMnOp_qRsTuV-wxyz0123');
  const clock = manualClock(at('05:00'));
  let current = initial;
  let failOpen = o.failOpen ?? 0;
  const opened: { recipient: string; sender: FakeReportSender; closed: number }[] = [];
  const live = new LiveReport({
    db, clock, log: silentLogger(), healthLine: () => ({ ok: true, text: '✅' }),
    settings: () => current,
    open: (recipient) => {
      if (failOpen > 0) {
        failOpen--;
        throw new Error('session file locked');
      }
      const sender = new FakeReportSender();
      sender.recipientMasked = `…${recipient.slice(-4)}`;
      const entry = { recipient, sender, closed: 0 };
      opened.push(entry);
      return { sender, close: () => entry.closed++ };
    },
  });
  const tick = async (hm: string) => {
    clock.set(at(hm));
    await live.tick(clock.now());
  };
  return { db, live, opened, tick, set: (next: LiveReportSettings) => (current = next) };
}

const sent = (o: { sender: FakeReportSender }[]) => o.reduce((n, x) => n + x.sender.calls.length, 0);

describe('LiveReport', () => {
  it('opens nothing while the briefing is off, and says so', async () => {
    const t = await setup({ report: { ...ON, enabled: false }, recipient: A });
    await t.tick('06:30');
    expect(t.opened).toHaveLength(0);
    expect(t.live.health()).toEqual({ text: 'Morning report: off', warning: null });
  });

  it('turning on at runtime opens the module once, and sends within the window', async () => {
    const t = await setup({ report: { ...ON, enabled: false }, recipient: A });
    await t.tick('06:00');
    t.set({ report: ON, recipient: A });
    await t.tick('06:30');
    await t.tick('06:31');
    await t.tick('07:00');
    expect(t.opened.map((o) => o.recipient)).toEqual([A]);
    expect(sent(t.opened)).toBe(1);
    expect(reportFor(t.db, '2026-10-23')?.status).toBe('sent');
    expect(t.live.health()).toMatchObject({ text: expect.stringMatching(/^Morning report: sent at/), recipientMasked: '…5678' });
  });

  it('turning off skips the next send; the opened sender stays for a later switch-on', async () => {
    const t = await setup({ report: ON, recipient: A });
    await t.tick('05:30');
    t.set({ report: { ...ON, enabled: false }, recipient: A });
    await t.tick('06:30');
    expect(sent(t.opened)).toBe(0);
    expect(t.live.health().text).toBe('Morning report: off');
    t.set({ report: ON, recipient: A });
    await t.tick('06:31');
    expect(sent(t.opened)).toBe(1);
    expect(t.opened).toHaveLength(1);
  });

  it('a number change stops and closes the old sender, then makes a new one for the new number', async () => {
    const t = await setup({ report: ON, recipient: A });
    await t.tick('05:30');
    t.set({ report: ON, recipient: B });
    await t.tick('05:31');
    expect(t.opened.map((o) => [o.recipient, o.sender.stopped, o.closed])).toEqual([[A, 1, 1], [B, 0, 0]]);
    await t.tick('06:30');
    expect(t.opened[0]!.sender.calls).toHaveLength(0);
    expect(t.opened[1]!.sender.calls).toHaveLength(1);
    expect(t.live.health().recipientMasked).toBe('…9999');
  });

  it('a new sender never sends a second report on a date already sent', async () => {
    const t = await setup({ report: ON, recipient: A });
    await t.tick('06:30');
    t.set({ report: ON, recipient: B });
    await t.tick('07:00');
    await t.tick('08:00');
    expect(sent(t.opened)).toBe(1);
  });

  it('a send cut off mid-way reads unknown under the new sender and is never retried', async () => {
    const t = await setup({ report: ON, recipient: A });
    await t.tick('05:30');
    claimReport(t.db, '2026-10-23', new Date(at('06:00')).toISOString()); // as if a send had started and the outcome was lost
    t.set({ report: ON, recipient: B });
    await t.tick('06:30');
    await t.tick('07:00');
    expect(reportFor(t.db, '2026-10-23')?.status).toBe('unknown');
    expect(sent(t.opened)).toBe(0);
  });

  it('a failed open is logged and tried again on the next tick', async () => {
    const t = await setup({ report: ON, recipient: A }, { failOpen: 1 });
    await t.tick('06:30');
    expect(t.opened).toHaveLength(0);
    expect(t.live.health().text).toBe('Morning report: starting');
    await t.tick('06:31');
    expect(t.opened).toHaveLength(1);
    expect(sent(t.opened)).toBe(1);
  });

  it('switched on without a number, it opens nothing', async () => {
    const t = await setup({ report: ON, recipient: undefined });
    await t.tick('06:30');
    expect(t.opened).toHaveLength(0);
  });

  it('a tick while one is running does nothing', async () => {
    const t = await setup({ report: ON, recipient: A });
    await t.tick('05:30');
    let release!: () => void;
    t.opened[0]!.sender.gate = new Promise((r) => (release = r));
    const first = t.tick('06:30');
    await t.tick('06:31');
    release();
    await first;
    expect(sent(t.opened)).toBe(1);
  });

  it('stop stops the scheduler and closes the sender; later ticks do nothing', async () => {
    const t = await setup({ report: ON, recipient: A });
    await t.tick('05:30');
    await t.live.stop(1000);
    expect(t.opened.map((o) => [o.sender.stopped, o.closed])).toEqual([[1, 1]]);
    await t.tick('06:30');
    expect(sent(t.opened)).toBe(0);
    expect(t.opened).toHaveLength(1);
  });
});

describe('LiveReport review fixes', () => {
  /** Makes the sender's stop wait until released, as a slow socket close would. */
  function gateStop(sender: FakeReportSender): () => void {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    sender.stop = async () => {
      sender.stopped++;
      await gate;
    };
    return release;
  }
  const settle = () => new Promise((r) => setTimeout(r, 10));

  it('the old sender is closed before the new one opens', async () => {
    const t = await setup({ report: ON, recipient: A });
    await t.tick('05:30');
    const release = gateStop(t.opened[0]!.sender);
    t.set({ report: ON, recipient: B });
    const rebuilding = t.tick('05:31');
    await settle();
    expect(t.opened.map((o) => [o.recipient, o.closed])).toEqual([[A, 0]]);
    release();
    await rebuilding;
    expect(t.opened.map((o) => [o.recipient, o.closed])).toEqual([[A, 1], [B, 0]]);
  });

  it('reads the number again after the close: a second change meanwhile opens for the latest number only', async () => {
    const C = '919900001111';
    const t = await setup({ report: ON, recipient: A });
    await t.tick('05:30');
    const release = gateStop(t.opened[0]!.sender);
    t.set({ report: ON, recipient: B });
    const rebuilding = t.tick('06:30');
    await settle();
    t.set({ report: ON, recipient: C });
    release();
    await rebuilding;
    expect(t.opened.map((o) => o.recipient)).toEqual([A, C]);
    expect(t.opened[1]!.sender.calls).toHaveLength(1);
  });

  it('switched off during the close, it opens nothing new', async () => {
    const t = await setup({ report: ON, recipient: A });
    await t.tick('05:30');
    const release = gateStop(t.opened[0]!.sender);
    t.set({ report: ON, recipient: B });
    const rebuilding = t.tick('06:30');
    await settle();
    t.set({ report: { ...ON, enabled: false }, recipient: B });
    release();
    await rebuilding;
    expect(t.opened).toHaveLength(1);
  });

  it('stop during a rebuild waits for the old session file to close, and opens nothing new', async () => {
    const t = await setup({ report: ON, recipient: A });
    await t.tick('05:30');
    const release = gateStop(t.opened[0]!.sender);
    t.set({ report: ON, recipient: B });
    const rebuilding = t.tick('05:31');
    await settle();
    let stopped = false;
    const stopping = t.live.stop(1000).then(() => (stopped = true));
    await settle();
    expect(stopped).toBe(false);
    release();
    await stopping;
    await rebuilding;
    expect(t.opened.map((o) => [o.recipient, o.closed])).toEqual([[A, 1]]);
  });

  it('a number change during a send waits: the old sender is not stopped and nothing opens until the send ends', async () => {
    const t = await setup({ report: ON, recipient: A });
    await t.tick('05:30');
    let release!: () => void;
    t.opened[0]!.sender.gate = new Promise((r) => (release = r));
    const sending = t.tick('06:30');
    await settle();
    t.set({ report: ON, recipient: B });
    await t.tick('06:31');
    expect(t.opened[0]!.sender.stopped).toBe(0);
    expect(t.opened).toHaveLength(1);
    release();
    await sending;
    expect(reportFor(t.db, '2026-10-23')?.status).toBe('sent');
    await t.tick('06:32');
    expect(t.opened.map((o) => o.recipient)).toEqual([A, B]);
    expect(sent(t.opened)).toBe(1);
  });

  it('waits longer after each failed open, and warns the owner after three', async () => {
    const t = await setup({ report: ON, recipient: A }, { failOpen: 3 });
    await t.tick('06:00'); // 1st failure: next try in 1 min
    await t.tick('06:00');
    await t.tick('06:01'); // 2nd: in 2 min
    expect(t.live.health()).toEqual({ text: 'Morning report: starting', warning: null });
    await t.tick('06:02');
    await t.tick('06:03'); // 3rd: in 4 min
    expect(t.live.health().warning).toBe(OPEN_FAILED_WARNING);
    await t.tick('06:06');
    expect(t.opened).toHaveLength(0);
    await t.tick('06:07');
    expect(t.opened).toHaveLength(1);
    expect(t.live.health().warning).toBeNull();
  });

  it('health never throws when the settings cannot be read', async () => {
    const t = await setup({ report: ON, recipient: A });
    t.set(undefined as unknown as LiveReportSettings);
    expect(t.live.health().text).toBe('Morning report: settings could not be read');
  });
});

describe('LiveReport stop during a rebuild (review round 2)', () => {
  it('stop does not resolve while the old sender is still closing, even past its own short wait', async () => {
    const t = await setup({ report: ON, recipient: A });
    await t.tick('05:30');
    const old = t.opened[0]!.sender;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    old.stop = async () => {
      old.stopped++;
      await gate;
    };
    t.set({ report: ON, recipient: B });
    const rebuilding = t.tick('05:31');
    await new Promise((r) => setTimeout(r, 10));
    let stopped = false;
    const stopping = t.live.stop(20).then(() => (stopped = true));
    await new Promise((r) => setTimeout(r, 60));
    expect(stopped).toBe(false);
    release();
    await stopping;
    await rebuilding;
    expect(t.opened.map((o) => [o.recipient, o.closed])).toEqual([[A, 1]]);
  });
});

describe('LiveReport pause (a spare-phone link from the dashboard)', () => {
  it('opens, ticks and sends nothing while paused, and goes on once released', async () => {
    const t = await setup({ report: ON, recipient: A });
    const release = await t.live.pause();
    await t.tick('06:30');
    expect(t.opened).toHaveLength(0);
    expect(t.live.scheduler()).toBeUndefined();
    release();
    release(); // a second call changes nothing
    await t.tick('06:31');
    expect(t.opened.map((o) => o.recipient)).toEqual([A]);
    expect(t.live.recipient()).toBe(A);
    expect(t.live.sender()).toBe(t.opened[0]!.sender);
  });

  it('a pause that comes while a number change closes the old sender opens no new one until released', async () => {
    const t = await setup({ report: ON, recipient: A });
    await t.tick('05:30'); // opens A before the send time
    t.set({ report: ON, recipient: B });
    const ticking = t.tick('05:31'); // closes A for the new number
    const paused = t.live.pause(); // waits for that tick
    await ticking;
    const release = await paused;
    expect(t.opened.map((o) => o.recipient)).toEqual([A]);
    expect(t.opened[0]!.closed).toBe(1);
    release();
    await t.tick('05:32');
    expect(t.opened.map((o) => o.recipient)).toEqual([A, B]);
  });
});
