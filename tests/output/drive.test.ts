import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DriveAuthError, DrivePublisher } from '../../src/output/drive.ts';
import { TRACKER_ID_KEY, TRACKER_NEW_FILE_KEY } from '../../src/output/trackerKey.ts';
import { getKv, setKv } from '../../src/store/kv.ts';
import { createLogger, silentLogger } from '../../src/util/logger.ts';
import { seededDb } from '../helpers/db.ts';
import { FakeDrive } from '../helpers/fakeDrive.ts';

let publisher: DrivePublisher | undefined;
afterEach(() => {
  publisher?.stop();
  vi.useRealTimers();
});

async function setup(build: () => Promise<Buffer> = vi.fn(async () => Buffer.from('xlsx-bytes')), log = silentLogger()) {
  const db = await seededDb();
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
    const { db, drive, p } = await setup();
    await p.publishNow();
    await p.publishNow();
    expect(drive.folders).toEqual(['WA Agent']);
    expect(drive.created.map((f) => f.name)).toEqual(['Tracker.xlsx']);
    expect(drive.updated).toHaveLength(1);
    expect(await getKv(db, 'drive_tracker_id')).toBe(drive.created[0]!.id);
  });

  it('recreates the file if someone removed it from Drive', async () => {
    const { drive, p } = await setup();
    await p.publishNow();
    drive.missing.add(drive.created[0]!.id);
    await p.publishNow();
    expect(drive.created).toHaveLength(2);
  });

  it('publishes at most once a minute, with one trailing run', async () => {
    vi.useFakeTimers();
    const { build, p } = await setup();
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
    const { drive, p } = await setup();
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
    const { drive, p } = await setup(build, log);
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
    const { drive, p } = await setup(undefined, log);
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
    const { p } = await setup(build);
    await p.publishNow();
    await vi.advanceTimersByTimeAsync(60_000 + 120_000 + 240_000 + 480_000 + 900_000 + 900_000);
    const gaps = stamps.slice(1).map((t, i) => t - stamps[i]!);
    expect(gaps).toEqual([60_000, 120_000, 240_000, 480_000, 900_000, 900_000]);
  });

  it('schedule() during a run gives exactly one follow-up run', async () => {
    vi.useFakeTimers();
    const { drive, p } = await setup();
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
    const { drive, build, p } = await setup();
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
      const { p } = await setup();
      await expect(p.publishNow()).resolves.toBe(true);
    });

    it('resolves false when the run failed (build or Drive)', async () => {
      const failingBuild = await setup(vi.fn(async (): Promise<Buffer> => { throw new Error('boom'); }));
      await expect(failingBuild.p.publishNow()).resolves.toBe(false);
      await failingBuild.p.stop();

      const { drive, p } = await setup();
      drive.failNext = 1;
      await expect(p.publishNow()).resolves.toBe(false);
    });

    it('during a run, resolves with that run’s result', async () => {
      const { drive, p } = await setup();
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
      const { p } = await setup(vi.fn(async (): Promise<Buffer> => {
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
      const { build, p } = await setup();
      await p.stop();
      await expect(p.publishNow()).resolves.toBe(false);
      expect(build).not.toHaveBeenCalled();
    });
  });

  it('await stop() waits for an in-flight create and the file id is saved', async () => {
    const { db, drive, p } = await setup();
    let release!: () => void;
    drive.gate = new Promise<void>((r) => (release = r));
    void p.publishNow();
    await new Promise((r) => setTimeout(r, 10));
    const stopped = p.stop();
    setTimeout(release, 20);
    await stopped;
    expect(await getKv(db, 'drive_tracker_id')).toBe(drive.created[0]!.id);
  });

  it('stop() with a hung run resolves at its timeout and leaves no timers', async () => {
    vi.useFakeTimers();
    const { drive, p } = await setup();
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
      const { drive, build, p } = await setup();
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
      const { drive, p } = await setup();
      await p.publishNow();
      p.schedule(); // throttled: would wait 60 s
      expect(vi.getTimerCount()).toBe(1);
      await p.flush(10_000);
      expect(drive.uploads).toBe(2);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('uploads nothing more when nothing is pending or scheduled', async () => {
      vi.useFakeTimers();
      const { drive, p } = await setup();
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
      const { drive, p } = await setup(build);
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
      const { drive, p } = await setup();
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
      const { build, p } = await setup();
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
    const { drive, p } = await setup(undefined, log);
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
    const db = await seededDb();
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
    const db = await seededDb();
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
    const db = await seededDb();
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

describe('DrivePublisher keeps one tracker file', () => {
  const AT = new Date('2026-10-28T05:00:00.000Z');

  async function keep(log = silentLogger()) {
    const db = await seededDb();
    const drive = new FakeDrive();
    const newFiles: number[] = [];
    publisher = new DrivePublisher({
      db, api: drive, build: async () => Buffer.from('x'), log, minIntervalMs: 0, now: () => AT, onNewFile: () => newFiles.push(1),
    });
    return { db, drive, newFiles, p: publisher };
  }

  it('repeated publishes update the same id and never look for or create a second file', async () => {
    const { db, drive, newFiles, p } = await keep();
    for (let i = 0; i < 4; i++) expect(await p.publishNow()).toBe(true);
    expect(drive.created).toHaveLength(1);
    expect(drive.updated.map((u) => u.id)).toEqual(Array(3).fill(drive.created[0]!.id));
    expect(drive.findCalls).toEqual([]); // the first run made the folder just now: nothing to look for in it
    expect(await getKv(db, TRACKER_ID_KEY)).toBe(drive.created[0]!.id);
    expect(await getKv(db, TRACKER_NEW_FILE_KEY)).toBeUndefined();
    expect(newFiles).toEqual([]);
  });

  it('a 404 with a visible Tracker.xlsx in the folder reuses the newest one and stores its id', async () => {
    const { db, drive, newFiles, p } = await keep();
    await p.publishNow();
    const old = drive.created[0]!.id;
    drive.missing.add(old); // the login changed: the stored file is invisible now
    drive.visible.push({ id: 'seen-older', name: 'Tracker.xlsx', parentId: 'folder-1' }, { id: 'other-name', name: 'Notes.xlsx', parentId: 'folder-1' },
      { id: 'seen-newest', name: 'Tracker.xlsx', parentId: 'folder-1' }, { id: 'elsewhere', name: 'Tracker.xlsx', parentId: 'folder-9' });
    expect(await p.publishNow()).toBe(true);
    expect(drive.findCalls).toEqual([{ name: 'Tracker.xlsx', parentId: 'folder-1' }]);
    expect(drive.created).toHaveLength(1);
    expect(drive.updated.map((u) => u.id)).toEqual(['seen-newest']);
    expect(await getKv(db, TRACKER_ID_KEY)).toBe('seen-newest');
    expect(await getKv(db, TRACKER_NEW_FILE_KEY)).toBeUndefined();
    expect(newFiles).toEqual([]);
    await p.publishNow(); // from now on the found file is the one
    expect(drive.updated.map((u) => u.id)).toEqual(['seen-newest', 'seen-newest']);
    expect(drive.findCalls).toHaveLength(1);
  });

  it('a stored folder with no stored file id looks in it first', async () => {
    const { db, drive, newFiles, p } = await keep();
    await setKv(db, 'drive_root_id', 'root-a');
    drive.visible.push({ id: 'seen-1', name: 'Tracker.xlsx', parentId: 'root-a' });
    await p.publishNow();
    expect(drive.created).toEqual([]);
    expect(await getKv(db, TRACKER_ID_KEY)).toBe('seen-1');
    expect(newFiles).toEqual([]);
  });

  it('a 404 with none visible creates one, keeps its id, calls onNewFile once and sets the note date', async () => {
    const { db, drive, newFiles, p } = await keep();
    await p.publishNow();
    drive.missing.add(drive.created[0]!.id);
    await p.publishNow();
    expect(drive.findCalls).toHaveLength(1);
    expect(drive.created).toHaveLength(2);
    expect(drive.created[1]!.parentId).toBe('folder-1');
    expect(await getKv(db, TRACKER_ID_KEY)).toBe(drive.created[1]!.id);
    expect(await getKv(db, TRACKER_NEW_FILE_KEY)).toBe(AT.toISOString());
    expect(newFiles).toEqual([1]);
    await p.publishNow();
    expect(drive.created).toHaveLength(2);
    expect(newFiles).toEqual([1]);
  });

  it('the first file ever made is no new-file event', async () => {
    const { db, drive, newFiles, p } = await keep();
    await setKv(db, 'drive_root_id', 'root-a');
    await p.publishNow();
    expect(drive.findCalls).toHaveLength(1);
    expect(drive.created).toHaveLength(1);
    expect(await getKv(db, TRACKER_NEW_FILE_KEY)).toBeUndefined();
    expect(newFiles).toEqual([]);
  });

  it('the folder-gone path re-creates the folder and the file in one run, as before, and notes the new file', async () => {
    const { db, drive, newFiles, p } = await keep();
    await p.publishNow();
    drive.missing.add('folder-1');
    drive.missing.add(drive.created[0]!.id);
    expect(await p.publishNow()).toBe(true);
    expect(drive.folders).toEqual(['WA Agent', 'WA Agent']);
    expect(drive.created).toHaveLength(2);
    expect(drive.created[1]!.parentId).not.toBe('folder-1');
    expect(await getKv(db, 'drive_root_id')).toBe(drive.created[1]!.parentId);
    expect(await getKv(db, TRACKER_ID_KEY)).toBe(drive.created[1]!.id);
    expect(newFiles).toEqual([1]);
  });

  it('when the stored folder and file are both invisible, a Tracker.xlsx in another visible WA Agent folder is reused', async () => {
    const { db, drive, newFiles, p } = await keep();
    await p.publishNow();
    drive.missing.add('folder-1'); // another login: the old folder and its file cannot be seen
    drive.missing.add(drive.created[0]!.id);
    drive.visibleFolders.push({ id: 'other-older', name: 'WA Agent' }, { id: 'not-ours', name: 'Photos' }, { id: 'other-newest', name: 'WA Agent' });
    drive.visible.push({ id: 'kept-file', name: 'Tracker.xlsx', parentId: 'other-older' });
    expect(await p.publishNow()).toBe(true);
    expect(drive.findFolderCalls).toEqual(['WA Agent']);
    expect(drive.findCalls.map((c) => c.parentId)).toEqual(['folder-1', 'other-newest', 'other-older']);
    expect(drive.folders).toEqual(['WA Agent']);
    expect(drive.created).toHaveLength(1);
    expect(drive.updated.map((u) => u.id)).toEqual(['kept-file']);
    expect(await getKv(db, 'drive_root_id')).toBe('other-older');
    expect(await getKv(db, TRACKER_ID_KEY)).toBe('kept-file');
    expect(await getKv(db, TRACKER_NEW_FILE_KEY)).toBeUndefined();
    expect(newFiles).toEqual([]);
  });

  it('switching back to the first login finds the original file again instead of making a third', async () => {
    const { db, drive, newFiles, p } = await keep();
    await p.publishNow();
    const first = { folder: 'folder-1', file: drive.created[0]!.id };
    drive.missing.add(first.folder); // login B: nothing of login A can be seen
    drive.missing.add(first.file);
    await p.publishNow();
    expect(drive.created).toHaveLength(2);
    expect(newFiles).toEqual([1]);
    const second = { folder: (await getKv(db, 'drive_root_id'))!, file: (await getKv(db, TRACKER_ID_KEY))! };
    drive.missing.clear(); // back to login A: its folder and file are visible again, login B's are not
    drive.missing.add(second.folder);
    drive.missing.add(second.file);
    expect(await p.publishNow()).toBe(true);
    expect(drive.created).toHaveLength(2);
    expect(drive.folders).toHaveLength(2);
    expect(drive.updated.at(-1)!.id).toBe(first.file);
    expect(await getKv(db, 'drive_root_id')).toBe(first.folder);
    expect(await getKv(db, TRACKER_ID_KEY)).toBe(first.file);
    expect(newFiles).toEqual([1]);
    await p.publishNow(); // and it stays on the original
    expect(drive.updated.at(-1)!.id).toBe(first.file);
    expect(drive.created).toHaveLength(2);
  });

  it('a visible WA Agent folder without a Tracker.xlsx is not adopted: the file is made in the stored folder', async () => {
    const { db, drive, p } = await keep();
    await p.publishNow();
    drive.missing.add(drive.created[0]!.id);
    drive.visibleFolders.push({ id: 'empty-one', name: 'WA Agent' });
    await p.publishNow();
    expect(drive.created).toHaveLength(2);
    expect(drive.created[1]!.parentId).toBe('folder-1');
    expect(await getKv(db, 'drive_root_id')).toBe('folder-1');
  });

  it('a failed look-up fails the run like any Drive error, and keeps the stored id', async () => {
    const { db, drive, newFiles, p } = await keep();
    await p.publishNow();
    const old = drive.created[0]!.id;
    drive.missing.add(old);
    const find = drive.findFile.bind(drive);
    drive.findFile = async (n, parent) => {
      await find(n, parent);
      throw Object.assign(new Error('backend error'), { code: 500 });
    };
    expect(await p.publishNow()).toBe(false);
    expect(drive.created).toHaveLength(1);
    expect(await getKv(db, TRACKER_ID_KEY)).toBe(old);
    expect(newFiles).toEqual([]);
    await p.stop(1000);
  });

  it('an onNewFile that throws is logged and the run still counts as published', async () => {
    const { lines, log } = capturingLogger();
    const db = await seededDb();
    const drive = new FakeDrive();
    publisher = new DrivePublisher({ db, api: drive, build: async () => Buffer.from('x'), log, onNewFile: () => {
      throw new Error('hook-bug');
    } });
    await publisher.publishNow();
    drive.missing.add(drive.created[0]!.id);
    expect(await publisher.publishNow()).toBe(true);
    expect(lines.some((l) => l.msg === 'onNewFile failed' && l.level === 50)).toBe(true);
    expect(await getKv(db, TRACKER_NEW_FILE_KEY)).toEqual(expect.any(String));
  });

  it('no file or folder id reaches the logs on any of these paths', async () => {
    const { lines, log } = capturingLogger();
    const { drive, p } = await keep(log);
    await p.publishNow();
    const ids = ['folder-1', drive.created[0]!.id, 'seen-newest'];
    drive.missing.add(drive.created[0]!.id);
    drive.visible.push({ id: 'seen-newest', name: 'Tracker.xlsx', parentId: 'folder-1' });
    await p.publishNow();
    drive.missing.add('seen-newest');
    await p.publishNow();
    drive.missing.add('folder-1');
    drive.missing.add(drive.created.at(-1)!.id);
    await p.publishNow();
    ids.push(...drive.created.map((f) => f.id), 'folder-');
    drive.failUpdateWith = Object.assign(new Error(`Drive item ${drive.created.at(-1)!.id} not found`), { code: 500 });
    await p.publishNow();
    await p.stop(1000);
    const text = JSON.stringify(lines);
    expect(lines.length).toBeGreaterThan(0);
    for (const id of ids) expect(text).not.toContain(id);
  });
});
