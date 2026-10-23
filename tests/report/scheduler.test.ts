import { describe, expect, it, vi } from 'vitest';
import { describeReport, ReportScheduler, retryWaitMs, UNKNOWN_WARNING, type ReportPayload } from '../../src/report/scheduler.ts';
import type { ReportSettings, SendResult } from '../../src/report/types.ts';
import { getKv, setKv } from '../../src/store/kv.ts';
import { claimReport, finishReport, REPORT_REQUEST_KEY, reportFor, retryReport, type ReportRow } from '../../src/store/reports.ts';
import { manualClock } from '../../src/util/clock.ts';
import { silentLogger } from '../../src/util/logger.ts';
import { seededDb } from '../helpers/db.ts';
import { FakeReportSender } from '../helpers/fakeReportSender.ts';

const DAY = '2026-10-23';
const IST = (hm: string) => `${DAY}T${hm}:00.000+05:30`;
const iso = (hm: string) => new Date(IST(hm)).toISOString();
const ON: ReportSettings = { enabled: true, time: '06:00', deadline: '12:00' };
const failed = (code: string): SendResult => ({ status: 'failed', code });

function setup(o: { settings?: ReportSettings; build?: (now: Date) => Promise<ReportPayload> } = {}) {
  const db = seededDb();
  const clock = manualClock(IST('05:00'));
  const sender = new FakeReportSender();
  const s = new ReportScheduler({
    db, clock, log: silentLogger(), sender, settings: o.settings ?? ON, healthLine: () => ({ ok: true, text: '✅ Connected' }), build: o.build,
  });
  /** Moves the clock to an IST time today and runs one tick. */
  const at = async (hm: string) => {
    clock.set(IST(hm));
    await s.tick(clock.now());
  };
  return { db, clock, sender, s, at };
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}

/** Lets pending promise callbacks run, so a step that would happen at once has happened. */
const settle = () => new Promise<void>((r) => setImmediate(r));

describe('ReportScheduler', () => {
  it('sends once at 06:00, with the tracker attached', async () => {
    const { db, sender, at } = setup();
    await at('05:59');
    expect(sender.calls).toHaveLength(0);
    expect(reportFor(db, DAY)).toBeUndefined();
    await at('06:00');
    expect(sender.calls).toHaveLength(1);
    const call = sender.calls[0]!;
    expect(call.fileName).toBe('Tracker-2026-10-23.xlsx');
    expect(call.text.startsWith('Morning report · 23 Oct')).toBe(true);
    expect(call.xlsx.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(reportFor(db, DAY)).toMatchObject({ status: 'sent', detail: 'msg-1,msg-2', attempts: 1, forced: false });
    for (const hm of ['06:01', '09:00', '11:59']) await at(hm);
    expect(sender.calls).toHaveLength(1);
  });

  it('catches up at 09:30 after downtime', async () => {
    const { db, sender, at } = setup();
    await at('09:30');
    expect(sender.calls).toHaveLength(1);
    expect(reportFor(db, DAY)!.status).toBe('sent');
  });

  it('skips the day after 12:00 and says why', async () => {
    const { db, sender, s, at } = setup();
    await at('12:00');
    expect(sender.calls).toHaveLength(0);
    expect(reportFor(db, DAY)).toMatchObject({ status: 'skipped', detail: 'not_running' });
    expect(s.health()).toEqual({ text: 'Morning report skipped today (the service was not running in time)', warning: null });
  });

  it('retries a definite failure after 2, 5, then 10 minutes', async () => {
    const { db, sender, s, at } = setup();
    sender.results = [failed('connect_timeout'), failed('connect_timeout'), failed('closed'), failed('closed')];
    await at('06:00');
    expect(reportFor(db, DAY)).toMatchObject({ status: 'retry', detail: 'connect_timeout', nextAttemptAt: iso('06:02') });
    expect(s.health().text).toBe('Morning report: not sent yet (could not connect to WhatsApp), next try 06:02 IST');
    await at('06:01');
    expect(sender.calls).toHaveLength(1);
    await at('06:02');
    expect(reportFor(db, DAY)!.nextAttemptAt).toBe(iso('06:07'));
    await at('06:06');
    expect(sender.calls).toHaveLength(2);
    await at('06:07');
    expect(reportFor(db, DAY)!.nextAttemptAt).toBe(iso('06:17'));
    await at('06:17');
    expect(reportFor(db, DAY)!.nextAttemptAt).toBe(iso('06:27'));
    await at('06:27');
    expect(sender.calls).toHaveLength(5);
    expect(reportFor(db, DAY)).toMatchObject({ status: 'sent', attempts: 5 });
  });

  it('stops retrying at 12:00 and keeps the last reason', async () => {
    const { db, sender, at } = setup();
    sender.results = [failed('not_linked'), failed('not_linked')];
    await at('11:55');
    await at('12:00');
    expect(sender.calls).toHaveLength(1);
    expect(reportFor(db, DAY)).toMatchObject({ status: 'skipped', detail: 'not_linked' });
  });

  it('never retries an unknown outcome', async () => {
    const { db, sender, s, at } = setup();
    sender.results = [{ status: 'unknown', code: 'timeout' }];
    await at('06:00');
    for (const hm of ['06:30', '11:00', '12:30']) await at(hm);
    expect(sender.calls).toHaveLength(1);
    expect(reportFor(db, DAY)).toMatchObject({ status: 'unknown', detail: 'timeout' });
    expect(s.health()).toEqual({ text: 'Morning report: unknown, check WhatsApp', warning: UNKNOWN_WARNING });
  });

  it('turns a crash mid-send into unknown at start, and does not send that day again', async () => {
    const { db, clock, sender, s, at } = setup();
    claimReport(db, DAY, iso('06:00')); // the previous run died while sending
    clock.set(IST('06:20'));
    s.recover(clock.now());
    expect(reportFor(db, DAY)).toMatchObject({ status: 'unknown', detail: 'interrupted' });
    await at('06:30');
    expect(sender.calls).toHaveLength(0);
  });

  it('does nothing when disabled, and drops a send-now request', async () => {
    const { db, sender, s, at } = setup({ settings: { ...ON, enabled: false } });
    setKv(db, REPORT_REQUEST_KEY, DAY);
    await at('06:00');
    expect(sender.calls).toHaveLength(0);
    expect(reportFor(db, DAY)).toBeUndefined();
    expect(getKv(db, REPORT_REQUEST_KEY)).toBe('');
    expect(s.health()).toEqual({ text: 'Morning report: off', warning: null });
  });

  it('runs one send at a time', async () => {
    const { db, clock, sender, s } = setup();
    const g = gate();
    sender.gate = g.promise;
    clock.set(IST('06:00'));
    const first = s.tick(clock.now());
    await vi.waitFor(() => expect(sender.calls).toHaveLength(1));
    setKv(db, REPORT_REQUEST_KEY, DAY);
    await s.tick(clock.now());
    expect(sender.calls).toHaveLength(1);
    expect(getKv(db, REPORT_REQUEST_KEY)).toBe(DAY); // the second tick returned before reading the request
    const stopping = s.stop(5_000);
    await settle();
    expect(sender.stopped).toBe(0); // the first send is still tracked, so stop waits for it
    g.release();
    await stopping;
    await first;
    expect(sender.stopped).toBe(1);
  });

  it('records a sender crash as unknown and a build failure as a retry', async () => {
    const crash = setup();
    crash.sender.throwNext = true;
    await crash.at('06:00');
    expect(reportFor(crash.db, DAY)).toMatchObject({ status: 'unknown', detail: 'crash' });

    const broken = setup({ build: async () => Promise.reject(new Error('disk full')) });
    await broken.at('06:00');
    expect(broken.sender.calls).toHaveLength(0);
    expect(reportFor(broken.db, DAY)).toMatchObject({ status: 'retry', detail: 'build_failed', nextAttemptAt: iso('06:02') });
  });

  it('sends on a send-now request at any time, also after an unknown outcome, but never a second time', async () => {
    const { db, sender, at } = setup();
    claimReport(db, DAY, iso('06:00'));
    finishReport(db, DAY, 'unknown', 'timeout', iso('06:01'));
    setKv(db, REPORT_REQUEST_KEY, DAY);
    await at('15:00');
    expect(sender.calls).toHaveLength(1);
    expect(reportFor(db, DAY)).toMatchObject({ status: 'sent', forced: true, attempts: 2 });
    expect(getKv(db, REPORT_REQUEST_KEY)).toBe('');
    setKv(db, REPORT_REQUEST_KEY, DAY);
    await at('15:01');
    expect(sender.calls).toHaveLength(1);
  });

  it('ignores a send-now request left from an earlier day', async () => {
    const { db, sender, at } = setup();
    setKv(db, REPORT_REQUEST_KEY, '2026-10-22');
    await at('15:00');
    expect(sender.calls).toHaveLength(0);
    expect(getKv(db, REPORT_REQUEST_KEY)).toBe('');
  });

  it('stop waits for the send in flight, stops the sender and starts no new send', async () => {
    const { db, clock, sender, s, at } = setup();
    const g = gate();
    sender.gate = g.promise;
    clock.set(IST('06:00'));
    const first = s.tick(clock.now());
    await vi.waitFor(() => expect(sender.calls).toHaveLength(1));
    const stopping = s.stop(5_000);
    await settle();
    expect(sender.stopped).toBe(0); // the sender is not stopped while the send is going out
    g.release();
    await stopping;
    expect(sender.stopped).toBe(1);
    await first;
    expect(reportFor(db, DAY)!.status).toBe('sent');
    setKv(db, REPORT_REQUEST_KEY, DAY);
    await at('06:30');
    expect(sender.calls).toHaveLength(1);
  });

  it('starts no new send once stopped, also on a send-now request', async () => {
    const { db, sender, s, at } = setup();
    await s.stop(1_000);
    expect(sender.stopped).toBe(1);
    setKv(db, REPORT_REQUEST_KEY, DAY);
    await at('06:00');
    await at('07:00');
    expect(sender.calls).toHaveLength(0);
    expect(reportFor(db, DAY)).toBeUndefined();
  });

  it('stop gives up on a hung send after waitMs and still stops the sender', async () => {
    const { clock, sender, s } = setup();
    sender.gate = new Promise<void>(() => {}); // never settles
    clock.set(IST('06:00'));
    void s.tick(clock.now());
    await vi.waitFor(() => expect(sender.calls).toHaveLength(1));
    const t0 = Date.now();
    await s.stop(100);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(sender.stopped).toBe(1);
  });

  it("closes an earlier day's retry row as skipped and keeps its reason", async () => {
    const { db, at } = setup();
    const before = '2026-10-22T06:00:00.000Z';
    claimReport(db, '2026-10-22', before);
    retryReport(db, '2026-10-22', 'connect_timeout', '2026-10-22T06:02:00.000Z', before);
    await at('05:00');
    expect(reportFor(db, '2026-10-22')).toMatchObject({ status: 'skipped', detail: 'connect_timeout', nextAttemptAt: null });
  });

  it('never throws from tick, and the next tick still runs', async () => {
    const { db, sender, s, clock } = setup();
    const prepare = vi.spyOn(db, 'prepare').mockImplementationOnce(() => {
      throw new Error('database is locked');
    });
    clock.set(IST('06:00'));
    await expect(s.tick(clock.now())).resolves.toBeUndefined();
    expect(sender.calls).toHaveLength(0);
    prepare.mockRestore();
    await s.tick(clock.now());
    expect(sender.calls).toHaveLength(1);
    expect(reportFor(db, DAY)!.status).toBe('sent');
  });

  it('never throws from tick when the database is closed', async () => {
    const { db, s, clock } = setup();
    db.close();
    clock.set(IST('06:00'));
    await expect(s.tick(clock.now())).resolves.toBeUndefined();
  });
});

describe('describeReport', () => {
  const row = (o: Partial<ReportRow>): ReportRow => ({
    date: DAY, status: 'sent', detail: null, attempts: 1, nextAttemptAt: null, forced: false, createdAt: iso('06:00'), updatedAt: iso('06:01'), ...o,
  });
  const now = new Date(IST('07:00'));

  it('describes each state in plain words', () => {
    expect(describeReport(undefined, new Date(IST('05:00')), ON, 'idle').text).toBe('Morning report: due at 06:00 IST');
    expect(describeReport(undefined, now, ON, 'idle').text).toBe('Morning report: due now');
    expect(describeReport(row({}), now, ON, 'idle')).toEqual({ text: 'Morning report: sent at 06:01 IST', warning: null });
    expect(describeReport(row({ status: 'sending' }), now, ON, 'idle').text).toBe('Morning report: sending now');
    expect(describeReport(row({ status: 'skipped', detail: 'logged_out' }), now, ON, 'idle').text).toBe(
      'Morning report skipped today (the spare number was logged out)',
    );
    expect(describeReport(row({ status: 'skipped', detail: 'something_new' }), now, ON, 'idle').text).toBe('Morning report skipped today (something_new)');
  });

  it('warns when the owner has to act: unknown outcome, or a spare number that is unlinked or refused', () => {
    expect(describeReport(row({ status: 'unknown' }), now, ON, 'idle').warning).toBe(UNKNOWN_WARNING);
    expect(describeReport(undefined, now, ON, 'not_linked').warning).toContain('npm run cli -- link-sender');
    expect(describeReport(undefined, now, ON, 'logged_out').warning).toContain('link-sender --reset');
    expect(describeReport(undefined, now, ON, 'forbidden').warning).toContain('(403)');
    expect(describeReport(undefined, now, ON, 'replaced').warning).toContain('another session');
    expect(describeReport(row({ status: 'unknown' }), now, ON, 'not_linked').warning).toBe(UNKNOWN_WARNING);
    expect(describeReport(row({}), now, ON, 'idle').warning).toBeNull();
  });

  it('waits 2, 5, then 10 minutes', () => {
    expect([1, 2, 3, 4, 9].map(retryWaitMs)).toEqual([120_000, 300_000, 600_000, 600_000, 600_000]);
  });
});
