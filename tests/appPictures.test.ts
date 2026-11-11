import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type AppMediaDeps } from '../src/app.ts';
import type { Extractor } from '../src/media/extract.ts';
import type { MediaFetcher } from '../src/media/fetch.ts';
import { MediaRefSealer } from '../src/media/ref.ts';
import { SourcePictures } from '../src/output/sourcePictures.ts';
import type { Prices } from '../src/spend/pricing.ts';
import type { Db } from '../src/store/db.ts';
import { messageRowId } from '../src/store/media.ts';
import { insertMessage, markProcessed } from '../src/store/messages.ts';
import { createTask } from '../src/store/tasks.ts';
import { systemClock } from '../src/util/clock.ts';
import { silentLogger } from '../src/util/logger.ts';
import { retryMs } from '../src/util/retry.ts';
import { AllowList } from '../src/wa/allowlist.ts';
import { openSessionDb, useEncryptedAuthState } from '../src/wa/authState.ts';
import { WhatsAppGateway } from '../src/wa/gateway.ts';
import { DbWork, expectNoTimers } from './helpers/advance.ts';
import { FakeAi } from './helpers/ai.ts';
import { idOf, MEHTA, row, seededDb, SHARMA } from './helpers/db.ts';
import { FakeDrive } from './helpers/fakeDrive.ts';
import { FakeMediaAi } from './helpers/mediaAi.ts';
import { FakeSocket } from './helpers/fakeSocket.ts';
import { SHARMA_PN } from './helpers/wa.ts';

// The app makes each open task's chat picture after a tracker upload and on the tick, and the next upload links it
// (owner request, 11 Nov 2026). The setup is tests/appMedia.test.ts's: the same fake gateway, FakeDrive, fake clock and
// first publish, with the media pipeline on.

const P: Prices = { inputPerMTok: 4, outputPerMTok: 20, cacheWritePerMTok: 5, cacheReadPerMTok: 0.2 };
/** Drawing a picture is real work (sharp), not fake time: a wait for it gets more than the default 1 s under load. */
const SLOW_IO = { timeout: 10_000 };
const DASHBOARD = 'https://agent.example.com';
const NOTHING_READ = { textKind: null, text: null, pageCount: null, note: null };
const dirs: string[] = [];

/** The app's statements in flight; advance() is fake time that waits for them (tests/helpers/advance.ts). */
const work = new DbWork();
const advance = (ms: number) => work.advance(ms);

/** stop() ends with a final upload whose workbook build runs on (fake) timers: advance until it resolves. */
async function stopApp(app: { stop(): Promise<void> }): Promise<void> {
  await work.until(app.stop(), { fakeMs: 30_000, stepMs: 1_000, realCapMs: 8_000, label: 'stop()' });
}

/**
 * Sharma's message w1, already processed (so no reconcile runs in the test), and the open task it is the source of.
 * Returns the task's code and the message's row id.
 */
async function storedTask(db: Db): Promise<{ code: string; messageId: number }> {
  const sha = await idOf(db, SHARMA.code);
  await insertMessage(db, {
    waId: 'w1', clientId: sha, senderJid: SHARMA_PN, senderNumber: '919800000001', senderName: 'Mr. Sharma', fromMe: false,
    ts: '2026-11-10T08:00:00.000Z', text: 'homepage banner thoda bright karo', quotedWaId: null, mediaType: null,
  });
  const messageId = (await messageRowId(db, sha, 'w1'))!;
  await markProcessed(db, [messageId], '2026-11-10T08:05:00.000Z');
  const t = await createTask(db, {
    clientId: sha, side: 'us', title: 'Brighter banner', category: 'design', priority: 'major', assignedTo: null, askedBy: null,
    raisedOn: '2026-11-10', deadline: null, latestProgress: null, sourceQuote: 'banner bright karo', sourceDate: '2026-11-10', sourceWaId: 'w1',
    origin: 'whatsapp',
  }, '2026-11-10T08:05:00.000Z');
  return { code: t.code, messageId };
}

async function setup(o: { dashboardUrl?: string } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'wa-app-pictures-'));
  dirs.push(dataDir);
  const drive = new FakeDrive();
  const plain = await seededDb();
  const task = await storedTask(plain);
  const db = work.wrap(plain);
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
  const media: AppMediaDeps = {
    sealer: new MediaRefSealer(randomBytes(32)),
    fetcher: vi.fn<MediaFetcher>(async () => Buffer.from('jpeg-bytes')),
    ai: new FakeMediaAi(),
    extract: vi.fn<Extractor>(async () => NOTHING_READ),
  };
  const app = await createApp({
    db, clock: systemClock, log: silentLogger(), gateway, allow, ai: new FakeAi(), drive, prices: P, spendCapUsd: 15,
    quietMs: 240_000, maxWaitMs: 1_200_000, maxConcurrent: 3, dataDir, freeBytes: () => 500e9, pollMs: 30_000, media,
    ...(o.dashboardUrl ? { dashboardUrl: o.dashboardUrl } : {}),
  });
  app.start();
  sockets[0]!.emit('connection.update', { connection: 'open' });
  return { db: plain, drive, app, task };
}

/**
 * Collects the body of every tracker upload (never a picture's), in order, and how many there were when each picture
 * reached Drive. The first `failPictures` picture uploads throw instead, as Drive would when it is unavailable.
 */
function trackerUploads(drive: FakeDrive, failPictures = 0): { bodies: Buffer[]; uploadsAtPicture: number[] } {
  const bodies: Buffer[] = [];
  const uploadsAtPicture: number[] = [];
  let failures = failPictures;
  const createFile = drive.createFile.bind(drive);
  const updateFile = drive.updateFile.bind(drive);
  vi.spyOn(drive, 'createFile').mockImplementation(async (name, mime, body, parentId, timeoutMs) => {
    const picture = name.endsWith('.png');
    if (picture && failures-- > 0) throw new Error('Drive unavailable');
    const id = await createFile(name, mime, body, parentId, timeoutMs);
    if (picture) uploadsAtPicture.push(bodies.length);
    if (name === 'Tracker.xlsx') bodies.push(body);
    return id;
  });
  vi.spyOn(drive, 'updateFile').mockImplementation(async (id, mime, body) => {
    await updateFile(id, mime, body);
    bodies.push(body);
  });
  return { bodies, uploadsAtPicture };
}

/** The Source (M) and Chat (P) cells of the task's row on the Sharma tab. Call with real timers. */
async function linkCells(buf: Buffer, code: string): Promise<{ source: ExcelJS.CellValue; chat: ExcelJS.CellValue }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
  let found: ExcelJS.Row | undefined;
  wb.getWorksheet('Sharma Interiors')!.eachRow((r) => {
    if (!found && r.getCell(1).value === code) found = r;
  });
  return { source: found!.getCell(13).value, chat: found!.getCell(16).value };
}

const pngName = (code: string) => `${code}.png`;
const pictureOf = (drive: FakeDrive, code: string) => drive.created.find((f) => f.name === pngName(code));

describe('app chat pictures (11 Nov 2026)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-11T07:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('after a tracker upload, makes the open task’s chat picture, then uploads the tracker again with its links', async () => {
    const stop = vi.spyOn(SourcePictures.prototype, 'stop');
    const { drive, app, task } = await setup({ dashboardUrl: DASHBOARD });
    const { bodies, uploadsAtPicture } = trackerUploads(drive);
    await advance(1_000); // the first upload makes the WA Agent folder
    await vi.waitFor(() => expect(pictureOf(drive, task.code)).toBeDefined(), SLOW_IO);
    expect(uploadsAtPicture).toEqual([1]); // after the first upload, not before it
    expect(drive.folders).toEqual(['WA Agent', 'Clients', 'Sharma Interiors', 'Sources']);
    expect(pictureOf(drive, task.code)!.parentId).toBe(drive.folderIds[drive.folders.indexOf('Sources')]);
    const published = bodies.length;
    // The new picture asks for another upload; the publisher's 60 s throttle lets it through a minute after the first.
    await advance(61_000);
    await vi.waitFor(() => expect(bodies.length).toBeGreaterThan(published), SLOW_IO);
    expect(drive.updated.length).toBeGreaterThan(0);
    expect(drive.created.filter((f) => f.name.endsWith('.png'))).toHaveLength(1); // made once, not on every upload or tick
    await stopApp(app);
    expect(stop).toHaveBeenCalledWith(0); // no new run during the drain
    expect(stop).toHaveBeenCalledWith(10_000); // then the run in flight, so its Drive id is saved before the database closes
    expectNoTimers();

    vi.useRealTimers();
    // The first upload had no picture yet: a plain quote, and the Chat link already (the message is stored).
    const chat = { text: 'Open', hyperlink: `${DASHBOARD}/dashboard/clients?client=SHA&chat=${task.messageId}` };
    expect(await linkCells(bodies[0]!, task.code)).toEqual({ source: '"banner bright karo" (10 Nov)', chat });
    const picture = `https://drive.google.com/file/d/${pictureOf(drive, task.code)!.id}/view`;
    expect(await linkCells(bodies.at(-1)!, task.code)).toEqual({ source: { text: '"banner bright karo" (10 Nov)', hyperlink: picture }, chat });
  });

  it('the tick makes a picture whose first try failed once it is due again, with no upload to start it; no dashboard address, no Chat link', async () => {
    const { db, drive, app, task } = await setup();
    // Only the picture's first try fails; the tracker uploads go through.
    const { bodies, uploadsAtPicture } = trackerUploads(drive, 1);
    await advance(1_000); // the first upload, then the picture's first try
    await vi.waitFor(async () =>
      expect(await row(db, 'SELECT drive_file_id AS file, attempts, error_code AS code FROM source_pictures')).toEqual({ file: null, attempts: 1, code: 'Error' }),
    SLOW_IO);
    // Due again retryMs(1), 2 minutes, after that try, and a Drive failure keeps runs off for those 2 minutes too.
    // Nothing else happens meanwhile: no message, no file, no upload.
    const { triedAt, nextAt } = (await row<{ triedAt: string; nextAt: string }>(db, 'SELECT tried_at AS triedAt, next_at AS nextAt FROM source_pictures'))!;
    expect(Date.parse(nextAt) - Date.parse(triedAt)).toBe(retryMs(1));
    await advance(Date.parse(nextAt) - Date.now() - 1_000);
    expect(pictureOf(drive, task.code)).toBeUndefined();
    const published = bodies.length;
    // A tick after that makes it (two ticks: the pause began a moment after the try), and the upload it asks for links it.
    await advance(61_000);
    await vi.waitFor(() => expect(pictureOf(drive, task.code)).toBeDefined(), SLOW_IO);
    expect(uploadsAtPicture).toEqual([published]); // no tracker upload came between: the tick started it
    await advance(61_000);
    await vi.waitFor(() => expect(bodies.length).toBeGreaterThan(published), SLOW_IO);
    await stopApp(app);

    vi.useRealTimers();
    const picture = `https://drive.google.com/file/d/${pictureOf(drive, task.code)!.id}/view`;
    const cells = await linkCells(bodies.at(-1)!, task.code);
    expect(cells.source).toEqual({ text: '"banner bright karo" (10 Nov)', hyperlink: picture });
    expect(cells.chat ?? '').toBe('');
  });
});
