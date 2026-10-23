import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type App, type AppReportDeps } from '../src/app.ts';
import { formatStatus } from '../src/cli/status.ts';
import { readHealthSnapshot } from '../src/health/health.ts';
import { UNKNOWN_WARNING } from '../src/report/scheduler.ts';
import type { Prices } from '../src/spend/pricing.ts';
import type { Db } from '../src/store/db.ts';
import { claimReport, reportFor } from '../src/store/reports.ts';
import { systemClock } from '../src/util/clock.ts';
import { silentLogger } from '../src/util/logger.ts';
import { AllowList } from '../src/wa/allowlist.ts';
import { openSessionDb, useEncryptedAuthState } from '../src/wa/authState.ts';
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

function setup(report?: AppReportDeps, db: Db = seededDb()) {
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
    db, clock: systemClock, log: silentLogger(), gateway, allow, ai: new FakeAi(), drive: new FakeDrive(), prices: P, spendCapUsd: 15,
    quietMs: 240_000, maxWaitMs: 1_200_000, maxConcurrent: 3, dataDir: '.', freeBytes: () => 500e9, pollMs: 30_000, report,
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
  afterEach(() => vi.useRealTimers());

  it('sends the report from the tick at 06:00, shows it in Health, and the founder-number gateway still sends nothing', async () => {
    const sender = new FakeReportSender();
    const { db, app, sockets } = setup({ sender, settings: ON });
    for (let i = 0; i < 30 && reportFor(db, DAY)?.status !== 'sent'; i++) await vi.advanceTimersByTimeAsync(1_000);
    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0]!.fileName).toBe('Tracker-2026-10-23.xlsx');
    expect(app.report).toBeDefined();
    await vi.advanceTimersByTimeAsync(30_000); // the next tick records the line
    expect(readHealthSnapshot(db)!.report).toEqual({ text: 'Morning report: sent at 06:00 IST', warning: null });
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
});
