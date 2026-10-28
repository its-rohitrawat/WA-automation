import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { HealthLine } from '../../src/output/view.ts';
import {
  describeReport, isReportDay, reasonText, ReportScheduler, retryWaitMs, SENDER_WARNINGS, UNKNOWN_WARNING, type ReportPayload,
} from '../../src/report/scheduler.ts';
import { TRACKER_ID_KEY } from '../../src/report/morningReport.ts';
import type { ReportSettings, SendResult } from '../../src/report/types.ts';
import type { Db } from '../../src/store/db.ts';
import { getKv, setKv } from '../../src/store/kv.ts';
import {
  claimReport, finishReport, markInterruptedReports, REPORT_REQUEST_KEY, reportFor, reportRequest, retryReport, type ReportRow,
} from '../../src/store/reports.ts';
import { manualClock } from '../../src/util/clock.ts';
import { createLogger, silentLogger, type Logger } from '../../src/util/logger.ts';
import { istDate } from '../../src/util/time.ts';
import { MEHTA, seededDb, SHARMA } from '../helpers/db.ts';
import { FakeReportSender } from '../helpers/fakeReportSender.ts';

const DAY = '2026-10-23';
const IST = (hm: string) => `${DAY}T${hm}:00.000+05:30`;
const iso = (hm: string) => new Date(IST(hm)).toISOString();
const ON: ReportSettings = { enabled: true, time: '06:00', deadline: '12:00', days: 'weekdays' };
const failed = (code: string): SendResult => ({ status: 'failed', code });
/** health() also carries the masked number the sender sends to (FakeReportSender: …1234). */
const TO = { recipientMasked: '…1234' };
/** The Tracker.xlsx id the Drive publisher stores once it has uploaded the tracker, and the link the report carries. */
const TRACKER_ID = '1AbCdEfGhIjKlMnOp_qRsTuV-wxyz0123';
const LINK = `https://drive.google.com/file/d/${TRACKER_ID}/view`;

function setup(
  o: {
    settings?: ReportSettings; build?: (now: Date) => Promise<ReportPayload>; log?: Logger; healthLine?: () => HealthLine;
    /** The stored tracker id; null leaves it unset, as before the first upload. Default TRACKER_ID. */
    trackerId?: string | null;
  } = {},
) {
  const db = seededDb();
  if (o.trackerId !== null) setKv(db, TRACKER_ID_KEY, o.trackerId ?? TRACKER_ID);
  const clock = manualClock(IST('05:00'));
  const sender = new FakeReportSender();
  const s = new ReportScheduler({
    db, clock, log: o.log ?? silentLogger(), sender, settings: o.settings ?? ON, healthLine: o.healthLine ?? (() => ({ ok: true, text: '✅ Connected' })),
    build: o.build,
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

/** A logger that keeps every line it writes, as raw JSON text. */
function capturingLogger() {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    },
  });
  return { lines, log: createLogger('debug', sink) };
}

/**
 * Writes a send-now request the way `report send-now` does: the date, the row state the owner confirmed, and the time of
 * the request (an IST time today). The service honours it for 5 minutes.
 */
function request(db: Db, hm: string, date = DAY): void {
  setKv(db, REPORT_REQUEST_KEY, reportRequest(date, reportFor(db, date), new Date(IST(hm))));
}

/** Lets pending promise callbacks run, so a step that would happen at once has happened. */
const settle = () => new Promise<void>((r) => setImmediate(r));

describe('ReportScheduler', () => {
  it('sends once at 06:00: the short text with the tracker link, and records its one message id', async () => {
    const { db, sender, at } = setup();
    await at('05:59');
    expect(sender.calls).toHaveLength(0);
    expect(reportFor(db, DAY)).toBeUndefined();
    await at('06:00');
    expect(sender.calls).toEqual([{ text: `Good morning. 0 open tasks, 0 overdue. Today's tracker: ${LINK}` }]);
    expect(reportFor(db, DAY)).toMatchObject({ status: 'sent', detail: 'msg-1', attempts: 1, forced: false });
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
    expect(s.health()).toEqual({ text: 'Morning report skipped today (the service was not running in time)', warning: null, ...TO });
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

  it("a send whose outcome could not be recorded reads unknown after 10 minutes, and at the deadline becomes unknown, never skipped or sent again", async () => {
    const { db, clock, sender, s, at } = setup();
    await at('05:00'); // recovered: nothing was cut off
    const prepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      if (/SET status = @status/.test(sql)) throw new Error('disk I/O error'); // finishReport fails
      return prepare(sql);
    }) as typeof db.prepare);
    try {
      await at('06:00');
    } finally {
      spy.mockRestore();
    }
    expect(sender.calls).toHaveLength(1);
    expect(reportFor(db, DAY)!.status).toBe('sending');
    clock.set(IST('06:05'));
    expect(s.health().text).toBe('Morning report: sending now');
    for (const hm of ['06:11', '09:00', '11:59']) await at(hm);
    expect(s.health()).toEqual({ text: 'Morning report: unknown, check WhatsApp', warning: UNKNOWN_WARNING, ...TO });
    expect(reportFor(db, DAY)!.status).toBe('sending');
    await at('12:00');
    expect(reportFor(db, DAY)).toMatchObject({ status: 'unknown', detail: 'not_recorded', attempts: 1 });
    expect(reasonText('not_recorded')).toBe('the outcome could not be recorded');
    await at('12:30');
    expect(sender.calls).toHaveLength(1);
    expect(reportFor(db, DAY)!.status).toBe('unknown');
  });

  it("leaves a 'sending' row that is not yet 10 minutes old at the deadline as it is", async () => {
    const { db, at } = setup();
    await at('05:00');
    claimReport(db, DAY, iso('11:55'));
    await at('12:00');
    expect(reportFor(db, DAY)!.status).toBe('sending');
    await at('12:06');
    expect(reportFor(db, DAY)).toMatchObject({ status: 'unknown', detail: 'not_recorded' });
  });

  it('never retries an unknown outcome', async () => {
    const { db, sender, s, at } = setup();
    sender.results = [{ status: 'unknown', code: 'timeout' }];
    await at('06:00');
    for (const hm of ['06:30', '11:00', '12:30']) await at(hm);
    expect(sender.calls).toHaveLength(1);
    expect(reportFor(db, DAY)).toMatchObject({ status: 'unknown', detail: 'timeout' });
    expect(s.health()).toEqual({ text: 'Morning report: unknown, check WhatsApp', warning: UNKNOWN_WARNING, ...TO });
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

  it('counts as recovered only once the cut-off row is marked unknown: a recovery that failed runs again at the next tick', async () => {
    const { db, clock, sender, s, at } = setup();
    claimReport(db, DAY, iso('06:00')); // the previous run died while sending
    const prepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      if (/detail = 'interrupted'/.test(sql)) throw new Error('database is locked'); // markInterruptedReports fails
      return prepare(sql);
    }) as typeof db.prepare);
    clock.set(IST('06:20'));
    try {
      expect(() => s.recover(clock.now())).toThrow('database is locked');
    } finally {
      spy.mockRestore();
    }
    expect(reportFor(db, DAY)!.status).toBe('sending');
    await at('06:30');
    expect(reportFor(db, DAY)).toMatchObject({ status: 'unknown', detail: 'interrupted' });
    expect(sender.calls).toHaveLength(0);
  });

  it('does nothing when disabled, and drops a send-now request', async () => {
    const { db, sender, s, at } = setup({ settings: { ...ON, enabled: false } });
    request(db, '06:00');
    await at('06:00');
    expect(sender.calls).toHaveLength(0);
    expect(reportFor(db, DAY)).toBeUndefined();
    expect(getKv(db, REPORT_REQUEST_KEY)).toBe('');
    expect(s.health()).toEqual({ text: 'Morning report: off', warning: null, ...TO });
  });

  it('runs one send at a time', async () => {
    const { db, clock, sender, s } = setup();
    const g = gate();
    sender.gate = g.promise;
    clock.set(IST('06:00'));
    const first = s.tick(clock.now());
    await vi.waitFor(() => expect(sender.calls).toHaveLength(1));
    setKv(db, REPORT_REQUEST_KEY, `${DAY}|none|`);
    await s.tick(clock.now());
    expect(sender.calls).toHaveLength(1);
    expect(getKv(db, REPORT_REQUEST_KEY)).toBe(`${DAY}|none|`); // the second tick returned before reading the request
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
    request(db, '15:00');
    await at('15:00');
    expect(sender.calls).toHaveLength(1);
    expect(reportFor(db, DAY)).toMatchObject({ status: 'sent', forced: true, attempts: 2 });
    expect(getKv(db, REPORT_REQUEST_KEY)).toBe('');
    request(db, '15:01');
    await at('15:01');
    expect(sender.calls).toHaveLength(1);
  });

  it("a send-now request takes a 'sending' row older than 10 minutes (its outcome was lost), but not a younger one", async () => {
    const { db, sender, at } = setup();
    await at('05:00');
    claimReport(db, DAY, iso('06:00')); // the 06:00 send ran, then recording its outcome failed
    request(db, '06:05'); // too soon: the row may still be a send in progress
    await at('06:05');
    expect(sender.calls).toHaveLength(0);
    expect(reportFor(db, DAY)).toMatchObject({ status: 'sending', attempts: 1 });
    request(db, '06:15'); // status now reads unknown, and the owner confirmed that row
    await at('06:15');
    expect(sender.calls).toHaveLength(1);
    expect(reportFor(db, DAY)).toMatchObject({ status: 'sent', forced: true, attempts: 2 });
    expect(getKv(db, REPORT_REQUEST_KEY)).toBe('');
  });

  it('a send-now request confirmed before a scheduled send that ends unknown is not used: nothing is sent twice', async () => {
    const { db, clock, sender, s, at } = setup();
    const g = gate();
    sender.gate = g.promise;
    sender.results = [{ status: 'unknown', code: 'timeout' }];
    clock.set(IST('06:00'));
    const first = s.tick(clock.now());
    await vi.waitFor(() => expect(sender.calls).toHaveLength(1));
    // the owner confirmed while the CLI saw no row, and the request lands while the scheduled send is out
    setKv(db, REPORT_REQUEST_KEY, reportRequest(DAY, undefined, new Date(IST('06:00'))));
    g.release();
    await first;
    expect(reportFor(db, DAY)).toMatchObject({ status: 'unknown', detail: 'timeout' });
    await at('06:01');
    expect(sender.calls).toHaveLength(1);
    expect(reportFor(db, DAY)).toMatchObject({ status: 'unknown', detail: 'timeout', attempts: 1, forced: false });
    expect(getKv(db, REPORT_REQUEST_KEY)).toBe('');
  });

  it('ignores a send-now request whose confirmed state no longer matches the row, and the old date-only form', async () => {
    const { db, sender, at } = setup();
    claimReport(db, DAY, iso('06:00'));
    retryReport(db, DAY, 'closed', iso('06:02'), iso('06:00'));
    request(db, '06:03'); // confirmed while the row was 'retry'
    claimReport(db, DAY, iso('06:02'));
    finishReport(db, DAY, 'unknown', 'timeout', iso('06:03')); // the scheduler tried again and the outcome is unknown
    await at('06:04');
    expect(sender.calls).toHaveLength(0);
    expect(reportFor(db, DAY)).toMatchObject({ status: 'unknown', attempts: 2 });
    setKv(db, REPORT_REQUEST_KEY, DAY);
    await at('06:05');
    expect(sender.calls).toHaveLength(0);
    expect(getKv(db, REPORT_REQUEST_KEY)).toBe('');
  });

  it('clears a send-now request exactly once, as it takes it', async () => {
    const { db, sender, at } = setup();
    request(db, '05:00');
    const writes: string[] = [];
    const prepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      if (/INSERT INTO kv/.test(sql)) writes.push(sql);
      return prepare(sql);
    }) as typeof db.prepare);
    try {
      await at('05:00');
      await at('05:01');
    } finally {
      spy.mockRestore();
    }
    expect(sender.calls).toHaveLength(1);
    expect(writes).toHaveLength(1);
    expect(getKv(db, REPORT_REQUEST_KEY)).toBe('');
  });

  it('a send-now request after the deadline that fails gets one try, then the day is skipped with that reason', async () => {
    const { db, clock, sender, s } = setup();
    sender.results = [failed('connect_timeout')];
    request(db, '15:00');
    clock.set(IST('15:00'));
    await s.tick(clock.now());
    expect(reportFor(db, DAY)).toMatchObject({ status: 'retry', detail: 'connect_timeout' });
    clock.set(new Date(clock.now().getTime() + 30_000).toISOString());
    await s.tick(clock.now());
    expect(reportFor(db, DAY)).toMatchObject({ status: 'skipped', detail: 'connect_timeout' });
    expect(sender.calls).toHaveLength(1);
  });

  it('a send-now request before the report time that fails waits for the report time', async () => {
    const { db, sender, at } = setup();
    sender.results = [failed('closed')];
    request(db, '05:00');
    await at('05:00');
    expect(sender.calls).toHaveLength(1);
    await at('05:02');
    await at('05:59');
    expect(sender.calls).toHaveLength(1);
    await at('06:00');
    expect(sender.calls).toHaveLength(2);
    expect(reportFor(db, DAY)).toMatchObject({ status: 'sent', attempts: 2, forced: false });
  });

  it('uses the IST date between 00:00 and 05:30 IST, for health and for a send-now request', async () => {
    const { db, clock, sender, s } = setup();
    claimReport(db, '2026-10-22', '2026-10-22T00:30:00.000Z');
    finishReport(db, '2026-10-22', 'sent', 'msg-0', '2026-10-22T00:31:00.000Z');
    clock.set(IST('02:00'));
    expect(s.health().text).toBe('Morning report: due at 06:00 IST');
    request(db, '02:00');
    await s.tick(clock.now());
    expect(sender.calls).toHaveLength(1);
    expect(reportFor(db, DAY)).toMatchObject({ status: 'sent', forced: true });
  });

  it('without a tracker link (never uploaded, or a bad id) retries with the usual waits, then skips at the deadline, never sending', async () => {
    for (const trackerId of [null, '', 'file-1', '../../evil?x=1']) {
      const { db, sender, s, at } = setup({ trackerId });
      await at('06:00');
      expect(reportFor(db, DAY)).toMatchObject({ status: 'retry', detail: 'no_tracker_link', attempts: 1, nextAttemptAt: iso('06:02') });
      expect(s.health()).toEqual({
        text: 'Morning report: not sent yet (the tracker is not on Google Drive yet (run google-auth and let it upload once)), next try 06:02 IST',
        warning: null,
        ...TO,
      });
      await at('06:02');
      expect(reportFor(db, DAY)).toMatchObject({ status: 'retry', detail: 'no_tracker_link', attempts: 2, nextAttemptAt: iso('06:07') });
      await at('06:07');
      expect(reportFor(db, DAY)!.nextAttemptAt).toBe(iso('06:17'));
      await at('12:00');
      expect(reportFor(db, DAY)).toMatchObject({ status: 'skipped', detail: 'no_tracker_link' });
      expect(s.health().text).toBe('Morning report skipped today (the tracker is not on Google Drive yet (run google-auth and let it upload once))');
      await at('12:30');
      expect(sender.calls).toHaveLength(0);
    }
    expect(reasonText('no_tracker_link')).toBe('the tracker is not on Google Drive yet (run google-auth and let it upload once)');
  });

  it('sends once the tracker has been uploaded after a no_tracker_link try', async () => {
    const { db, sender, at } = setup({ trackerId: null });
    await at('06:00');
    expect(reportFor(db, DAY)).toMatchObject({ status: 'retry', detail: 'no_tracker_link' });
    setKv(db, TRACKER_ID_KEY, TRACKER_ID); // the Drive publisher uploads the tracker
    await at('06:02');
    expect(sender.calls).toEqual([{ text: `Good morning. 0 open tasks, 0 overdue. Today's tracker: ${LINK}` }]);
    expect(reportFor(db, DAY)).toMatchObject({ status: 'sent', detail: 'msg-1', attempts: 2 });
  });

  it('records the time the send finished, not the time it started', async () => {
    for (const fails of [false, true]) {
      const one = setup();
      one.sender.results = fails ? [failed('connect_timeout')] : [];
      const send = one.sender.sendReport.bind(one.sender);
      one.sender.sendReport = async (text) => {
        one.clock.set(IST('06:03')); // a slow connect
        return send(text);
      };
      await one.at('06:00');
      const row = reportFor(one.db, DAY)!;
      expect(row.updatedAt).toBe(iso('06:03'));
      if (fails) expect(row).toMatchObject({ status: 'retry', nextAttemptAt: iso('06:05') });
      else expect(row.status).toBe('sent');
    }
  });

  it('ignores a send-now request left from an earlier day', async () => {
    const { db, sender, at } = setup();
    setKv(db, REPORT_REQUEST_KEY, reportRequest('2026-10-22', undefined, new Date(IST('15:00'))));
    await at('15:00');
    expect(sender.calls).toHaveLength(0);
    expect(getKv(db, REPORT_REQUEST_KEY)).toBe('');
  });

  it('a send-now request expires after 5 minutes: an older one (left behind by a stopping service) is ignored and cleared', async () => {
    const fresh = setup();
    request(fresh.db, '05:00');
    await fresh.at('05:05'); // exactly 5 minutes: still honoured
    expect(fresh.sender.calls).toHaveLength(1);

    const { lines, log } = capturingLogger();
    const old = setup({ log });
    request(old.db, '05:00'); // written while the service was stopping; it starts again 10 minutes later
    await old.at('05:10');
    expect(old.sender.calls).toHaveLength(0);
    expect(reportFor(old.db, DAY)).toBeUndefined();
    expect(getKv(old.db, REPORT_REQUEST_KEY)).toBe('');
    const line = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => String(l.msg).includes('expired'));
    expect(line).toBeDefined();
    expect(Object.keys(line!).sort()).toEqual(['date', 'level', 'msg', 'time']);
    expect(line!.date).toBe(DAY);

    // A request without its time (the form before requests expired) is never honoured either.
    const untimed = setup();
    setKv(untimed.db, REPORT_REQUEST_KEY, `${DAY}|none|`);
    await untimed.at('05:00');
    expect(untimed.sender.calls).toHaveLength(0);
    expect(getKv(untimed.db, REPORT_REQUEST_KEY)).toBe('');
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
    request(db, '06:30');
    await at('06:30');
    expect(sender.calls).toHaveLength(1);
  });

  it('starts no new send once stopped, also on a send-now request', async () => {
    const { db, sender, s, at } = setup();
    await s.stop(1_000);
    expect(sender.stopped).toBe(1);
    request(db, '06:00');
    await at('06:00');
    await at('07:00');
    expect(sender.calls).toHaveLength(0);
    expect(reportFor(db, DAY)).toBeUndefined();
  });

  it('stop leaves no timer once the send in flight has finished', async () => {
    const { clock, sender, s } = setup();
    const g = gate();
    sender.gate = g.promise;
    clock.set(IST('06:00'));
    const first = s.tick(clock.now());
    await vi.waitFor(() => expect(sender.calls).toHaveLength(1));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const stopping = s.stop(5_000);
      expect(vi.getTimerCount()).toBe(1);
      g.release();
      await stopping;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    await first;
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

  it('after stopping the sender, waits briefly for the send it ended, so a report in its linger is recorded as sent', async () => {
    const { db, clock, sender, s } = setup();
    let release!: () => void;
    sender.gate = new Promise<void>((r) => {
      release = r;
    });
    // Like SenderGateway: stop() ends the linger, and the send resolves 'sent' a moment later.
    sender.stop = async () => {
      sender.stopped++;
      setTimeout(release, 30);
    };
    clock.set(IST('06:00'));
    void s.tick(clock.now());
    await vi.waitFor(() => expect(sender.calls).toHaveLength(1));
    await s.stop(50);
    expect(sender.stopped).toBe(1);
    expect(reportFor(db, DAY)?.status).toBe('sent');
  });

  it('claims the row before the send goes out', async () => {
    const { db, sender, at } = setup();
    const seen: (ReportRow | undefined)[] = [];
    const send = sender.sendReport.bind(sender);
    sender.sendReport = async (text) => {
      seen.push(reportFor(db, DAY));
      return send(text);
    };
    await at('06:00');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ status: 'sending', attempts: 1 });
  });

  it('a crash and restart during a send leaves the day unknown, and it is not sent again', async () => {
    const { db, clock, sender, s, at } = setup();
    const g = gate();
    sender.gate = g.promise;
    clock.set(IST('06:00'));
    const first = s.tick(clock.now());
    await vi.waitFor(() => expect(sender.calls).toHaveLength(1));
    expect(markInterruptedReports(db, iso('06:01'))).toBe(1); // what a restart finds while the send is out
    g.release();
    await first;
    await at('06:30');
    expect(sender.calls).toHaveLength(1);
    expect(reportFor(db, DAY)).toMatchObject({ status: 'unknown', detail: 'interrupted' });
  });

  it('stop during the build starts no send and leaves the day to retry', async () => {
    const g = gate();
    let built = false;
    const build = async (): Promise<ReportPayload> => {
      await g.promise;
      built = true;
      return { text: 'report text' };
    };
    const { db, clock, sender, s } = setup({ build });
    clock.set(IST('06:00'));
    const first = s.tick(clock.now());
    await settle();
    expect(reportFor(db, DAY)!.status).toBe('sending');
    const stopping = s.stop(5_000);
    await settle();
    g.release();
    await Promise.all([stopping, first]);
    expect(built).toBe(true);
    expect(sender.calls).toHaveLength(0);
    expect(reportFor(db, DAY)).toMatchObject({ status: 'retry', detail: 'stopped' });
    expect(sender.stopped).toBe(1);
  });

  it('stop resolves even when stopping the sender fails', async () => {
    const { sender, s } = setup();
    sender.stop = async () => {
      throw new Error('socket already closed');
    };
    await expect(s.stop(100)).resolves.toBeUndefined();
  });

  it("health shows the sender's warning when the owner has to act", () => {
    const { sender, s, clock } = setup();
    clock.set(IST('07:00'));
    sender.state = { ...sender.state, state: 'not_linked' };
    expect(s.health().warning).toContain('npm run cli -- link-sender');
    sender.state = { ...sender.state, state: 'logged_out' };
    expect(s.health().warning).toContain('link-sender --reset');
    sender.state = { ...sender.state, state: 'idle' };
    expect(s.health().warning).toBeNull();
  });

  it("health carries the sender's masked recipient (last 4 digits only), so the CLI can compare it with .env", () => {
    const { sender, s } = setup();
    sender.recipientMasked = '…9876';
    expect(s.health().recipientMasked).toBe('…9876');
  });

  it('logs only dates, codes, times and counts: never the report text, a client name or the file name', async () => {
    const { lines, log } = capturingLogger();
    const allowed = new Set(['level', 'time', 'msg', 'date', 'code', 'nextAttemptAt', 'count', 'reason', 'err']);
    const texts: string[] = [];
    const check = () => {
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        for (const t of texts) expect(line).not.toContain(t);
        for (const bad of [SHARMA.name, MEHTA.name, 'Sharma', 'Mehta', 'Tracker-', 'Good morning', TRACKER_ID, 'drive.google', 'msg-1']) {
          expect(line).not.toContain(bad);
        }
        for (const key of Object.keys(JSON.parse(line) as object)) expect(allowed).toContain(key);
      }
    };

    // sent, then failed (retry), then unknown, then a sender crash
    for (const results of [[], [failed('connect_timeout')], [{ status: 'unknown', code: 'timeout' } as SendResult]]) {
      const one = setup({ log });
      one.sender.results = results;
      await one.at('06:00');
      texts.push(...one.sender.calls.map((c) => c.text));
    }
    const crash = setup({ log });
    crash.sender.throwNext = true;
    await crash.at('06:00');
    texts.push(...crash.sender.calls.map((c) => c.text));

    // a build failure whose error message names a client and the file
    const broken = setup({ log, build: async () => Promise.reject(new Error(`Sharma Interiors Tracker-${DAY}.xlsx`)) });
    await broken.at('06:00');

    // no tracker link yet: a retry, then skipped at the deadline
    const noLink = setup({ log, trackerId: null });
    await noLink.at('06:00');
    await noLink.at('12:00');

    // skipped after the deadline, and a crash mid-send found at start
    const late = setup({ log });
    await late.at('12:00');
    const cut = setup({ log });
    claimReport(cut.db, DAY, iso('06:00'));
    cut.s.recover(new Date(IST('06:20')));

    expect(texts.length).toBeGreaterThan(0);
    expect(lines.length).toBeGreaterThanOrEqual(7);
    check();
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
    expect(describeReport(row({ status: 'sending', updatedAt: iso('06:59') }), now, ON, 'idle')).toEqual({ text: 'Morning report: sending now', warning: null });
    expect(describeReport(row({ status: 'skipped', detail: 'logged_out' }), now, ON, 'idle').text).toBe(
      'Morning report skipped today (the spare number was logged out)',
    );
    expect(describeReport(row({ status: 'skipped', detail: 'something_new' }), now, ON, 'idle').text).toBe('Morning report skipped today (something_new)');
  });

  it("a row left 'sending' for more than 10 minutes (its outcome was never recorded) reads unknown, with the warning", () => {
    expect(describeReport(row({ status: 'sending', updatedAt: iso('06:50') }), now, ON, 'idle')).toEqual({ text: 'Morning report: sending now', warning: null });
    const stale = { text: 'Morning report: unknown, check WhatsApp', warning: UNKNOWN_WARNING };
    expect(describeReport(row({ status: 'sending', updatedAt: iso('06:49') }), now, ON, 'idle')).toEqual(stale);
    expect(describeReport(row({ status: 'sending', updatedAt: iso('06:01') }), now, ON, 'not_linked')).toEqual(stale);
  });

  it('a retry whose next try would be at or after the deadline says the day will be skipped, never a next try', () => {
    const late = new Date(IST('11:55'));
    const r = (next: string) => describeReport(row({ status: 'retry', detail: 'connect_timeout', nextAttemptAt: next }), late, ON, 'idle').text;
    expect(r(iso('11:59'))).toBe('Morning report: not sent yet (could not connect to WhatsApp), next try 11:59 IST');
    const skipped = 'Morning report: not sent yet (could not connect to WhatsApp); no more tries today, it will be skipped at 12:00 IST';
    expect(r(iso('12:00'))).toBe(skipped);
    expect(r(iso('12:05'))).toBe(skipped);
    expect(r('2026-10-23T18:35:00.000Z')).toBe(skipped); // 00:05 IST the next day: after the deadline, though its time reads earlier
  });

  it('warns when the owner has to act: unknown outcome, or a spare number that is unlinked or refused', () => {
    expect(describeReport(row({ status: 'unknown' }), now, ON, 'idle').warning).toBe(UNKNOWN_WARNING);
    expect(describeReport(undefined, now, ON, 'not_linked').warning).toContain('npm run cli -- link-sender');
    expect(describeReport(undefined, now, ON, 'logged_out').warning).toContain('link-sender --reset');
    expect(describeReport(undefined, now, ON, 'unreadable').warning).toContain('npm run cli -- link-sender --reset');
    expect(describeReport(row({ status: 'retry', detail: 'session_unreadable' }), now, ON, 'unreadable').text).toContain(
      "not sent yet (the spare number's saved session cannot be read)",
    );
    const unavailable = describeReport(row({ status: 'retry', detail: 'session_unavailable' }), now, ON, 'unavailable');
    expect(unavailable.warning).toContain("the spare number's session file could not be opened (disk, permissions or a lock). Restart the service");
    expect(unavailable.warning).not.toContain('--reset');
    expect(unavailable.text).toContain("not sent yet (the spare number's session file could not be opened)");
    expect(describeReport(undefined, now, ON, 'forbidden').warning).toContain('(403)');
    expect(describeReport(undefined, now, ON, 'replaced').warning).toContain('another session');
    expect(describeReport(row({ status: 'unknown' }), now, ON, 'not_linked').warning).toBe(UNKNOWN_WARNING);
    expect(describeReport(row({}), now, ON, 'idle').warning).toBeNull();
  });

  it("warns and explains when the sender is linked to the founder's own number (self_send)", () => {
    const h = describeReport(undefined, now, ON, 'self_send');
    expect(h.warning).toBe(SENDER_WARNINGS.self_send);
    expect(h.warning).toBe(
      "⚠️ Morning report: the sender is linked to the founder's own number. Stop the service and run: npm run cli -- link-sender --reset, then scan with the SPARE phone",
    );
    expect(reasonText('self_send')).toBe("the sender is linked to the founder's own number; re-link with the spare phone");
    expect(describeReport(row({ status: 'retry', detail: 'self_send', nextAttemptAt: iso('07:02') }), now, ON, 'self_send')).toEqual({
      text: "Morning report: not sent yet (the sender is linked to the founder's own number; re-link with the spare phone), next try 07:02 IST",
      warning: SENDER_WARNINGS.self_send,
    });
    expect(describeReport(row({ status: 'skipped', detail: 'self_send' }), now, ON, 'self_send').text).toBe(
      "Morning report skipped today (the sender is linked to the founder's own number; re-link with the spare phone)",
    );
  });

  it('explains a connection that could not be started in plain words', () => {
    expect(reasonText('connect_error')).toBe('the WhatsApp connection could not be started');
  });

  it('waits 2, 5, then 10 minutes', () => {
    expect([0, 1, 2, 3, 4, 9].map(retryWaitMs)).toEqual([120_000, 120_000, 300_000, 600_000, 600_000, 600_000]);
  });
});

describe('report days (REPORT_DAYS)', () => {
  const FRI = '2026-10-30';
  const SAT = '2026-10-31';
  const SUN = '2026-11-01';
  const MON = '2026-11-02';
  const at = (date: string, hm: string) => new Date(`${date}T${hm}:00.000+05:30`);

  it('reads the weekday of the IST date, also at the IST midnight edge', () => {
    // 2026-10-30 23:59 IST is Friday; one minute later (18:30 UTC the same UTC day) it is Saturday in India.
    expect(istDate(at(FRI, '23:59'))).toBe(FRI);
    expect(istDate(new Date('2026-10-30T18:30:00.000Z'))).toBe(SAT);
    expect(isReportDay(istDate(at(FRI, '23:59')), 'weekdays')).toBe(true);
    expect(isReportDay(istDate(new Date('2026-10-30T18:30:00.000Z')), 'weekdays')).toBe(false);
    // 2026-11-01 23:59 IST is Sunday; 2026-11-02 00:00 IST (18:30 UTC on 1 Nov) is Monday.
    expect(isReportDay(istDate(at(SUN, '23:59')), 'weekdays')).toBe(false);
    expect(isReportDay(istDate(new Date('2026-11-01T18:30:00.000Z')), 'weekdays')).toBe(true);
  });

  it('weekdays is Monday to Friday, mon-sat adds Saturday, daily is every day', () => {
    const week = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']; // Monday to Sunday
    expect(week.map((d) => isReportDay(d, 'weekdays'))).toEqual([true, true, true, true, true, false, false]);
    expect(week.map((d) => isReportDay(d, 'mon-sat'))).toEqual([true, true, true, true, true, true, false]);
    expect(week.map((d) => isReportDay(d, 'daily'))).toEqual([true, true, true, true, true, true, true]);
  });

  function weekSetup(settings: ReportSettings = ON) {
    const db = seededDb();
    setKv(db, TRACKER_ID_KEY, TRACKER_ID);
    const clock = manualClock(at(SAT, '05:00').toISOString());
    const sender = new FakeReportSender();
    const s = new ReportScheduler({ db, clock, log: silentLogger(), sender, settings, healthLine: () => ({ ok: true, text: '✅ Connected' }) });
    const tick = async (date: string, hm: string) => {
      clock.set(at(date, hm).toISOString());
      await s.tick(clock.now());
    };
    return { db, clock, sender, s, tick };
  }

  it('on Saturday and Sunday the scheduled ticks at 06:00, 09:00 and after the deadline create no row and send nothing; Monday sends', async () => {
    const { db, sender, s, tick } = weekSetup();
    for (const date of [SAT, SUN]) {
      for (const hm of ['05:59', '06:00', '09:00', '11:59', '12:00', '23:59']) await tick(date, hm);
      expect(reportFor(db, date)).toBeUndefined();
    }
    expect(sender.calls).toHaveLength(0);
    expect(s.health(at(SUN, '07:00'))).toEqual({ text: 'Morning report: no report today (weekend)', warning: null, ...TO });
    await tick(MON, '06:00');
    expect(sender.calls).toHaveLength(1);
    expect(reportFor(db, MON)).toMatchObject({ status: 'sent', attempts: 1, forced: false });
  });

  it('the Friday 23:59 IST tick is Friday and the 00:00 IST tick is Saturday', async () => {
    const { db, sender, tick } = weekSetup({ ...ON, time: '00:00', deadline: '23:59' });
    await tick(FRI, '23:58');
    expect(reportFor(db, FRI)!.status).toBe('sent');
    await tick(SAT, '00:00');
    expect(reportFor(db, SAT)).toBeUndefined();
    expect(sender.calls).toHaveLength(1);
  });

  it('mon-sat sends on Saturday but not on Sunday; daily sends on Sunday', async () => {
    const monSat = weekSetup({ ...ON, days: 'mon-sat' });
    await monSat.tick(SAT, '06:00');
    await monSat.tick(SUN, '06:00');
    await monSat.tick(SUN, '12:00');
    expect(monSat.sender.calls).toHaveLength(1);
    expect(reportFor(monSat.db, SAT)!.status).toBe('sent');
    expect(reportFor(monSat.db, SUN)).toBeUndefined();
    const daily = weekSetup({ ...ON, days: 'daily' });
    await daily.tick(SUN, '06:00');
    expect(reportFor(daily.db, SUN)!.status).toBe('sent');
  });

  it('a send-now request on a Sunday sends once, and is never sent a second time that day', async () => {
    const { db, sender, s, tick } = weekSetup();
    await tick(SUN, '10:00');
    expect(sender.calls).toHaveLength(0);
    setKv(db, REPORT_REQUEST_KEY, reportRequest(SUN, reportFor(db, SUN), at(SUN, '10:00')));
    await tick(SUN, '10:01');
    expect(sender.calls).toHaveLength(1);
    expect(reportFor(db, SUN)).toMatchObject({ status: 'sent', forced: true });
    expect(s.health(at(SUN, '10:02')).text).toBe('Morning report: sent at 10:01 IST');
    setKv(db, REPORT_REQUEST_KEY, reportRequest(SUN, reportFor(db, SUN), at(SUN, '10:05')));
    for (const hm of ['10:05', '10:06', '12:00']) await tick(SUN, hm);
    expect(sender.calls).toHaveLength(1);
  });

  it('a send-now request on a Sunday that fails keeps the normal retry and deadline rules for that row', async () => {
    const { db, sender, tick } = weekSetup();
    sender.results = [failed('connect_timeout'), failed('closed')];
    setKv(db, REPORT_REQUEST_KEY, reportRequest(SUN, undefined, at(SUN, '10:00')));
    await tick(SUN, '10:00');
    expect(reportFor(db, SUN)).toMatchObject({ status: 'retry', detail: 'connect_timeout' });
    await tick(SUN, '10:02');
    expect(sender.calls).toHaveLength(2);
    await tick(SUN, '12:00');
    expect(reportFor(db, SUN)).toMatchObject({ status: 'skipped', detail: 'closed' });
    expect(sender.calls).toHaveLength(2);
  });

  it('health on a non-report day says so, with no warning and no "due" promise', () => {
    for (const hm of ['00:00', '05:00', '06:30', '13:00']) {
      expect(describeReport(undefined, at(SAT, hm), ON, 'idle')).toEqual({ text: 'Morning report: no report today (weekend)', warning: null });
    }
    expect(describeReport(undefined, at(SUN, '07:00'), { ...ON, days: 'mon-sat' }, 'idle').text).toBe('Morning report: no report today (weekend)');
    expect(describeReport(undefined, at(SAT, '07:00'), { ...ON, days: 'mon-sat' }, 'idle').text).toBe('Morning report: due now');
    expect(describeReport(undefined, at(SUN, '05:00'), { ...ON, days: 'daily' }, 'idle').text).toBe('Morning report: due at 06:00 IST');
    expect(describeReport(undefined, at(MON, '05:00'), ON, 'idle').text).toBe('Morning report: due at 06:00 IST');
    // A row exists on a non-report day only after a send-now request; it is described as on any other day.
    const sent: ReportRow = {
      date: SUN, status: 'sent', detail: null, attempts: 1, nextAttemptAt: null, forced: true,
      createdAt: at(SUN, '10:00').toISOString(), updatedAt: at(SUN, '10:01').toISOString(),
    };
    expect(describeReport(sent, at(SUN, '11:00'), ON, 'idle').text).toBe('Morning report: sent at 10:01 IST');
  });

  it('on a non-report day the spare number still warns when the owner has to act before the next report', () => {
    expect(describeReport(undefined, at(SAT, '07:00'), ON, 'logged_out')).toEqual({
      text: 'Morning report: no report today (weekend)', warning: SENDER_WARNINGS.logged_out,
    });
  });
});

describe('replaceSender', () => {
  it('the next tick sends with the new sender; the old one is stopped', async () => {
    const { s, at, sender } = setup();
    const next = new FakeReportSender();
    next.recipientMasked = '…9999';
    s.replaceSender(next);
    expect(sender.stopped).toBe(1);
    await at('06:00');
    expect(sender.calls).toHaveLength(0);
    expect(next.calls).toHaveLength(1);
    expect(s.health(new Date(IST('06:01'))).recipientMasked).toBe('…9999');
  });

  it('a send in flight finishes with its own sender, which is not stopped under it', async () => {
    const { s, clock, sender } = setup();
    const g = gate();
    sender.gate = g.promise;
    clock.set(IST('06:00'));
    const tick = s.tick(clock.now());
    await vi.waitFor(() => expect(sender.calls).toHaveLength(1), { interval: 5 });
    const next = new FakeReportSender();
    s.replaceSender(next);
    expect(sender.stopped).toBe(0);
    g.release();
    await tick;
    expect(next.calls).toHaveLength(0);
  });

  it('replacing with the same sender changes nothing', () => {
    const { s, sender } = setup();
    s.replaceSender(sender);
    expect(sender.stopped).toBe(0);
  });
});
