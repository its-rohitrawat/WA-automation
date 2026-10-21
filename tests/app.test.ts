import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.ts';
import { Reconciler } from '../src/brain/reconciler.ts';
import { readHealthSnapshot } from '../src/health/health.ts';
import type { Prices } from '../src/spend/pricing.ts';
import { getKv, setKv } from '../src/store/kv.ts';
import { listTasks } from '../src/store/tasks.ts';
import { systemClock } from '../src/util/clock.ts';
import { createLogger, silentLogger, type Logger } from '../src/util/logger.ts';
import { AllowList } from '../src/wa/allowlist.ts';
import { openSessionDb, useEncryptedAuthState } from '../src/wa/authState.ts';
import { WhatsAppGateway } from '../src/wa/gateway.ts';
import { FakeAi, op } from './helpers/ai.ts';
import { MEHTA, OTHER_GROUP, seededDb, SHARMA } from './helpers/db.ts';
import { FakeDrive } from './helpers/fakeDrive.ts';
import { FakeSocket, SEND_METHODS } from './helpers/fakeSocket.ts';
import { waText } from './helpers/wa.ts';

const P: Prices = { inputPerMTok: 4, outputPerMTok: 20, cacheWritePerMTok: 5, cacheReadPerMTok: 0.2 };

/** Keeps the bytes of the last successful upload so a test can read the workbook that reached Drive. */
class CapturingDrive extends FakeDrive {
  last: Buffer | undefined;

  async createFile(name: string, mime: string, body: Buffer, parentId: string): Promise<string> {
    const id = await super.createFile(name, mime, body, parentId);
    this.last = body;
    return id;
  }

  async updateFile(id: string, mime: string, body: Buffer): Promise<void> {
    await super.updateFile(id, mime, body);
    this.last = body;
  }
}

function capturingLogger() {
  const lines: Record<string, unknown>[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      lines.push(JSON.parse(String(chunk)) as Record<string, unknown>);
      cb();
    },
  });
  return { lines, log: createLogger('info', sink) };
}

/** Column-A text of the Overview sheet, where the health line lives. Call with real timers. */
async function overviewTexts(buf: Buffer): Promise<string[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
  const out: string[] = [];
  wb.getWorksheet('Overview')!.eachRow((row) => {
    const v = row.getCell(1).value;
    if (typeof v === 'string') out.push(v);
  });
  return out;
}

function setup(o: { ai?: FakeAi; drive?: FakeDrive; log?: Logger; drainMs?: number } = {}) {
  const ai = o.ai ?? new FakeAi();
  const drive = o.drive ?? new FakeDrive();
  const db = seededDb();
  const allow = new AllowList([SHARMA.groupId, MEHTA.groupId]);
  const sockets: FakeSocket[] = [];
  const auth = useEncryptedAuthState(openSessionDb(':memory:'), randomBytes(32));
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
    db, clock: systemClock, log: o.log ?? silentLogger(), gateway, allow, ai, drive, prices: P, spendCapUsd: 15,
    quietMs: 240_000, maxWaitMs: 1_200_000, maxConcurrent: 3, dataDir: '.', freeBytes: () => 500e9, pollMs: 30_000,
    drainMs: o.drainMs,
  });
  app.start();
  const sock = sockets[0]!;
  sock.emit('connection.update', { connection: 'open' });
  return { db, ai, drive, app, sock };
}

/** Starts app.stop() and reports whether it has resolved yet. */
function stopping(app: { stop(): Promise<void> }) {
  const state = { done: false };
  const promise = app.stop().then(() => {
    state.done = true;
  });
  return { state, promise };
}

const bannerTask = () =>
  op({ op: 'add_task', side: 'us', title: 'Revise homepage banner', category: 'design', priority: 'high', deadline: '2026-10-18', sourceMessageIds: ['m1'] });

describe('app end to end', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T07:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('stores only allowed messages, reconciles them and publishes the tracker', async () => {
    const ai = new FakeAi([{ ops: [bannerTask()] }]);
    const { lines, log } = capturingLogger();
    const { db, drive, app, sock } = setup({ ai, log });
    sock.emit('messages.upsert', { type: 'notify', messages: [
      waText('m1', 'Rahul, homepage banner thoda bright karo. 18 tak chahiye.'),
      waText('x1', 'private family plans', { group: OTHER_GROUP }),
      waText('p1', 'personal chat', { group: '919811111111@s.whatsapp.net' }),
    ] });
    expect(db.prepare('SELECT wa_id FROM messages').all()).toEqual([{ wa_id: 'm1' }]);

    await vi.advanceTimersByTimeAsync(240_000);
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0]!.user).toContain('banner thoda bright');
    expect(ai.calls[0]!.user).not.toContain('private family plans');
    expect(ai.calls[0]!.user).not.toContain('personal chat');
    expect(listTasks(db, 1).map((t) => t.code)).toEqual(['SHA-001']);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(drive.created.map((f) => f.name)).toEqual(['Tracker.xlsx']);
    expect(drive.updated.length).toBeGreaterThanOrEqual(1);
    for (const name of SEND_METHODS) expect(sock[name]).not.toHaveBeenCalled();
    await app.stop();
    expect(vi.getTimerCount()).toBe(0);
    const logged = JSON.stringify(lines);
    expect(logged).not.toContain('thoda bright');
    expect(logged).not.toContain('private family plans');
    expect(logged).not.toContain('personal chat');
  });

  it('applies a new allow-list without a restart', async () => {
    const { db, app, sock } = setup();
    app.reloadClients([SHARMA]);
    sock.emit('messages.upsert', { type: 'notify', messages: [waText('z1', 'Mehta message', { group: MEHTA.groupId })] });
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE wa_id = 'z1'").get()).toEqual({ n: 0 });
    await app.stop();
  });

  it('republishes when the CLI requests a rebuild', async () => {
    const { db, drive, app } = setup();
    await vi.advanceTimersByTimeAsync(1_000);
    const before = drive.uploads;
    setKv(db, 'rebuild_requested', new Date().toISOString());
    await vi.advanceTimersByTimeAsync(90_000);
    expect(drive.uploads).toBeGreaterThan(before);
    expect(getKv(db, 'rebuild_requested')).toBe('');
    await app.stop();
  });
});

describe('app shutdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T07:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('waits for an AI call in flight and applies the paid result before stopping', async () => {
    const ai = new FakeAi([{ ops: [bannerTask()] }]);
    let release!: () => void;
    ai.gate = new Promise<void>((r) => {
      release = r;
    });
    const { db, app, sock } = setup({ ai });
    sock.emit('messages.upsert', { type: 'notify', messages: [waText('m1', 'Rahul, homepage banner thoda bright karo.')] });
    await vi.advanceTimersByTimeAsync(240_000);
    expect(ai.calls).toHaveLength(1);

    const stop = stopping(app);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stop.state.done).toBe(false);
    expect(listTasks(db, 1)).toEqual([]);

    release();
    await stop.promise;
    expect(listTasks(db, 1).map((t) => t.code)).toEqual(['SHA-001']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE processed_at IS NULL').get()).toEqual({ n: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives up on a hung AI call after 120 seconds by default', async () => {
    const ai = new FakeAi();
    ai.gate = new Promise<void>(() => {});
    const { app, sock } = setup({ ai });
    sock.emit('messages.upsert', { type: 'notify', messages: [waText('m1', 'hello')] });
    await vi.advanceTimersByTimeAsync(240_000);
    expect(ai.calls).toHaveLength(1);

    const stop = stopping(app);
    await vi.advanceTimersByTimeAsync(119_000);
    expect(stop.state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stop.state.done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives up on a hung AI call after drainMs', async () => {
    const ai = new FakeAi();
    ai.gate = new Promise<void>(() => {});
    const { app, sock } = setup({ ai, drainMs: 5_000 });
    sock.emit('messages.upsert', { type: 'notify', messages: [waText('m1', 'hello')] });
    await vi.advanceTimersByTimeAsync(240_000);

    const stop = stopping(app);
    await vi.advanceTimersByTimeAsync(4_900);
    expect(stop.state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(stop.state.done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits at most 10 seconds for a hung Drive upload', async () => {
    const drive = new FakeDrive();
    drive.gate = new Promise<void>(() => {});
    const { app } = setup({ drive });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(drive.folders).toEqual(['WA Agent']); // the upload itself is hanging

    const stop = stopping(app);
    await vi.advanceTimersByTimeAsync(9_900);
    expect(stop.state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(stop.state.done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('app allow-list changes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T07:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('cancels a removed group: no AI call and no reconcile run for it', async () => {
    const run = vi.spyOn(Reconciler.prototype, 'run');
    const { db, ai, app, sock } = setup();
    sock.emit('messages.upsert', { type: 'notify', messages: [waText('z1', 'Mehta message', { group: MEHTA.groupId })] });
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE wa_id = 'z1'").get()).toEqual({ n: 1 });

    app.reloadClients([SHARMA]);
    await vi.advanceTimersByTimeAsync(1_300_000);
    expect(ai.calls).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    await app.stop();
  });

  it('clears the health warning of a failed group once it is removed', async () => {
    const { db, app, sock } = setup({ ai: new FakeAi([new Error('boom')]) });
    sock.emit('messages.upsert', { type: 'notify', messages: [waText('z1', 'Mehta message', { group: MEHTA.groupId })] });
    await vi.advanceTimersByTimeAsync(240_000);
    expect(app.health.line()).toEqual({ ok: false, text: '⚠️ 1 group waiting (AI error)' });

    app.reloadClients([SHARMA]);
    expect(app.health.line().ok).toBe(true);
    expect(readHealthSnapshot(db)!.failed).toEqual([]);
    await app.stop();
  });
});

describe('app health and publishing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T07:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('publishes after a failed reconcile so the workbook shows the problem', async () => {
    const drive = new CapturingDrive();
    const { app, sock } = setup({ ai: new FakeAi([new Error('boom')]), drive });
    sock.emit('messages.upsert', { type: 'notify', messages: [waText('m1', 'hello')] });
    await vi.advanceTimersByTimeAsync(239_000);
    expect(drive.uploads).toBe(1);

    await vi.advanceTimersByTimeAsync(2_000); // the reconcile fails at 240 s
    await vi.advanceTimersByTimeAsync(30_000);
    expect(drive.uploads).toBe(2);
    await app.stop();

    vi.useRealTimers();
    expect(await overviewTexts(drive.last!)).toContain('⚠️ 1 group waiting (AI error)');
  });

  it('logs a crashed reconcile without its message, records it and publishes', async () => {
    vi.spyOn(Reconciler.prototype, 'run').mockRejectedValueOnce(new Error('Rahul said the secret banner text'));
    const { lines, log } = capturingLogger();
    const { db, drive, app, sock } = setup({ log });
    sock.emit('messages.upsert', { type: 'notify', messages: [waText('m1', 'hello')] });
    await vi.advanceTimersByTimeAsync(239_000);
    expect(drive.uploads).toBe(1);

    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(30_000);
    const crash = lines.find((l) => l.msg === 'reconcile crashed');
    expect(crash).toMatchObject({ clientId: 1, err: { type: 'Error' } });
    expect(JSON.stringify(lines)).not.toContain('secret banner text');
    expect(readHealthSnapshot(db)!.failed).toEqual([{ clientId: 1, errorCode: 'crash' }]);
    expect(drive.uploads).toBe(2);
    await app.stop();
  });

  it('keeps ticking when saving the health snapshot fails', async () => {
    const { lines, log } = capturingLogger();
    const { db, drive, app } = setup({ log });
    await vi.advanceTimersByTimeAsync(1_000);
    const persist = vi.spyOn(app.health, 'persist').mockImplementation(() => {
      throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(lines.filter((l) => l.msg === 'tick failed')).toHaveLength(1);
    const before = drive.uploads;
    setKv(db, 'rebuild_requested', new Date().toISOString());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(lines.filter((l) => l.msg === 'tick failed').length).toBeGreaterThanOrEqual(2);
    expect(lines.find((l) => l.msg === 'tick failed')).toMatchObject({ err: { type: 'Error', code: 'SQLITE_BUSY' } });
    expect(getKv(db, 'rebuild_requested')).toBe('');
    expect(drive.uploads).toBeGreaterThan(before);

    persist.mockRestore();
    await app.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports Drive failures in health, keeps them out of the uploaded workbook, and clears them after an upload', async () => {
    const drive = new CapturingDrive();
    const { db, app } = setup({ drive });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(drive.created).toHaveLength(1);

    drive.failUpdateWith = Object.assign(new Error('Unauthorized'), { code: 401 });
    const failed = app.publisher.publishNow();
    await vi.advanceTimersByTimeAsync(1_000);
    await failed;
    expect(app.health.line()).toEqual({ ok: false, text: '❌ Google sign-in expired. Run: npm run cli -- google-auth' });
    expect(readHealthSnapshot(db)!.publishFailingSince).not.toBeNull();

    drive.failUpdateWith = undefined;
    await vi.advanceTimersByTimeAsync(60_000); // the publisher's backoff retry
    expect(drive.updated).toHaveLength(1);
    expect(app.health.line().ok).toBe(true);
    expect(readHealthSnapshot(db)!.publishFailingSince).toBeNull();
    await app.stop();

    vi.useRealTimers();
    const texts = await overviewTexts(drive.last!);
    expect(texts.some((t) => t.startsWith('✅'))).toBe(true);
    expect(texts.join('\n')).not.toContain('Google sign-in');
  });
});
