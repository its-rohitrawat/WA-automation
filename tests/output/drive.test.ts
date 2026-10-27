import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DriveAuthError, DrivePublisher } from '../../src/output/drive.ts';
import { getKv } from '../../src/store/kv.ts';
import { createLogger, silentLogger } from '../../src/util/logger.ts';
import { seededDb } from '../helpers/db.ts';
import { FakeDrive } from '../helpers/fakeDrive.ts';

let publisher: DrivePublisher | undefined;
afterEach(() => {
  publisher?.stop();
  vi.useRealTimers();
});

function setup(build: () => Promise<Buffer> = vi.fn(async () => Buffer.from('xlsx-bytes')), log = silentLogger()) {
  const db = seededDb();
  const drive = new FakeDrive();
  publisher = new DrivePublisher({ db, api: drive, build, log, minIntervalMs: 60_000 });
  return { db, drive, build, p: publisher };
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

describe('DrivePublisher', () => {
  it('creates the folder and file once, then updates the same file', async () => {
    const { db, drive, p } = setup();
    await p.publishNow();
    await p.publishNow();
    expect(drive.folders).toEqual(['WA Agent']);
    expect(drive.created.map((f) => f.name)).toEqual(['Tracker.xlsx']);
    expect(drive.updated).toHaveLength(1);
    expect(getKv(db, 'drive_tracker_id')).toBe(drive.created[0]!.id);
  });

  it('recreates the file if someone removed it from Drive', async () => {
    const { drive, p } = setup();
    await p.publishNow();
    drive.missing.add(drive.created[0]!.id);
    await p.publishNow();
    expect(drive.created).toHaveLength(2);
  });

  it('publishes at most once a minute, with one trailing run', async () => {
    vi.useFakeTimers();
    const { build, p } = setup();
    p.schedule();
    await vi.advanceTimersByTimeAsync(0);
    expect(build).toHaveBeenCalledTimes(1);
    p.schedule();
    p.schedule();
    p.schedule();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(build).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('backs off after a failure and then recovers', async () => {
    vi.useFakeTimers();
    const { drive, p } = setup();
    drive.failNext = 1;
    p.schedule();
    await vi.advanceTimersByTimeAsync(0);
    expect(drive.uploads).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(drive.uploads).toBe(1);
  });

  it('logs a build failure as step build at error level and never calls Drive', async () => {
    const { lines, log } = capturingLogger();
    const build = vi.fn(async (): Promise<Buffer> => {
      throw new Error('secret-detail-in-message');
    });
    const { drive, p } = setup(build, log);
    await p.publishNow();
    expect(drive.folders).toEqual([]);
    expect(drive.uploads).toBe(0);
    const entry = lines.find((l) => l.step === 'build');
    expect(entry).toBeDefined();
    expect(entry!.level).toBe(50);
    expect((entry!.err as { type: string }).type).toBe('Error');
    expect(JSON.stringify(lines)).not.toContain('secret-detail-in-message');
  });

  it('logs a non-404 Drive failure as step drive at warn level', async () => {
    const { lines, log } = capturingLogger();
    const { drive, p } = setup(undefined, log);
    await p.publishNow();
    drive.failUpdateWith = Object.assign(new Error('token-echo-abc'), { code: 500 });
    await p.publishNow();
    const entry = lines.find((l) => l.step === 'drive');
    expect(entry).toBeDefined();
    expect(entry!.level).toBe(40);
    expect((entry!.err as { type: string }).type).toBe('Error');
    expect(JSON.stringify(lines)).not.toContain('token-echo-abc');
  });

  it('backs off 60 s, 120 s, 240 s ... and caps at 15 minutes', async () => {
    vi.useFakeTimers();
    const stamps: number[] = [];
    const build = vi.fn(async () => {
      stamps.push(Date.now());
      throw new Error('x');
    });
    const { p } = setup(build);
    await p.publishNow();
    await vi.advanceTimersByTimeAsync(60_000 + 120_000 + 240_000 + 480_000 + 900_000 + 900_000);
    const gaps = stamps.slice(1).map((t, i) => t - stamps[i]!);
    expect(gaps).toEqual([60_000, 120_000, 240_000, 480_000, 900_000, 900_000]);
  });

  it('schedule() during a run gives exactly one follow-up run', async () => {
    vi.useFakeTimers();
    const { drive, p } = setup();
    let release!: () => void;
    drive.gate = new Promise<void>((r) => (release = r));
    p.schedule();
    await vi.advanceTimersByTimeAsync(0);
    p.schedule();
    p.schedule();
    p.schedule();
    drive.gate = undefined;
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(drive.uploads).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(drive.uploads).toBe(2);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(drive.uploads).toBe(2);
  });

  it('publishNow() during a run does not start a second run', async () => {
    const { drive, build, p } = setup();
    let release!: () => void;
    drive.gate = new Promise<void>((r) => (release = r));
    const first = p.publishNow();
    await new Promise((r) => setTimeout(r, 10));
    const second = p.publishNow();
    release();
    await Promise.all([first, second]);
    expect(build).toHaveBeenCalledTimes(1);
    expect(drive.folders).toHaveLength(1);
    expect(drive.created).toHaveLength(1);
  });

  describe('publishNow() result', () => {
    it('resolves true when the run it started published', async () => {
      const { p } = setup();
      await expect(p.publishNow()).resolves.toBe(true);
    });

    it('resolves false when the run failed (build or Drive)', async () => {
      const failingBuild = setup(vi.fn(async (): Promise<Buffer> => { throw new Error('boom'); }));
      await expect(failingBuild.p.publishNow()).resolves.toBe(false);
      await failingBuild.p.stop();

      const { drive, p } = setup();
      drive.failNext = 1;
      await expect(p.publishNow()).resolves.toBe(false);
    });

    it('during a run, resolves with that run’s result', async () => {
      const { drive, p } = setup();
      let release!: () => void;
      drive.gate = new Promise<void>((r) => (release = r));
      const first = p.publishNow();
      await new Promise((r) => setTimeout(r, 10));
      const second = p.publishNow();
      release();
      await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    });

    it('during a run that fails, both calls resolve false', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const { p } = setup(vi.fn(async (): Promise<Buffer> => {
        await gate;
        throw new Error('boom');
      }));
      const first = p.publishNow();
      await new Promise((r) => setTimeout(r, 10));
      const second = p.publishNow();
      release();
      await expect(Promise.all([first, second])).resolves.toEqual([false, false]);
      await p.stop();
    });

    it('resolves false once stopped, and starts nothing', async () => {
      const { build, p } = setup();
      await p.stop();
      await expect(p.publishNow()).resolves.toBe(false);
      expect(build).not.toHaveBeenCalled();
    });
  });

  it('await stop() waits for an in-flight create and the file id is saved', async () => {
    const { db, drive, p } = setup();
    let release!: () => void;
    drive.gate = new Promise<void>((r) => (release = r));
    void p.publishNow();
    await new Promise((r) => setTimeout(r, 10));
    const stopped = p.stop();
    setTimeout(release, 20);
    await stopped;
    expect(getKv(db, 'drive_tracker_id')).toBe(drive.created[0]!.id);
  });

  it('stop() with a hung run resolves at its timeout and leaves no timers', async () => {
    vi.useFakeTimers();
    const { drive, p } = setup();
    drive.gate = new Promise<void>(() => {});
    void p.publishNow();
    await vi.advanceTimersByTimeAsync(0);
    let done = false;
    void p.stop(5_000).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  describe('flush()', () => {
    it('waits for the upload in flight, then makes exactly one more for changes that arrived meanwhile', async () => {
      vi.useFakeTimers();
      const { drive, build, p } = setup();
      let release!: () => void;
      drive.gate = new Promise<void>((r) => (release = r));
      p.schedule();
      await vi.advanceTimersByTimeAsync(0); // upload 1 is in flight
      p.schedule(); // a change arrives during it
      p.schedule();
      let done = false;
      void p.flush(10_000).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(done).toBe(false);
      drive.gate = undefined;
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(done).toBe(true);
      expect(build).toHaveBeenCalledTimes(2);
      expect(drive.uploads).toBe(2);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('runs a scheduled publish at once instead of waiting for the throttle', async () => {
      vi.useFakeTimers();
      const { drive, p } = setup();
      await p.publishNow();
      p.schedule(); // throttled: would wait 60 s
      expect(vi.getTimerCount()).toBe(1);
      await p.flush(10_000);
      expect(drive.uploads).toBe(2);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('uploads nothing more when nothing is pending or scheduled', async () => {
      vi.useFakeTimers();
      const { drive, p } = setup();
      await p.publishNow();
      await p.flush(10_000);
      expect(drive.uploads).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('retries once, without a backoff timer, when the upload in flight fails', async () => {
      vi.useFakeTimers();
      let fail!: () => void;
      const held = new Promise<void>((r) => (fail = r));
      const build = vi.fn(async () => Buffer.from('xlsx-bytes'));
      build.mockImplementationOnce(async () => {
        await held;
        throw new Error('x');
      });
      const { drive, p } = setup(build);
      p.schedule();
      await vi.advanceTimersByTimeAsync(0); // the failing run is in flight
      let done = false;
      void p.flush(10_000).then(() => (done = true));
      fail();
      await vi.advanceTimersByTimeAsync(0);
      expect(done).toBe(true);
      expect(build).toHaveBeenCalledTimes(2);
      expect(drive.uploads).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('resolves at its timeout when the upload hangs, and leaves no timers', async () => {
      vi.useFakeTimers();
      const { drive, p } = setup();
      drive.gate = new Promise<void>(() => {});
      p.schedule();
      await vi.advanceTimersByTimeAsync(0);
      p.schedule();
      let done = false;
      void p.flush(5_000).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(4_999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('blocks new runs afterwards, like stop()', async () => {
      vi.useFakeTimers();
      const { build, p } = setup();
      await p.flush(10_000);
      p.schedule();
      await p.publishNow();
      await vi.advanceTimersByTimeAsync(300_000);
      expect(build).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('recovers from a deleted root folder in one run', async () => {
    const { lines, log } = capturingLogger();
    const { drive, p } = setup(undefined, log);
    await p.publishNow();
    drive.missing.add('folder-1');
    drive.missing.add(drive.created[0]!.id);
    await p.publishNow();
    expect(drive.folders).toEqual(['WA Agent', 'WA Agent']);
    expect(drive.created).toHaveLength(2);
    expect(drive.created[1]!.parentId).not.toBe('folder-1');
    expect(lines.filter((l) => (l.level as number) >= 40)).toEqual([]);
  });

  it('an onPublished that throws is logged and does not cause a re-upload', async () => {
    const { lines, log } = capturingLogger();
    const db = seededDb();
    const drive = new FakeDrive();
    publisher = new DrivePublisher({
      db,
      api: drive,
      build: async () => Buffer.from('x'),
      log,
      onPublished: () => {
        throw new Error('hook-bug');
      },
    });
    await publisher.publishNow();
    expect(drive.uploads).toBe(1);
    expect(lines.some((l) => l.msg === 'onPublished failed' && l.level === 50)).toBe(true);
    expect(lines.some((l) => l.msg === 'Drive publish failed')).toBe(false);
  });

  it('a 401 from updateFile becomes DriveAuthError and calls onFailure with auth true', async () => {
    const { lines, log } = capturingLogger();
    const db = seededDb();
    const drive = new FakeDrive();
    const failures: { step: string; auth: boolean }[] = [];
    publisher = new DrivePublisher({ db, api: drive, build: async () => Buffer.from('x'), log, onFailure: (f) => failures.push(f) });
    await publisher.publishNow();
    drive.failUpdateWith = Object.assign(new Error('Request had invalid credentials'), { code: 401 });
    await publisher.publishNow();
    expect(failures).toEqual([{ step: 'drive', auth: true }]);
    const entry = lines.find((l) => l.step === 'drive')!;
    expect((entry.err as { type: string }).type).toBe('DriveAuthError');
    expect(JSON.stringify(lines)).not.toContain('invalid credentials');
  });

  it('invalid_grant in the response body counts as an auth failure; other failures do not', async () => {
    const db = seededDb();
    const drive = new FakeDrive();
    const failures: { step: string; auth: boolean }[] = [];
    publisher = new DrivePublisher({ db, api: drive, build: async () => Buffer.from('x'), log: silentLogger(), onFailure: (f) => failures.push(f) });
    await publisher.publishNow();
    drive.failUpdateWith = Object.assign(new Error('bad'), { response: { data: { error: 'invalid_grant' } } });
    await publisher.publishNow();
    drive.failUpdateWith = Object.assign(new Error('bad'), { code: 500 });
    await publisher.publishNow();
    expect(failures.map((f) => f.auth)).toEqual([true, false]);
    expect(new DriveAuthError(new Error('x')).name).toBe('DriveAuthError');
  });
});
