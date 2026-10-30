import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { proto, WAMessageStubType, type WAMessageUpdate } from 'baileys';
import ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.ts';
import { MAX_OUTPUT_TOKENS } from '../src/brain/claudeClient.ts';
import { Reconciler } from '../src/brain/reconciler.ts';
import { readHealthSnapshot } from '../src/health/health.ts';
import { estimateCostUsd, type Prices } from '../src/spend/pricing.ts';
import { getKv, setKv } from '../src/store/kv.ts';
import { insertMedia, messageRowId } from '../src/store/media.ts';
import { listTasks } from '../src/store/tasks.ts';
import { systemClock } from '../src/util/clock.ts';
import { createLogger, silentLogger, type Logger } from '../src/util/logger.ts';
import { AllowList } from '../src/wa/allowlist.ts';
import { openSessionDb, useEncryptedAuthState } from '../src/wa/authState.ts';
import { WhatsAppGateway } from '../src/wa/gateway.ts';
import { FakeAi, op } from './helpers/ai.ts';
import { MEHTA, OTHER_GROUP, seededDb, SHARMA } from './helpers/db.ts';
import { FakeDrive } from './helpers/fakeDrive.ts';
import { closeWith, FakeSocket, SEND_METHODS } from './helpers/fakeSocket.ts';
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

/** Waits until the events the last setup's gateway was handed are stored (the gateway hands them over in order). */
let settled: () => Promise<void> = async () => {};

async function setup(o: { ai?: FakeAi; drive?: FakeDrive; log?: Logger; drainMs?: number } = {}) {
  const ai = o.ai ?? new FakeAi();
  const drive = o.drive ?? new FakeDrive();
  const db = await seededDb();
  const allow = new AllowList([SHARMA.groupId, MEHTA.groupId]);
  const sockets: FakeSocket[] = [];
  const auth = await useEncryptedAuthState(openSessionDb(':memory:'), randomBytes(32));
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
  settled = () => gateway.idle();
  const app = await createApp({
    db, clock: systemClock, log: o.log ?? silentLogger(), gateway, allow, ai, drive, prices: P, spendCapUsd: 15,
    quietMs: 240_000, maxWaitMs: 1_200_000, maxConcurrent: 3, dataDir: '.', freeBytes: () => 500e9, pollMs: 30_000,
    drainMs: o.drainMs,
  });
  app.start();
  const sock = sockets[0]!;
  sock.emit('connection.update', { connection: 'open' });
  return { db, ai, drive, app, sock, gateway };
}

/** A promise the test settles by hand. */
function gate<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Starts app.stop() and reports whether it has resolved yet. */
function stopping(app: { stop(): Promise<void> }) {
  const state = { done: false };
  const promise = app.stop().then(() => {
    state.done = true;
  });
  return { state, promise };
}

/** stop() ends with a final upload, and building the workbook runs on (fake) timers: advance until it resolves. */
async function finish(stop: ReturnType<typeof stopping>): Promise<void> {
  for (let i = 0; i < 30 && !stop.state.done; i++) await vi.advanceTimersByTimeAsync(1_000);
  expect(stop.state.done).toBe(true);
  await stop.promise;
}

const stopApp = (app: { stop(): Promise<void> }) => finish(stopping(app));

/** Every row of the Sharma tab as cell texts. Call with real timers. */
async function sharmaRows(buf: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
  const rows: string[][] = [];
  wb.getWorksheet('Sharma Interiors')!.eachRow((row) => {
    const cells: string[] = [];
    row.eachCell((c) => cells.push(String(c.value ?? '')));
    rows.push(cells);
  });
  return rows;
}

const bannerTask = () =>
  op({ op: 'add_task', side: 'us', title: 'Revise homepage banner', category: 'design', priority: 'major', deadline: '2026-10-18', sourceMessageIds: ['m1'] });

describe('app end to end', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T07:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('stores only allowed messages, reconciles them and publishes the tracker', async () => {
    const ai = new FakeAi([{ ops: [bannerTask()] }]);
    const { lines, log } = capturingLogger();
    const { db, drive, app, sock } = await setup({ ai, log });
    sock.emit('messages.upsert', { type: 'notify', messages: [
      waText('m1', 'Rahul, homepage banner thoda bright karo. 18 tak chahiye.'),
      waText('x1', 'private family plans', { group: OTHER_GROUP }),
      waText('p1', 'personal chat', { group: '919811111111@s.whatsapp.net' }),
    ] });
    await settled();
    expect(db.raw.prepare('SELECT wa_id FROM messages').all()).toEqual([{ wa_id: 'm1' }]);

    await vi.advanceTimersByTimeAsync(240_000);
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0]!.user).toContain('banner thoda bright');
    expect(ai.calls[0]!.user).not.toContain('private family plans');
    expect(ai.calls[0]!.user).not.toContain('personal chat');
    expect((await listTasks(db, 1)).map((t) => t.code)).toEqual(['SHA-001']);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(drive.created.map((f) => f.name)).toEqual(['Tracker.xlsx']);
    expect(drive.updated.length).toBeGreaterThanOrEqual(1);
    for (const name of SEND_METHODS) expect(sock[name]).not.toHaveBeenCalled();
    await stopApp(app);
    expect(vi.getTimerCount()).toBe(0);
    const logged = JSON.stringify(lines);
    expect(logged).not.toContain('thoda bright');
    expect(logged).not.toContain('private family plans');
    expect(logged).not.toContain('personal chat');
  });

  it('applies a new allow-list without a restart', async () => {
    const { db, app, sock } = await setup();
    await app.reloadClients([SHARMA]);
    sock.emit('messages.upsert', { type: 'notify', messages: [waText('z1', 'Mehta message', { group: MEHTA.groupId })] });
    await settled();
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM messages WHERE wa_id = 'z1'").get()).toEqual({ n: 0 });
    await stopApp(app);
  });

  it('republishes when the CLI requests a rebuild', async () => {
    const { db, drive, app } = await setup();
    await vi.advanceTimersByTimeAsync(1_000);
    const before = drive.uploads;
    await setKv(db, 'rebuild_requested', new Date().toISOString());
    await vi.advanceTimersByTimeAsync(90_000);
    expect(drive.uploads).toBeGreaterThan(before);
    expect(await getKv(db, 'rebuild_requested')).toBe('');
    await stopApp(app);
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
    const { db, app, sock } = await setup({ ai });
    sock.emit('messages.upsert', { type: 'notify', messages: [waText('m1', 'Rahul, homepage banner thoda bright karo.')] });
    await settled();
    await vi.advanceTimersByTimeAsync(240_000);
    expect(ai.calls).toHaveLength(1);

    const stop = stopping(app);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stop.state.done).toBe(false);
    expect(await listTasks(db, 1)).toEqual([]);
    expect(sock.end).not.toHaveBeenCalled(); // WhatsApp stays connected during the drain

    release();
    await finish(stop);
    expect((await listTasks(db, 1)).map((t) => t.code)).toEqual(['SHA-001']);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM messages WHERE processed_at IS NULL').get()).toEqual({ n: 0 });
    expect(sock.end).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uploads a result applied during the drain before stop resolves', async () => {
    const ai = new FakeAi([{ ops: [bannerTask()] }]);
    const g = gate();
    ai.gate = g.promise;
    const drive = new CapturingDrive();
    const { app, sock } = await setup({ ai, drive });
    sock.emit('messages.upsert', { type: 'notify', messages: [waText('m1', 'Rahul, homepage banner thoda bright karo.')] });
    await settled();
    await vi.advanceTimersByTimeAsync(239_000);
    expect(drive.uploads).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ai.calls).toHaveLength(1);

    const stop = stopping(app);
    g.resolve();
    await finish(stop);
    expect(drive.uploads).toBe(2);
    expect(vi.getTimerCount()).toBe(0);

    vi.useRealTimers();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(drive.last! as unknown as ExcelJS.Buffer);
    const codes: unknown[] = [];
    wb.getWorksheet('Sharma Interiors')!.eachRow((row) => codes.push(row.getCell(1).value));
    expect(codes).toContain('SHA-001');
  });

  it('makes one more upload after an upload in flight, so a result applied during the drain reaches Drive', async () => {
    const ai = new FakeAi([{ ops: [bannerTask()] }]);
    const aiCall = gate();
    ai.gate = aiCall.promise;
    const drive = new CapturingDrive();
    const { db, app, sock } = await setup({ ai, drive });
    sock.emit('messages.upsert', { type: 'notify', messages: [waText('m1', 'Rahul, homepage banner thoda bright karo.')] });
    await settled();
    await vi.advanceTimersByTimeAsync(241_000);
    expect(ai.calls).toHaveLength(1);
    expect(drive.uploads).toBe(1);

    const upload = gate();
    drive.gate = upload.promise;
    app.publisher.schedule();
    await vi.advanceTimersByTimeAsync(1_000); // an upload of the old state is now in flight
    const stop = stopping(app);
    aiCall.resolve();
    await vi.advanceTimersByTimeAsync(1_000); // the drain applies the paid result
    expect((await listTasks(db, 1)).map((t) => t.code)).toEqual(['SHA-001']);
    expect(drive.uploads).toBe(1);
    drive.gate = undefined;
    upload.resolve();
    await finish(stop);
    expect(drive.uploads).toBe(3);
    expect(vi.getTimerCount()).toBe(0);

    vi.useRealTimers();
    expect((await sharmaRows(drive.last!)).map((r) => r[0])).toContain('SHA-001');
  });

  it('books a hung AI call at its estimate when stopping', async () => {
    const ai = new FakeAi();
    ai.gate = new Promise<void>(() => {});
    const { lines, log } = capturingLogger();
    const { db, app, sock } = await setup({ ai, drainMs: 5_000, log });
    sock.emit('messages.upsert', { type: 'notify', messages: [waText('m1', 'hello')] });
    await settled();
    await vi.advanceTimersByTimeAsync(240_000);
    expect(ai.calls).toHaveLength(1);

    await stopApp(app);
    const c = ai.calls[0]!;
    const rows = db.raw.prepare('SELECT kind, usd, detail FROM spend').all() as { kind: string; usd: number; detail: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'ai', detail: 'shutdown before the paid call finished (estimated)' });
    expect(rows[0]!.usd).toBeCloseTo(estimateCostUsd(c.system.length + c.user.length, P, MAX_OUTPUT_TOKENS), 9);
    expect(lines.find((l) => l.count === 1)).toMatchObject({ level: 40 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('books nothing extra when the drain finished cleanly', async () => {
    const ai = new FakeAi([{ ops: [bannerTask()] }]);
    const aiCall = gate();
    ai.gate = aiCall.promise;
    const { db, app, sock } = await setup({ ai });
    sock.emit('messages.upsert', { type: 'notify', messages: [waText('m1', 'Rahul, homepage banner thoda bright karo.')] });
    await settled();
    await vi.advanceTimersByTimeAsync(241_000);
    const stop = stopping(app);
    aiCall.resolve();
    await finish(stop);
    expect(db.raw.prepare('SELECT detail FROM spend').all()).toEqual([{ detail: 'batch 1' }]);
  });

  it('starting twice leaves no extra timer behind', async () => {
    const { app } = await setup();
    app.start();
    await stopApp(app);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives up on a hung AI call after 120 seconds by default', async () => {
    const ai = new FakeAi();
    ai.gate = new Promise<void>(() => {});
    const { app, sock } = await setup({ ai });
    sock.emit('messages.upsert', { type: 'notify', messages: [waText('m1', 'hello')] });
    await settled();
    await vi.advanceTimersByTimeAsync(240_000);
    expect(ai.calls).toHaveLength(1);

    const t0 = Date.now();
    const stop = stopping(app);
    await vi.advanceTimersByTimeAsync(119_000);
    expect(stop.state.done).toBe(false);
    await finish(stop); // the drain gives up at 120 s, then the final upload runs
    expect(Date.now() - t0).toBeLessThan(125_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives up on a hung AI call after drainMs', async () => {
    const ai = new FakeAi();
    ai.gate = new Promise<void>(() => {});
    const { app, sock } = await setup({ ai, drainMs: 5_000 });
    sock.emit('messages.upsert', { type: 'notify', messages: [waText('m1', 'hello')] });
    await settled();
    await vi.advanceTimersByTimeAsync(240_000);

    const t0 = Date.now();
    const stop = stopping(app);
    await vi.advanceTimersByTimeAsync(4_900);
    expect(stop.state.done).toBe(false);
    await finish(stop);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits at most 5 seconds for a gateway that never stops', async () => {
    const { app, gateway } = await setup();
    const realStop = gateway.stop.bind(gateway);
    vi.spyOn(gateway, 'stop').mockImplementation(() => {
      void realStop(); // clears the gateway's own timers; the caller still never sees it finish
      return new Promise<void>(() => {});
    });
    await vi.advanceTimersByTimeAsync(1_000);

    const stop = stopping(app);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(stop.state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(2_500); // the 5 s cap has passed by now
    expect(stop.state.done).toBe(true);
    await finish(stop);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits at most 10 seconds for a hung Drive upload', async () => {
    const drive = new FakeDrive();
    drive.gate = new Promise<void>(() => {});
    const { app } = await setup({ drive });
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
    const { db, ai, app, sock } = await setup();
    sock.emit('messages.upsert', { type: 'notify', messages: [waText('z1', 'Mehta message', { group: MEHTA.groupId })] });
    await settled();
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM messages WHERE wa_id = 'z1'").get()).toEqual({ n: 1 });

    await app.reloadClients([SHARMA]);
    await vi.advanceTimersByTimeAsync(1_300_000);
    expect(ai.calls).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    await stopApp(app);
  });

  it('clears the health warning of a failed group once it is removed', async () => {
    const { db, app, sock } = await setup({ ai: new FakeAi([new Error('boom')]) });
    sock.emit('messages.upsert', { type: 'notify', messages: [waText('z1', 'Mehta message', { group: MEHTA.groupId })] });
    await settled();
    await vi.advanceTimersByTimeAsync(240_000);
    expect(app.health.line()).toEqual({ ok: false, text: '⚠️ 1 group waiting (AI error)' });

    await app.reloadClients([SHARMA]);
    expect(app.health.line().ok).toBe(true);
    await vi.advanceTimersByTimeAsync(0); // the snapshot is saved after the file counts are read again
    expect((await readHealthSnapshot(db))!.failed).toEqual([]);
    await stopApp(app);
  });

  it('ignores the failed outcome of a group removed while its call was running', async () => {
    const ai = new FakeAi([new Error('boom')]);
    const g = gate();
    ai.gate = g.promise;
    const { db, drive, app, sock } = await setup({ ai });
    sock.emit('messages.upsert', { type: 'notify', messages: [waText('z1', 'Mehta message', { group: MEHTA.groupId })] });
    await settled();
    await vi.advanceTimersByTimeAsync(240_000);
    expect(ai.calls).toHaveLength(1);

    await app.reloadClients([SHARMA]);
    await vi.advanceTimersByTimeAsync(60_000); // the publish that reloadClients scheduled
    const uploads = drive.uploads;
    g.resolve();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(app.health.line().ok).toBe(true);
    expect((await readHealthSnapshot(db))!.failed).toEqual([]);
    expect(drive.uploads).toBe(uploads); // no publish scheduled for the removed group
    await stopApp(app);
  });

  it('ignores the crash of a group removed while its run was in flight', async () => {
    const g = gate<never>();
    vi.spyOn(Reconciler.prototype, 'run').mockImplementationOnce(() => g.promise);
    const { db, app, sock } = await setup();
    sock.emit('messages.upsert', { type: 'notify', messages: [waText('z1', 'Mehta message', { group: MEHTA.groupId })] });
    await settled();
    await vi.advanceTimersByTimeAsync(240_000);

    await app.reloadClients([SHARMA]);
    g.reject(new Error('boom'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(app.health.line().ok).toBe(true);
    expect((await readHealthSnapshot(db))!.failed).toEqual([]);
    await stopApp(app);
  });

  it('keeps the old allow-list when the new config conflicts with the database', async () => {
    const { db, app, sock } = await setup();
    await expect(app.reloadClients([SHARMA, { ...MEHTA, code: 'MEX' }])).rejects.toThrow(/codes are permanent/);
    sock.emit('messages.upsert', { type: 'notify', messages: [waText('z1', 'Mehta message', { group: MEHTA.groupId })] });
    await settled();
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM messages WHERE wa_id = 'z1'").get()).toEqual({ n: 1 });
    await stopApp(app);
  });

  it('picks up the waiting messages of a group that is added back', async () => {
    const { ai, app, sock } = await setup();
    sock.emit('messages.upsert', { type: 'notify', messages: [waText('z1', 'Mehta message', { group: MEHTA.groupId })] });
    await settled();
    await app.reloadClients([SHARMA]);
    await vi.advanceTimersByTimeAsync(1_300_000);
    expect(ai.calls).toEqual([]);

    await app.reloadClients([SHARMA, MEHTA]);
    await vi.advanceTimersByTimeAsync(30_000 + 240_000); // next tick, then the quiet period
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0]!.user).toContain('Mehta message');
    await stopApp(app);
  });
});

describe('app ingest failures', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T07:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('logs a failed database write without the chat text and still counts it', async () => {
    const { lines, log } = capturingLogger();
    const { db, app, sock, gateway } = await setup({ log });
    db.raw.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'cannot store: banner thoda bright'); END");
    sock.emit('messages.upsert', { type: 'notify', messages: [waText('m1', 'Rahul, homepage banner thoda bright karo.')] });
    await settled();

    expect(gateway.failedCount()).toBe(1);
    expect(lines.find((l) => l.msg === 'ingest failed')).toMatchObject({ err: { type: 'SqliteError' } });
    expect(JSON.stringify(lines)).not.toContain('thoda bright');
    await stopApp(app);
  });

  it('records the count of unsaved messages on the next tick and warns in health', async () => {
    const { db, app, sock, gateway } = await setup();
    db.raw.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'cannot store'); END");
    sock.emit('messages.upsert', { type: 'notify', messages: [waText('m1', 'hello')] });
    await settled();
    expect(gateway.failedCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await readHealthSnapshot(db))!.ingestFailures).toBe(1);
    expect(app.health.line()).toEqual({ ok: false, text: '⚠️ 1 incoming message could not be saved. See docs/SETUP.md.' });
    await stopApp(app);
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
    const { app, sock } = await setup({ ai: new FakeAi([new Error('boom')]), drive });
    sock.emit('messages.upsert', { type: 'notify', messages: [waText('m1', 'hello')] });
    await settled();
    await vi.advanceTimersByTimeAsync(239_000);
    expect(drive.uploads).toBe(1);

    await vi.advanceTimersByTimeAsync(2_000); // the reconcile fails at 240 s
    await vi.advanceTimersByTimeAsync(30_000);
    expect(drive.uploads).toBe(2);
    await stopApp(app);

    vi.useRealTimers();
    expect(await overviewTexts(drive.last!)).toContain('⚠️ 1 group waiting (AI error)');
  });

  it('a run that waits for a shared file calls no AI and publishes nothing, and goes ahead once the file stops blocking (12d)', async () => {
    const run = vi.spyOn(Reconciler.prototype, 'run');
    const { db, ai, drive, app, sock } = await setup();
    sock.emit('messages.upsert', { type: 'notify', messages: [waText('m1', 'see this')] });
    await settled();
    // A file of this message is still being read (the media queue is wired in Task 15).
    await insertMedia(db, {
      messageId: (await messageRowId(db, 1, 'm1'))!, clientId: 1, kind: 'image', status: 'pending', mimeType: 'image/jpeg', fileName: null, fileSize: 1000,
      seconds: null, forwarded: false, refEnc: null, errorCode: null, createdAt: new Date().toISOString(),
    });
    await vi.advanceTimersByTimeAsync(239_000);
    expect(drive.uploads).toBe(1);

    await vi.advanceTimersByTimeAsync(2_000); // the run at 240 s waits for the file
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalled();
    await expect(run.mock.results[0]!.value).resolves.toEqual({ status: 'waiting' });
    expect(ai.calls).toHaveLength(0);
    expect(drive.uploads).toBe(1);
    expect((await readHealthSnapshot(db))!.failed).toEqual([]);

    // 30 minutes after the file arrived it no longer holds up its message: a later run goes ahead and publishes. The
    // file, still pending, now counts as waiting too long, and that change to the health line publishes too (final review).
    await vi.advanceTimersByTimeAsync(40 * 60_000);
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0]!.user).toContain(': see this {image, still being read}');
    expect(drive.uploads).toBe(3);
    await stopApp(app);
  });

  it('logs a crashed reconcile without its message, records it and publishes', async () => {
    vi.spyOn(Reconciler.prototype, 'run').mockRejectedValueOnce(new Error('Rahul said the secret banner text'));
    const { lines, log } = capturingLogger();
    const { db, drive, app, sock } = await setup({ log });
    sock.emit('messages.upsert', { type: 'notify', messages: [waText('m1', 'hello')] });
    await settled();
    await vi.advanceTimersByTimeAsync(239_000);
    expect(drive.uploads).toBe(1);

    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(30_000);
    const crash = lines.find((l) => l.msg === 'reconcile crashed');
    expect(crash).toMatchObject({ clientId: 1, err: { type: 'Error' } });
    expect(JSON.stringify(lines)).not.toContain('secret banner text');
    expect((await readHealthSnapshot(db))!.failed).toEqual([{ clientId: 1, errorCode: 'crash' }]);
    expect(drive.uploads).toBe(2);
    await stopApp(app);
  });

  it('keeps ticking when saving the health snapshot fails', async () => {
    const { lines, log } = capturingLogger();
    const { db, drive, app } = await setup({ log });
    await vi.advanceTimersByTimeAsync(1_000);
    const persist = vi.spyOn(app.health, 'persist').mockImplementation(() => {
      throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(lines.filter((l) => l.msg === 'tick failed')).toHaveLength(1);
    const before = drive.uploads;
    await setKv(db, 'rebuild_requested', new Date().toISOString());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(lines.filter((l) => l.msg === 'tick failed').length).toBeGreaterThanOrEqual(2);
    expect(lines.find((l) => l.msg === 'tick failed')).toMatchObject({ err: { type: 'Error', code: 'SQLITE_BUSY' } });
    expect(await getKv(db, 'rebuild_requested')).toBe('');
    expect(drive.uploads).toBeGreaterThan(before);

    persist.mockRestore();
    await stopApp(app);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports Drive failures in health, keeps them out of the uploaded workbook, and clears them after an upload', async () => {
    const drive = new CapturingDrive();
    const { db, app } = await setup({ drive });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(drive.created).toHaveLength(1);

    drive.failUpdateWith = Object.assign(new Error('Unauthorized'), { code: 401 });
    const failed = app.publisher.publishNow();
    await vi.advanceTimersByTimeAsync(1_000);
    await failed;
    expect(app.health.line()).toEqual({ ok: false, text: '❌ Google sign-in expired. Run: npm run cli -- google-auth, then restart the service' });
    expect((await readHealthSnapshot(db))!.publishFailingSince).not.toBeNull();

    drive.failUpdateWith = undefined;
    await vi.advanceTimersByTimeAsync(60_000); // the publisher's backoff retry
    expect(drive.updated).toHaveLength(1);
    expect(app.health.line().ok).toBe(true);
    expect((await readHealthSnapshot(db))!.publishFailingSince).toBeNull();
    await stopApp(app);

    vi.useRealTimers();
    const texts = await overviewTexts(drive.last!);
    expect(texts.some((t) => t.startsWith('✅'))).toBe(true);
    expect(texts.join('\n')).not.toContain('Google sign-in');
  });

  it('refreshes the workbook when the source message of a task is deleted', async () => {
    const drive = new CapturingDrive();
    const { db, app, sock } = await setup({ ai: new FakeAi([{ ops: [bannerTask()] }]), drive });
    sock.emit('messages.upsert', { type: 'notify', messages: [waText('m1', 'Rahul, homepage banner thoda bright karo.')] });
    await settled();
    await vi.advanceTimersByTimeAsync(300_000); // reconciled at 240 s and uploaded
    expect((await listTasks(db, 1)).map((t) => t.code)).toEqual(['SHA-001']);
    const before = drive.uploads;

    sock.emit('messages.update', [{ key: { remoteJid: SHARMA.groupId, id: 'm1' }, update: { messageStubType: WAMessageStubType.REVOKE } } as WAMessageUpdate]);
    await settled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(drive.uploads).toBe(before + 1);
    const uploaded = drive.last!;
    await stopApp(app);

    vi.useRealTimers();
    const row = (await sharmaRows(uploaded)).find((r) => r[0] === 'SHA-001')!;
    expect(row.join(' | ')).toContain('source message deleted by sender');
  });

  it('publishes once when only the workbook health line changes, and not again while it stays the same (final review)', async () => {
    const drive = new CapturingDrive();
    const { db, app, sock } = await setup({ drive });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(drive.uploads).toBe(1); // the start publish
    await vi.advanceTimersByTimeAsync(60_000); // two ticks with the same line publish nothing
    expect(drive.uploads).toBe(1);

    // A message that cannot be saved changes only the health line: no reconcile, no file, no other publish.
    db.raw.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'cannot store'); END");
    sock.emit('messages.upsert', { type: 'notify', messages: [waText('m1', 'hello')] });
    await settled();
    await vi.advanceTimersByTimeAsync(31_000); // the next tick sees the new line
    expect(drive.uploads).toBe(2);
    const uploaded = drive.last!;
    await vi.advanceTimersByTimeAsync(5 * 60_000); // ten more ticks, same line
    expect(drive.uploads).toBe(2);
    await stopApp(app);

    vi.useRealTimers();
    expect(await overviewTexts(uploaded)).toContain('⚠️ 1 incoming message could not be saved. See docs/SETUP.md.');
  });

  it('republishes once after IST midnight with no other event, so the Today tab carries the new date (Task 3 review round 2)', async () => {
    const drive = new CapturingDrive();
    vi.setSystemTime(new Date('2026-10-19T18:00:00Z')); // 23:30 IST on 19 Oct
    const { app } = await setup({ drive });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(drive.uploads).toBe(1); // the start publish, built on 19 Oct
    const first = drive.last!;
    await vi.advanceTimersByTimeAsync(20 * 60_000); // still 19 Oct IST: quiet ticks publish nothing
    expect(drive.uploads).toBe(1);
    await vi.advanceTimersByTimeAsync(15 * 60_000); // past 00:00 IST on 20 Oct, still no event
    expect(drive.uploads).toBe(2);
    const second = drive.last!;
    await vi.advanceTimersByTimeAsync(60 * 60_000); // the rest of the new day stays quiet
    expect(drive.uploads).toBe(2);
    await stopApp(app);

    vi.useRealTimers();
    const title = async (buf: Buffer) => {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
      return String(wb.getWorksheet('Today')!.getCell('A1').value);
    };
    expect(await title(first)).toMatch(/^Today · 19 Oct · /);
    expect(await title(second)).toMatch(/^Today · 20 Oct · /);
  });

  it('points to the safe procedure when WhatsApp unlinks the device', async () => {
    const { app, sock } = await setup();
    closeWith(sock, 401);
    expect(app.health.line()).toEqual({ ok: false, text: '❌ WhatsApp unlinked since 19 Oct 12:30. Follow docs/SETUP.md → "Status logged_out".' });
    await stopApp(app);
  });
});

describe('app: a newly approved group\'s earlier messages (history backfill)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T07:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);
  const ON_DEMAND = proto.HistorySync.HistorySyncType.ON_DEMAND;

  it('pages back from the first new message, holds the AI meanwhile, then reads old and new together in time order', async () => {
    const { db, ai, app, sock } = await setup();
    // seededDb approved Sharma at 07:00: no message yet, so it waits for the first new one.
    expect(sock.fetchMessageHistory).not.toHaveBeenCalled();
    sock.emit('messages.upsert', { type: 'notify', messages: [waText('L1', 'NEW: send the final logo today', { ts: sec('2026-10-19T07:00:30Z') })] });
    await settled();
    await vi.advanceTimersByTimeAsync(30_000); // the tick
    expect(sock.fetchMessageHistory).toHaveBeenCalledExactlyOnceWith(50, { remoteJid: SHARMA.groupId, fromMe: false, id: 'L1' }, Date.parse('2026-10-19T07:00:30Z'));
    sock.emit('messaging-history.set', { chats: [], contacts: [], syncType: ON_DEMAND, messages: [waText('E1', 'OLD: please make a logo', { ts: sec('2026-10-17T09:00:00Z') })] });
    await settled();
    await vi.advanceTimersByTimeAsync(4_000); // the gap, then the next page from the new oldest message
    expect(sock.fetchMessageHistory).toHaveBeenCalledTimes(2);
    expect(sock.fetchMessageHistory.mock.calls[1]![1]).toEqual({ remoteJid: SHARMA.groupId, fromMe: false, id: 'E1' });
    expect(ai.calls).toEqual([]); // held: nothing is reconciled while earlier messages are being read
    // Older than 7 days: dropped, and the backfill ends.
    sock.emit('messaging-history.set', { chats: [], contacts: [], syncType: ON_DEMAND, messages: [waText('E0', 'TOO OLD', { ts: sec('2026-10-10T09:00:00Z') })] });
    await settled();
    expect(db.raw.prepare("SELECT 1 FROM messages WHERE wa_id = 'E0'").get()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(240_000);
    expect(ai.calls).toHaveLength(1);
    const user = ai.calls[0]!.user;
    expect(user.indexOf('OLD: please make a logo')).toBeGreaterThan(-1);
    expect(user.indexOf('OLD: please make a logo')).toBeLessThan(user.indexOf('NEW: send the final logo today'));
    expect(user).not.toContain('TOO OLD');
    await stopApp(app);
  });

  it('asks for nothing for a group that is not approved, and stops a group that is removed', async () => {
    const { app, sock } = await setup();
    sock.emit('messages.upsert', { type: 'notify', messages: [waText('X1', 'not ours', { group: OTHER_GROUP, ts: sec('2026-10-19T07:00:30Z') })] });
    await settled();
    await app.reloadClients([MEHTA]); // Sharma removed before its first message
    sock.emit('messages.upsert', { type: 'notify', messages: [waText('L1', 'after removal', { ts: sec('2026-10-19T07:00:40Z') })] });
    await settled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sock.fetchMessageHistory).not.toHaveBeenCalled();
    await stopApp(app);
  });
});
