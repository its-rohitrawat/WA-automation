import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DrivePublisher } from '../../src/output/drive.ts';
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
    expect(JSON.stringify(lines)).not.toContain('token-echo-abc');
  });
});
