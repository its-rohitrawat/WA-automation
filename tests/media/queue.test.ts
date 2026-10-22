import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MediaAi } from '../../src/brain/mediaClient.ts';
import { SpendCapReachedError } from '../../src/brain/paidCall.ts';
import { createExtractor, type Extractor } from '../../src/media/extract.ts';
import { MediaDownloadError, type MediaFetcher } from '../../src/media/fetch.ts';
import type { PreparedImage } from '../../src/media/image.ts';
import { MediaProcessor, type ProcessOutcome, type ProcessResult } from '../../src/media/processor.ts';
import { MediaQueue } from '../../src/media/queue.ts';
import { MediaRefSealer } from '../../src/media/ref.ts';
import type { Prices } from '../../src/spend/pricing.ts';
import { SpendGuard } from '../../src/spend/spendGuard.ts';
import type { Db } from '../../src/store/db.ts';
import { getMedia, insertMedia, messageRowId } from '../../src/store/media.ts';
import { insertMessage } from '../../src/store/messages.ts';
import { manualClock, type Clock } from '../../src/util/clock.ts';
import { createLogger, silentLogger, type Logger } from '../../src/util/logger.ts';
import { Ingestor } from '../../src/wa/ingest.ts';
import { normalizeMessage } from '../../src/wa/normalize.ts';
import { NOW, seededDb } from '../helpers/db.ts';
import { FakeMediaAi } from '../helpers/mediaAi.ts';
import { waRaw } from '../helpers/wa.ts';

const MINUTE = 60_000;

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
function setup(o: { log?: Logger; onSettled?: (clientId: number) => void; concurrency?: number } = {}) {
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
  const clock = manualClock('2026-10-19T08:00:00Z');
  const queue = new MediaQueue({ db, clock, log: o.log ?? silentLogger(), processor, concurrency: o.concurrency ?? 2, onSettled });
  const finish = async (id: number, outcome: ProcessOutcome, clientId: number | null = 1) => {
    if (outcome === 'deferred') db.prepare("UPDATE media SET next_attempt_at = '2099-01-01T00:00:00.000Z' WHERE id = ?").run(id);
    else db.prepare("UPDATE media SET status = 'done' WHERE id = ?").run(id);
    waiting.get(id)!({ outcome, clientId });
    await flush();
  };
  return { db, clock, started, processor, onSettled, queue, finish };
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

  // After a file finishes, the refill reads more rows than there are slots: it must still start only as many as are free.
  it('never runs more than two files at once, however many are due', async () => {
    const { db, started, queue, finish } = setup();
    const [a, b, c, d] = ['A', 'B', 'C', 'D', 'E'].map((w) => pending(db, w));
    queue.kick();
    await flush();
    expect(started).toEqual([a, b]);
    await finish(a!, 'done');
    expect(started).toEqual([a, b, c]);
    expect(queue.active).toBe(2);
    await finish(b!, 'done');
    expect(started).toEqual([a, b, c, d]);
    expect(queue.active).toBe(2);
  });

  it('a kick with one file in flight starts one more, not every due file', async () => {
    const { db, started, queue } = setup();
    const [a, b, c, d] = [pending(db, 'A'), pending(db, 'B'), pending(db, 'C'), pending(db, 'D')];
    // Only D is due at first, so it is in flight while the older A, B and C come due.
    db.prepare("UPDATE media SET next_attempt_at = '2099-01-01T00:00:00.000Z' WHERE id IN (?, ?, ?)").run(a, b, c);
    queue.kick();
    await flush();
    expect(started).toEqual([d]);
    db.prepare('UPDATE media SET next_attempt_at = NULL WHERE id IN (?, ?, ?)').run(a, b, c);
    queue.kick();
    await flush();
    expect(started).toEqual([d, a]);
    expect(queue.active).toBe(2);
  });

  it.each([
    { outcome: 'done', settles: true },
    { outcome: 'failed', settles: true },
    { outcome: 'unavailable', settles: true },
    { outcome: 'deferred', settles: false },
    { outcome: 'skipped', settles: false },
  ] satisfies { outcome: ProcessOutcome; settles: boolean }[])('a file that ends $outcome wakes the debouncer: $settles', async ({ outcome, settles }) => {
    const { db, onSettled, queue, finish } = setup();
    const a = pending(db, 'A');
    queue.kick();
    await flush();
    await finish(a, outcome);
    if (settles) {
      expect(onSettled).toHaveBeenCalledTimes(1);
      expect(onSettled).toHaveBeenCalledWith(1);
    } else {
      expect(onSettled).not.toHaveBeenCalled();
    }
  });

  it('a final state without a client wakes nothing', async () => {
    const { db, onSettled, queue, finish } = setup();
    const a = pending(db, 'A');
    queue.kick();
    await flush();
    await finish(a, 'failed', null);
    expect(onSettled).not.toHaveBeenCalled();
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

  it('drain() leaves no timer behind when the files finish first', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { db, queue, finish } = setup();
      const a = pending(db, 'A');
      queue.kick();
      await flush();
      const d = queue.drain(60_000);
      expect(vi.getTimerCount()).toBe(1);
      await finish(a, 'done');
      await d;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // A crash means a broken database: every other due file would crash too, so nothing more starts until the next tick.
  it('logs a crash, starts nothing else until the next tick, and keeps the crashed file back while the others go on', async () => {
    const { log, lines } = logLines();
    const { db, processor, queue, finish } = setup({ log, concurrency: 1 });
    const [a, b] = [pending(db, 'A'), pending(db, 'B')];
    processor.process.mockRejectedValueOnce(Object.assign(new Error('SQLITE_BUSY'), { code: 'SQLITE_BUSY' }));
    queue.kick();
    await flush();
    await flush();
    expect(processor.process).toHaveBeenCalledTimes(1);
    expect(queue.active).toBe(0);
    expect(lines.join('')).toContain('media processing crashed');
    queue.kick(); // the next tick goes on with the other files
    await flush();
    expect(processor.process.mock.calls.map(([id]) => id)).toEqual([a, b]);
    await finish(b, 'done');
    expect(processor.process.mock.calls.map(([id]) => id)).toEqual([a, b]);
  });

  // Final review FR1: a crashed run may have paid Claude without booking it, so it must not start again on every tick.
  it('keeps a crashed file back for 15 minutes, then twice as long after each crash, up to 2 hours', async () => {
    const { log, lines } = logLines();
    const { db, clock, processor, queue } = setup({ log, concurrency: 1 });
    pending(db, 'A');
    const starts = () => processor.process.mock.calls.length;
    const tick = async () => {
      queue.kick();
      await flush();
      await flush();
    };
    processor.process.mockRejectedValue(new Error('disk full'));
    await tick();
    expect(starts()).toBe(1);
    for (const [run, waitMinutes] of [[2, 15], [3, 30], [4, 60], [5, 120], [6, 120]] as const) {
      clock.advance(waitMinutes * MINUTE - 1);
      await tick();
      expect(starts(), `run ${run}`).toBe(run - 1);
      clock.advance(1);
      await tick();
      expect(starts(), `run ${run}`).toBe(run);
    }
    expect(lines.map((l) => (JSON.parse(l) as { waitMinutes: number }).waitMinutes)).toEqual([15, 30, 60, 120, 120, 120]);
    // A run that ends without a crash forgets the file's crashes: the next crash waits 15 minutes again.
    processor.process.mockResolvedValueOnce({ outcome: 'deferred', clientId: 1 });
    clock.advance(120 * MINUTE);
    await tick();
    expect(starts()).toBe(7);
    await tick(); // still due (this fake processor leaves the row as it was): the next tick tries it once more and it crashes
    expect(starts()).toBe(8);
    clock.advance(15 * MINUTE - 1);
    await tick();
    expect(starts()).toBe(8);
    clock.advance(1);
    await tick();
    expect(starts()).toBe(9);
  });

  it('a crashed file held back does not keep a due file behind it waiting', async () => {
    const { db, processor, queue } = setup({ concurrency: 1 });
    const [a, b] = ['A', 'B'].map((w) => pending(db, w));
    processor.process.mockRejectedValueOnce(new Error('disk full'));
    queue.kick();
    await flush();
    await flush();
    queue.kick();
    await flush();
    expect(processor.process.mock.calls.map(([id]) => id)).toEqual([a, b]);
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
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** The real processor behind the queue, wired as the app wires them: the ingestor kicks the queue for each file it stores. */
  function withProcessor(o: { fetcher?: MediaFetcher; extract?: Extractor; extractFor?: (db: Db, clock: Clock) => Extractor } = {}) {
    const dataDir = mkdtempSync(join(tmpdir(), 'wa-queue-'));
    dirs.push(dataDir);
    const db = seededDb();
    const clock = manualClock('2026-10-19T08:00:00Z');
    const sealer = new MediaRefSealer(Buffer.alloc(32, 5));
    const real = new MediaProcessor({
      db, dataDir, clock, log: silentLogger(), sealer,
      fetcher: o.fetcher ?? (async () => Buffer.from('jpeg-bytes')),
      extract: o.extractFor?.(db, clock) ?? o.extract ?? (async () => ({ textKind: 'description', text: 'A blue banner', pageCount: null, note: null })),
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

  // Final review FR1 (the reviewer's probe): writes start failing while a paid read is in flight, so neither its spend nor
  // its result can be saved. Before the fix every kick read the image again and paid again, with nothing booked.
  it('when the database stops taking writes during a paid read, 20 more kicks pay for nothing more', async () => {
    const P: Prices = { inputPerMTok: 4, outputPerMTok: 20, cacheWritePerMTok: 5, cacheReadPerMTok: 0.2 };
    const fake = new FakeMediaAi();
    const prepareImage = async (): Promise<PreparedImage> => ({ data: Buffer.from('small'), mediaType: 'image/jpeg', width: 10, height: 10 });
    let spend!: SpendGuard;
    const { db, clock, processor, queue, share } = withProcessor({
      extractFor: (db, clock) => {
        spend = new SpendGuard({ db, clock, capUsd: 15 });
        const ai: MediaAi = {
          describeImage: async (img) => {
            const r = await fake.describeImage(img);
            // From now on the database refuses every update of a file and every spend booking, as on a full disk.
            db.exec(`CREATE TRIGGER IF NOT EXISTS refuse_media BEFORE UPDATE ON media BEGIN SELECT RAISE(ABORT, 'disk full'); END;
              CREATE TRIGGER IF NOT EXISTS refuse_spend BEFORE INSERT ON spend BEGIN SELECT RAISE(ABORT, 'disk full'); END;`);
            return r;
          },
          readScannedPdf: (pdf) => fake.readScannedPdf(pdf),
        };
        return createExtractor({ ai, spend, prices: P, prepareImage });
      },
    });
    const id = share('IMG1'); // the ingestor kicks the queue
    await queue.drain(5_000);
    expect(fake.calls).toHaveLength(1);
    for (let i = 0; i < 20; i++) {
      clock.advance(MINUTE);
      queue.kick();
      await queue.drain(5_000);
    }
    expect(fake.calls).toHaveLength(1);
    expect(processor.process.mock.calls.length).toBeLessThanOrEqual(2); // the run that paid, and one claim that could not be written
    expect(getMedia(db, id)).toMatchObject({ status: 'pending', attempts: 1 });
    expect(spend.spentToday()).toBe(0);
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
    const onSettled = vi.fn();
    const queue = new MediaQueue({ db, clock: manualClock('2026-10-19T08:00:00Z'), log: silentLogger(), processor, concurrency: 2, onSettled });
    queue.kick();
    await flush();
    expect(calls).toEqual([a, b, c, d]); // more stuck files than slots ahead of D still do not keep D waiting
    expect(queue.active).toBe(0);
    queue.kick(); // the next tick
    await flush();
    expect(calls).toEqual([a, b, c, d, a, b, c]);
    expect(queue.active).toBe(0);
    // Only D reached a final state: a skipped file (an inactive client's, say) never wakes the reconciler.
    expect(onSettled).toHaveBeenCalledTimes(1);
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
