import { randomBytes } from 'node:crypto';
import ExcelJS from 'exceljs';
import type { DestinationStream } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type App, type AppReportDeps } from '../src/app.ts';
import { formatStatus } from '../src/cli/status.ts';
import { readHealthSnapshot } from '../src/health/health.ts';
import { ReportScheduler, UNKNOWN_WARNING } from '../src/report/scheduler.ts';
import type { Prices } from '../src/spend/pricing.ts';
import type { Db } from '../src/store/db.ts';
import { claimReport, reportFor } from '../src/store/reports.ts';
import { systemClock } from '../src/util/clock.ts';
import { createLogger, silentLogger, type Logger } from '../src/util/logger.ts';
import { AllowList } from '../src/wa/allowlist.ts';
import { openSessionDb, useEncryptedAuthState, useSenderAuthState } from '../src/wa/authState.ts';
import { WhatsAppGateway } from '../src/wa/gateway.ts';
import { SenderGateway } from '../src/wa/senderGateway.ts';
import { FakeAi } from './helpers/ai.ts';
import { MEHTA, seededDb, SHARMA } from './helpers/db.ts';
import { FakeDrive } from './helpers/fakeDrive.ts';
import { FakeReportSender } from './helpers/fakeReportSender.ts';
import { FakeSocket, SEND_METHODS } from './helpers/fakeSocket.ts';

const P: Prices = { inputPerMTok: 4, outputPerMTok: 20, cacheWritePerMTok: 5, cacheReadPerMTok: 0.2 };
const DAY = '2026-10-23';
const ON = { enabled: true, time: '06:00', deadline: '12:00' };

function setup(report?: AppReportDeps, db: Db = seededDb(), o: { log?: Logger; freeBytes?: () => number } = {}) {
  const sockets: FakeSocket[] = [];
  const auth = useEncryptedAuthState(openSessionDb(':memory:'), randomBytes(32));
  const allow = new AllowList([SHARMA.groupId, MEHTA.groupId]);
  const gateway = new WhatsAppGateway({
    allow,
    factory: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    auth: auth.state,
    saveCreds: auth.saveCreds,
  });
  const app = createApp({
    db, clock: systemClock, log: o.log ?? silentLogger(), gateway, allow, ai: new FakeAi(), drive: new FakeDrive(), prices: P, spendCapUsd: 15,
    quietMs: 240_000, maxWaitMs: 1_200_000, maxConcurrent: 3, dataDir: '.', freeBytes: o.freeBytes ?? (() => 500e9), pollMs: 30_000, report,
  });
  app.start();
  sockets[0]!.emit('connection.update', { connection: 'open' });
  return { db, app, sockets };
}

/** stop() ends with a final upload whose workbook build runs on fake timers: advance until it resolves. */
async function stopApp(app: App): Promise<void> {
  let done = false;
  const p = app.stop().then(() => {
    done = true;
  });
  for (let i = 0; i < 30 && !done; i++) await vi.advanceTimersByTimeAsync(1_000);
  await p;
}

describe('app and the morning report', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-23T00:30:00.000Z')); // 06:00 IST
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('sends the report from the tick at 06:00, shows it in Health, and the founder-number gateway still sends nothing', async () => {
    const sender = new FakeReportSender();
    const { db, app, sockets } = setup({ sender, settings: ON });
    for (let i = 0; i < 30 && reportFor(db, DAY)?.status !== 'sent'; i++) await vi.advanceTimersByTimeAsync(1_000);
    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0]!.fileName).toBe('Tracker-2026-10-23.xlsx');
    expect(app.report).toBeDefined();
    await vi.advanceTimersByTimeAsync(30_000); // the next tick records the line
    expect(readHealthSnapshot(db)!.report).toEqual({ text: 'Morning report: sent at 06:00 IST', warning: null, recipientMasked: '…1234' });
    for (const name of SEND_METHODS) expect(sockets[0]![name]).not.toHaveBeenCalled();
    await stopApp(app);
    expect(sender.stopped).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('turns a send cut off by a crash into unknown at start, sends nothing, and warns in Health', async () => {
    const db = seededDb();
    claimReport(db, DAY, '2026-10-23T00:29:00.000Z');
    const sender = new FakeReportSender();
    const { app } = setup({ sender, settings: ON }, db);
    expect(reportFor(db, DAY)).toMatchObject({ status: 'unknown', detail: 'interrupted' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sender.calls).toHaveLength(0);
    const snap = readHealthSnapshot(db)!;
    expect(snap.line.text).toBe(UNKNOWN_WARNING);
    expect(snap.report?.warning).toBe(UNKNOWN_WARNING);
    await stopApp(app);
  });

  it('without report settings there is no scheduler, no report row and no report line', async () => {
    const { db, app } = setup();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(app.report).toBeUndefined();
    expect(readHealthSnapshot(db)!.report).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM reports').get()).toEqual({ n: 0 });
    await stopApp(app);
  });

  it('an unreadable spare-number session leaves the founder-number reader running and asks for link-sender --reset', async () => {
    // main.ts passes auth undefined when data/sender-session.db cannot be opened or decrypted.
    const factory = vi.fn(() => new FakeSocket());
    const sender = new SenderGateway({ recipient: '919800000000', factory, auth: undefined });
    const { db, app, sockets } = setup({ sender, settings: ON });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(factory).not.toHaveBeenCalled(); // the spare number is never connected
    expect(reportFor(db, DAY)).toMatchObject({ status: 'retry', detail: 'session_unreadable' });
    const snap = readHealthSnapshot(db)!;
    expect(snap.whatsapp.state).toBe('open'); // the founder-number reader is unaffected
    expect(snap.line.text).toContain('npm run cli -- link-sender --reset');
    expect(snap.report?.warning).toBe(snap.line.text);
    expect(snap.report?.text).toContain("the spare number's saved session cannot be read");
    const out = formatStatus({ snapshot: snap, clients: [], batches: [], unprocessed: new Map(), now: new Date() });
    expect(out).toContain('Health:      ⚠️ Morning report:');
    expect(out).toContain('link-sender --reset');
    expect(out).toContain("Report:      Morning report: not sent yet (the spare number's saved session cannot be read)");
    for (const name of SEND_METHODS) expect(sockets[0]![name]).not.toHaveBeenCalled();
    await stopApp(app);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop() waits for a report still being sent, so the row is sent before main.ts closes the databases', async () => {
    const sender = new FakeReportSender();
    let release!: () => void;
    sender.gate = new Promise<void>((r) => {
      release = r;
    });
    const { db, app } = setup({ sender, settings: ON });
    for (let i = 0; i < 30 && sender.calls.length === 0; i++) await vi.advanceTimersByTimeAsync(1_000);
    expect(sender.calls).toHaveLength(1);
    let done = false;
    let statusAtStop: string | undefined;
    const p = app.stop().then(() => {
      statusAtStop = reportFor(db, DAY)?.status; // main.ts closes the tracker database right here
      done = true;
    });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(done).toBe(false);
    expect(reportFor(db, DAY)?.status).toBe('sending');
    release();
    for (let i = 0; i < 30 && !done; i++) await vi.advanceTimersByTimeAsync(1_000);
    await p;
    expect(statusAtStop).toBe('sent');
    expect(sender.stopped).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop() gives a send that never ends a bounded wait, then resolves with the row still sending', async () => {
    const sender = new FakeReportSender();
    sender.gate = new Promise<void>(() => {});
    const { db, app } = setup({ sender, settings: ON });
    for (let i = 0; i < 30 && sender.calls.length === 0; i++) await vi.advanceTimersByTimeAsync(1_000);
    expect(sender.calls).toHaveLength(1);
    let done = false;
    const t0 = Date.now();
    let elapsed = 0;
    const p = app.stop().then(() => {
      elapsed = Date.now() - t0;
      done = true;
    });
    await vi.advanceTimersByTimeAsync(9_000);
    expect(done).toBe(false);
    for (let i = 0; i < 30 && !done; i++) await vi.advanceTimersByTimeAsync(1_000);
    await p;
    expect(elapsed).toBeGreaterThanOrEqual(10_000);
    expect(elapsed).toBeLessThanOrEqual(13_000);
    expect(reportFor(db, DAY)?.status).toBe('sending'); // the next start marks it unknown, never sent again
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a real sender stopped during its 15 s linger still records the report as sent before stop() resolves', async () => {
    const sockets: FakeSocket[] = [];
    const factory = () => {
      const s = new FakeSocket();
      let n = 0;
      s.sendMessage.mockImplementation(async () => ({ key: { id: `msg-${++n}` } }));
      sockets.push(s);
      queueMicrotask(() => s.emit('connection.update', { connection: 'open' }));
      return s;
    };
    const auth = { ...useSenderAuthState(openSessionDb(':memory:'), randomBytes(32)), hasSession: true };
    const sender = new SenderGateway({ recipient: '919800000000', factory, auth }); // production timeouts and linger
    const { db, app } = setup({ sender, settings: ON });
    for (let i = 0; i < 30 && (sockets[0]?.sendMessage.mock.calls.length ?? 0) < 2; i++) await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets[0]!.sendMessage).toHaveBeenCalledTimes(2);
    let done = false;
    let statusAtStop: string | undefined;
    const p = app.stop().then(() => {
      statusAtStop = reportFor(db, DAY)?.status;
      done = true;
    });
    for (let i = 0; i < 30 && !done; i++) await vi.advanceTimersByTimeAsync(1_000);
    await p;
    expect(statusAtStop).toBe('sent');
    expect(sockets[0]!.end).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop() stays bounded when the spare-number socket never closes and the document send never answers', async () => {
    const sockets: FakeSocket[] = [];
    const factory = () => {
      const s = new FakeSocket();
      s.end.mockImplementation(() => new Promise<void>(() => {})); // ws.close() on a dead network
      s.sendMessage
        .mockImplementationOnce(async () => ({ key: { id: 'msg-1' } }))
        .mockImplementationOnce(() => new Promise(() => {}));
      sockets.push(s);
      queueMicrotask(() => s.emit('connection.update', { connection: 'open' }));
      return s;
    };
    const auth = { ...useSenderAuthState(openSessionDb(':memory:'), randomBytes(32)), hasSession: true };
    const sender = new SenderGateway({ recipient: '919800000000', factory, auth }); // production timeouts and linger
    const { db, app } = setup({ sender, settings: ON });
    for (let i = 0; i < 30 && (sockets[0]?.sendMessage.mock.calls.length ?? 0) < 2; i++) await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets[0]!.sendMessage).toHaveBeenCalledTimes(2);
    let done = false;
    const t0 = Date.now();
    let elapsed = 0;
    void app.stop().then(() => {
      elapsed = Date.now() - t0;
      done = true;
    });
    // 10 s for the send in flight, 3 s to close the socket, 2 s to record the outcome; the founder-number gateway's 5 s.
    for (let i = 0; i < 25 && !done; i++) await vi.advanceTimersByTimeAsync(1_000);
    expect(done).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(10_000);
    expect(elapsed).toBeLessThanOrEqual(10_000 + 3_000 + 2_000 + 5_000);
    expect(reportFor(db, DAY)?.status).toBe('sending'); // the next start marks it unknown, never sent again
    await vi.advanceTimersByTimeAsync(120_000); // the document send's own limit ends it
    expect(reportFor(db, DAY)).toMatchObject({ status: 'unknown', detail: 'timeout' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a recovery that failed at start is tried again at the next tick: the cut-off send becomes unknown, nothing is sent', async () => {
    const db = seededDb();
    claimReport(db, DAY, '2026-10-23T00:29:00.000Z');
    vi.spyOn(ReportScheduler.prototype, 'recover').mockImplementationOnce(() => {
      throw new Error('database is locked');
    });
    const sender = new FakeReportSender();
    const { app } = setup({ sender, settings: ON }, db);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reportFor(db, DAY)).toMatchObject({ status: 'unknown', detail: 'interrupted' });
    expect(sender.calls).toHaveLength(0);
    const snap = readHealthSnapshot(db)!;
    expect(snap.line.text).toBe(UNKNOWN_WARNING);
    expect(snap.report?.warning).toBe(UNKNOWN_WARNING);
    await stopApp(app);
  });

  it("the report's workbook carries the live Health line", async () => {
    const sender = new FakeReportSender();
    const { db, app } = setup({ sender, settings: ON }, seededDb(), { freeBytes: () => 2e9 });
    for (let i = 0; i < 30 && reportFor(db, DAY)?.status !== 'sent'; i++) await vi.advanceTimersByTimeAsync(1_000);
    expect(sender.calls).toHaveLength(1);
    const live = app.health.workbookLine().text;
    await stopApp(app);
    vi.useRealTimers(); // reading the xlsx back needs real timers
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(sender.calls[0]!.xlsx as unknown as ExcelJS.Buffer);
    const cell = wb.getWorksheet('Overview')!.getRow(1).getCell(1).value;
    expect(cell).toBe('⚠️ Low disk: 2.0 GB free');
    expect(cell).toBe(live);
  });

  it('a failed recovery at start is logged and the founder-number reader still connects', async () => {
    vi.spyOn(ReportScheduler.prototype, 'recover').mockImplementation(() => {
      throw new Error('database is locked');
    });
    const lines: string[] = [];
    const log = createLogger('info', { write: (s: string) => { lines.push(s); } } as unknown as DestinationStream);
    const sender = new FakeReportSender();
    const { app, sockets } = setup({ sender, settings: ON }, seededDb(), { log }); // start() did not throw
    expect(sockets).toHaveLength(1);
    expect(app.health.workbookLine().ok).toBe(true); // connected
    const errors = lines.map((l) => JSON.parse(l) as { level: number; msg: string }).filter((l) => l.level === 50);
    expect(errors.map((l) => l.msg)).toContain('morning report recovery failed');
    // While recovery keeps failing, no report is sent: a row cut off mid-send could otherwise hide a report already out.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sender.calls).toHaveLength(0);
    await stopApp(app);
  });
});
