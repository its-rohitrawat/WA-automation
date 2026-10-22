import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpendCapReachedError } from '../../src/brain/paidCall.ts';
import type { Extractor } from '../../src/media/extract.ts';
import { MediaDownloadError, type MediaFetcher } from '../../src/media/fetch.ts';
import { MediaProcessor, type ProcessOutcome, type ProcessResult } from '../../src/media/processor.ts';
import { MediaQueue } from '../../src/media/queue.ts';
import { MediaRefSealer } from '../../src/media/ref.ts';
import type { Db } from '../../src/store/db.ts';
import { getMedia, insertMedia, messageRowId } from '../../src/store/media.ts';
import { insertMessage } from '../../src/store/messages.ts';
import { manualClock } from '../../src/util/clock.ts';
import { createLogger, silentLogger, type Logger } from '../../src/util/logger.ts';
import { Ingestor } from '../../src/wa/ingest.ts';
import { normalizeMessage } from '../../src/wa/normalize.ts';
import { NOW, seededDb } from '../helpers/db.ts';
import { waRaw } from '../helpers/wa.ts';

/** A pending file whose sealed download details are not real: the real processor cannot open them. */
function pending(db: Db, waId: string): number {
  insertMessage(db, { waId, clientId: 1, senderJid: 'x@s.whatsapp.net', senderNumber: null, senderName: null, fromMe: false, ts: NOW, text: null, quotedWaId: null, mediaType: 'image' });
  return insertMedia(db, {
    messageId: messageRowId(db, 1, waId)!, clientId: 1, kind: 'image', status: 'pending', mimeType: 'image/jpeg', fileName: null, fileSize: 1, seconds: null,
    forwarded: false, refEnc: Buffer.from('s'), errorCode: null, createdAt: NOW,
  });
}

const flush = () => new Promise<void>((r) => setImmediate(r));

function logLines(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  return { lines, log: createLogger('info', new Writable({ write(c, _e, cb) { lines.push(String(c)); cb(); } })) };
}

/** A processor whose calls wait until the test finishes them; finishing also updates the row like the real one. */
function setup(o: { log?: Logger; onSettled?: (clientId: number) => void } = {}) {
  const db = seededDb();
  const started: number[] = [];
  const waiting = new Map<number, (r: ProcessResult) => void>();
  const processor = {
    process: vi.fn((id: number) => new Promise<ProcessResult>((resolve) => {
      started.push(id);
      waiting.set(id, resolve);
    })),
  };
  const onSettled = vi.fn(o.onSettled ?? (() => {}));
  const queue = new MediaQueue({ db, clock: manualClock('2026-10-19T08:00:00Z'), log: o.log ?? silentLogger(), processor, concurrency: 2, onSettled });
  const finish = async (id: number, outcome: ProcessOutcome) => {
    if (outcome === 'deferred') db.prepare("UPDATE media SET next_attempt_at = '2099-01-01T00:00:00.000Z' WHERE id = ?").run(id);
    else db.prepare("UPDATE media SET status = 'done' WHERE id = ?").run(id);
    waiting.get(id)!({ outcome, clientId: 1 });
    await flush();
  };
  return { db, started, processor, onSettled, queue, finish };
}

describe('MediaQueue', () => {
  it('runs at most two files at once, oldest first, and starts the next when one finishes', async () => {
    const { db, started, queue, finish } = setup();
    const [a, b, c] = [pending(db, 'A'), pending(db, 'B'), pending(db, 'C')];
    queue.kick();
    queue.kick();
    await flush();
    expect(started).toEqual([a, b]);
    expect(queue.active).toBe(2);
    await finish(a!, 'done');
    expect(started).toEqual([a, b, c]);
  });

  it('tells the debouncer about files that reached a final state only', async () => {
    const { db, onSettled, queue, finish } = setup();
    const [a, b] = [pending(db, 'A'), pending(db, 'B')];
    queue.kick();
    await flush();
    await finish(b!, 'deferred');
    expect(onSettled).not.toHaveBeenCalled();
    await finish(a!, 'failed');
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith(1);
  });

  it('stop() starts nothing new; drain() waits for the files in flight', async () => {
    const { db, started, queue, finish } = setup();
    const [a, b] = [pending(db, 'A'), pending(db, 'B')];
    pending(db, 'C');
    queue.kick();
    await flush();
    queue.stop();
    let drained = false;
    const d = queue.drain(5_000).then(() => { drained = true; });
    await finish(a!, 'done');
    expect(started).toEqual([a, b]);
    expect(drained).toBe(false);
    await finish(b!, 'done');
    await d;
    expect(drained).toBe(true);
  });

  it('drain() gives up at its timeout', async () => {
    const { db, queue } = setup();
    pending(db, 'A');
    queue.kick();
    await flush();
    const started = Date.now();
    await queue.drain(50);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('logs a crash and does not retry it in a tight loop', async () => {
    const { log, lines } = logLines();
    const { db, processor, queue } = setup({ log });
    pending(db, 'A');
    processor.process.mockRejectedValueOnce(Object.assign(new Error('SQLITE_BUSY'), { code: 'SQLITE_BUSY' }));
    queue.kick();
    await flush();
    await flush();
    expect(processor.process).toHaveBeenCalledTimes(1);
    expect(lines.join('')).toContain('media processing crashed');
    queue.kick(); // the next tick tries again
    await flush();
    expect(processor.process).toHaveBeenCalledTimes(2);
  });

  it('a throwing onSettled does not break the queue', async () => {
    const { db, started, queue, finish } = setup({ onSettled: () => { throw new Error('boom'); } });
    const [a] = [pending(db, 'A'), pending(db, 'B'), pending(db, 'C')];
    queue.kick();
    await flush();
    await finish(a!, 'done');
    expect(started).toHaveLength(3);
  });

  // The ingestor calls kick() after it commits a message: a throw there would count a stored message as lost.
  it('kick() never throws, even when the database cannot be read', async () => {
    const { log, lines } = logLines();
    const { db, queue } = setup({ log });
    db.close();
    expect(() => queue.kick()).not.toThrow();
    await flush();
    expect(lines.join('')).toContain('media queue read failed');
    expect(queue.active).toBe(0);
  });
});

// Amendment 11a: the refill after a file finishes must never spin on a file that stays pending.
describe('MediaQueue never retries a file in a loop', () => {
  const MEDIA_KEY = Buffer.alloc(32, 9);
  const MINUTE = 60_000;
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** The real processor behind the queue, wired as the app wires them: the ingestor kicks the queue for each file it stores. */
  function withProcessor(o: { fetcher?: MediaFetcher; extract?: Extractor } = {}) {
    const dataDir = mkdtempSync(join(tmpdir(), 'wa-queue-'));
    dirs.push(dataDir);
    const db = seededDb();
    const clock = manualClock('2026-10-19T08:00:00Z');
    const sealer = new MediaRefSealer(Buffer.alloc(32, 5));
    const real = new MediaProcessor({
      db, dataDir, clock, log: silentLogger(), sealer,
      fetcher: o.fetcher ?? (async () => Buffer.from('jpeg-bytes')),
      extract: o.extract ?? (async () => ({ textKind: 'description', text: 'A blue banner', pageCount: null, note: null })),
    });
    const processor = { process: vi.fn((id: number) => real.process(id)) };
    const onSettled = vi.fn();
    const queue = new MediaQueue({ db, clock, log: silentLogger(), processor, concurrency: 2, onSettled });
    const ing = new Ingestor({ db, onNewMessages: () => {}, clock, media: { sealer, onQueued: () => queue.kick() } });
    const share = (waId: string): number => {
      ing.handle(normalizeMessage(waRaw(waId, { imageMessage: { url: 'https://mmg.whatsapp.net/v/x', directPath: '/v/x', mediaKey: MEDIA_KEY, mimetype: 'image/jpeg' } }))!);
      return (db.prepare('SELECT id FROM media ORDER BY id DESC LIMIT 1').get() as { id: number }).id;
    };
    return { db, clock, processor, onSettled, queue, share };
  }

  it('a file the processor cannot handle is attempted once, then failed, and not tried again', async () => {
    const { db, processor, onSettled, queue } = withProcessor();
    const id = pending(db, 'A');
    queue.kick();
    await queue.drain(5_000);
    expect(processor.process).toHaveBeenCalledTimes(1);
    expect(getMedia(db, id)).toMatchObject({ status: 'unavailable', errorCode: 'ref_unreadable', hasRef: false });
    expect(onSettled).toHaveBeenCalledWith(1);
    queue.kick();
    await flush();
    expect(processor.process).toHaveBeenCalledTimes(1);
  });

  it('a refill never restarts a file that stays due; the next kick tries it once more', async () => {
    const db = seededDb();
    const [a, b, c, d] = [pending(db, 'A'), pending(db, 'B'), pending(db, 'C'), pending(db, 'D')];
    const calls: number[] = [];
    // A broken processor: it answers at once and leaves A, B and C pending and due. After 50 calls it stops answering,
    // so a loop fails the assertions below instead of hanging the test run in an endless chain of promise callbacks.
    const processor = {
      process: vi.fn((id: number): Promise<ProcessResult> => {
        calls.push(id);
        if (calls.length > 50) return new Promise<ProcessResult>(() => {});
        if (id === d) db.prepare("UPDATE media SET status = 'done' WHERE id = ?").run(id);
        return Promise.resolve({ outcome: id === b ? 'deferred' : id === d ? 'done' : 'skipped', clientId: 1 });
      }),
    };
    const queue = new MediaQueue({ db, clock: manualClock('2026-10-19T08:00:00Z'), log: silentLogger(), processor, concurrency: 2, onSettled: () => {} });
    queue.kick();
    await flush();
    expect(calls).toEqual([a, b, c, d]); // more stuck files than slots ahead of D still do not keep D waiting
    expect(queue.active).toBe(0);
    queue.kick(); // the next tick
    await flush();
    expect(calls).toEqual([a, b, c, d, a, b, c]);
    expect(queue.active).toBe(0);
  });

  it.each([
    { why: 'a download error (counted attempt)', o: { fetcher: async () => { throw new MediaDownloadError('network'); } }, waitMs: MINUTE, errorCode: 'network' },
    { why: 'Claude unavailable (529)', o: { extract: async () => { throw Anthropic.APIError.generate(529, undefined, 'overloaded', new Headers()); } }, waitMs: 5 * MINUTE, errorCode: 'ai_unavailable' },
    { why: 'the daily spend cap', o: { extract: async () => { throw new SpendCapReachedError(); } }, waitMs: 10 * MINUTE, errorCode: 'spend_cap' },
  ])('a file deferred for $why is not started again until it is due', async ({ o, waitMs, errorCode }) => {
    const { db, clock, processor, onSettled, queue, share } = withProcessor(o);
    const id = share('IMG1'); // the ingestor kicks the queue
    expect(queue.active).toBe(1);
    await queue.drain(5_000);
    expect(processor.process).toHaveBeenCalledTimes(1);
    expect(getMedia(db, id)).toMatchObject({ status: 'pending', errorCode, nextAttemptAt: new Date(Date.parse('2026-10-19T08:00:00Z') + waitMs).toISOString() });
    queue.kick();
    clock.advance(waitMs - 1);
    queue.kick();
    await flush();
    expect(processor.process).toHaveBeenCalledTimes(1);
    clock.advance(1);
    queue.kick();
    await queue.drain(5_000);
    expect(processor.process).toHaveBeenCalledTimes(2);
    expect(onSettled).not.toHaveBeenCalled();
  });
});
