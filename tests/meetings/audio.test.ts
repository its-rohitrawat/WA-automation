import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, type PathLike } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupTemp, MEETING_DISK_HEADROOM_BYTES, MEETING_MAX_BYTES, MeetingDeferral, MeetingFailure, prepareAudio, type PrepareAudioDeps,
} from '../../src/meetings/audio.ts';
import { DownloadTooBigError } from '../../src/meetings/googleErrors.ts';
import { AudioError, Ffmpeg, type RunFile, type RunOptions } from '../../src/stt/audio.ts';
import type { Db } from '../../src/store/db.ts';
import { advanceStage, getMeeting, insertFound, type MeetingStatus, type NewMeeting } from '../../src/store/meetings.ts';
import { manualClock } from '../../src/util/clock.ts';
import { createLogger, silentLogger } from '../../src/util/logger.ts';
import { NOW, seededDb } from '../helpers/db.ts';
import { FakeMeetingsApi } from '../helpers/fakeMeetings.ts';

// Hooks into the fs calls src/meetings/audio.ts makes, so a test can make one fail (EPERM, EXDEV) as Windows can.
const fsHooks = vi.hoisted(() => ({
  unlink: undefined as ((path: string) => void) | undefined,
  rename: undefined as ((from: string, to: string) => void) | undefined,
}));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    unlinkSync: (path: PathLike) => {
      fsHooks.unlink?.(String(path));
      real.unlinkSync(path);
    },
    renameSync: (from: PathLike, to: PathLike) => {
      fsHooks.rename?.(String(from), String(to));
      real.renameSync(from, to);
    },
  };
});
const fsError = (code: string) => Object.assign(new Error(`fake ${code}`), { code });

const dirs: string[] = [];
const tempDir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterEach(() => {
  fsHooks.unlink = undefined;
  fsHooks.rename = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const FILE_ID = 'fileAbc123';
// 20:00 UTC on 31 Oct is 01:30 on 1 Nov in India: the folder is the India month.
const STARTED = '2026-10-31T20:00:00.000Z';
const BANNER = (seconds: number) => `Input #0, mp3, from 'x':\n  Duration: 00:${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}.00, start: 0\n`;

let seq = 0;
const newMeeting = (o: Partial<NewMeeting> = {}): NewMeeting => ({
  recording: `conferenceRecords/c1/recordings/r${++seq}`,
  conference: 'conferenceRecords/c1',
  driveFileId: FILE_ID,
  meetingCode: 'abc-defg-hij',
  title: 'Sharma weekly',
  startedAt: STARTED,
  endedAt: null,
  attendees: [],
  participants: [],
  clientId: 1,
  matchKind: 'title',
  status: 'queued',
  driveSeconds: 2700,
  createdAt: NOW,
  ...o,
});

interface FakeFfmpeg {
  run: RunFile;
  opts: RunOptions[];
  /** Inputs ffmpeg was run on, in order. */
  inputs: string[];
  /** The conversion: 'ok' writes the output, 'fail' exits 1, 'hang' writes a partial output and waits for the signal. */
  convert: 'ok' | 'fail' | 'hang';
  seconds: number;
  /** Resolves when a hanging conversion has started. */
  hung: Promise<void>;
}

function fakeFfmpeg(): FakeFfmpeg {
  let started: () => void = () => {};
  const f: FakeFfmpeg = {
    opts: [],
    inputs: [],
    convert: 'ok',
    seconds: 2700,
    hung: new Promise<void>((r) => (started = r)),
    run: async (_file, args, o) => {
      f.opts.push(o);
      const out = args[args.length - 1]!;
      f.inputs.push(args[args.indexOf('-i') + 1]!);
      if (args.includes('libmp3lame')) {
        if (f.convert === 'fail') return { code: 1, stderr: '' };
        writeFileSync(out, 'mp3-bytes');
        if (f.convert === 'hang') {
          started();
          await new Promise<void>((resolve) => o.signal?.addEventListener('abort', () => resolve(), { once: true }));
          return { code: -1, stderr: '' };
        }
        return { code: 0, stderr: '' };
      }
      return { code: 1, stderr: BANNER(f.seconds) };
    },
  };
  return f;
}

describe('prepareAudio', () => {
  let dataDir: string;
  let db: Db;
  let api: FakeMeetingsApi;
  let ff: FakeFfmpeg;
  let free: number;
  let id: number;
  const tmp = () => join(dataDir, 'meetings', 'tmp');
  const finalAbs = () => join(dataDir, 'meetings', 'SHA', '2026-11', `${id}.mp3`);
  const deps = (o: Partial<PrepareAudioDeps> = {}): PrepareAudioDeps => ({
    db, api, ffmpeg: new Ffmpeg('ffmpeg.exe', ff.run), dataDir, clock: manualClock('2026-11-01T10:00:00.000Z'), log: silentLogger(),
    maxMinutes: 180, freeBytes: async () => free, ...o,
  });
  const row = () => getMeeting(db, id)!;

  beforeEach(() => {
    dataDir = tempDir('meet-audio-');
    db = seededDb();
    api = new FakeMeetingsApi();
    api.files.set(FILE_ID, { info: { name: 'rec.mp4', size: 4000, mimeType: 'video/mp4', durationMs: 2_700_000 }, bytes: Buffer.from('video-bytes') });
    ff = fakeFfmpeg();
    free = 50 * 1024 ** 3;
    id = insertFound(db, newMeeting())!;
  });

  it('downloads, converts, measures, deletes the video and keeps the MP3 in the client month folder', async () => {
    const r = await prepareAudio(row(), deps(), new AbortController().signal);
    const rel = `meetings/SHA/2026-11/${id}.mp3`;
    expect(r).toEqual({ outcome: 'audio', audioPath: rel, audioSeconds: 2700 });
    expect(readFileSync(finalAbs(), 'utf8')).toBe('mp3-bytes');
    expect(readdirSync(tmp())).toEqual([]);
    expect(api.callsOf('download')).toEqual([[FILE_ID, join(tmp(), `${id}.mp4.part`), MEETING_MAX_BYTES]]);
    expect(ff.inputs).toEqual([join(tmp(), `${id}.mp4.part`), join(tmp(), `${id}.mp3`)]);
    const m = row();
    expect(m).toMatchObject({ status: 'queued', stage: 'audio', audioPath: rel, audioSeconds: 2700 });
    expect(m.audioPath).not.toContain('\\');
  });

  it('defers low_disk without downloading when free space is under the file size plus 10 GB', async () => {
    free = 4000 + MEETING_DISK_HEADROOM_BYTES - 1;
    const err = await prepareAudio(row(), deps(), new AbortController().signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MeetingDeferral);
    expect(err).toMatchObject({ code: 'low_disk' });
    expect(api.callsOf('download')).toHaveLength(0);
    expect(row()).toMatchObject({ status: 'queued', stage: 'found' });
    free = 4000 + MEETING_DISK_HEADROOM_BYTES;
    await expect(prepareAudio(row(), deps(), new AbortController().signal)).resolves.toMatchObject({ outcome: 'audio' });
  });

  it('an abort mid-download removes the temp file and rethrows the abort', async () => {
    // The download hangs (videoInfo before it answers at once).
    const download = api.download.bind(api);
    api.download = (...a) => {
      api.gate = new Promise<void>(() => {});
      return download(...a);
    };
    const ac = new AbortController();
    const reason = new Error('stopping');
    const p = prepareAudio(row(), deps(), ac.signal);
    await vi.waitFor(() => expect(existsSync(join(tmp(), `${id}.mp4.part`))).toBe(true), { timeout: 5000 });
    ac.abort(reason);
    await expect(p).rejects.toBe(reason);
    expect(readdirSync(tmp())).toEqual([]);
    expect(row()).toMatchObject({ status: 'queued', stage: 'found' });
  });

  it('an abort mid-ffmpeg reaches the runner, removes the temp files and rethrows the abort', async () => {
    ff.convert = 'hang';
    const ac = new AbortController();
    const reason = new Error('stopping');
    const p = prepareAudio(row(), deps(), ac.signal);
    await ff.hung;
    expect(ff.opts[0]!.signal).toBe(ac.signal);
    expect(readdirSync(tmp()).sort()).toEqual([`${id}.mp3.part.mp3`, `${id}.mp4.part`]);
    ac.abort(reason);
    await expect(p).rejects.toBe(reason);
    expect(readdirSync(tmp())).toEqual([]);
    expect(existsSync(finalAbs())).toBe(false);
  });

  it('an ffmpeg failure rethrows the AudioError with the temp files removed, and a retry downloads again', async () => {
    ff.convert = 'fail';
    const err = await prepareAudio(row(), deps(), new AbortController().signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AudioError);
    expect(err).toMatchObject({ code: 'convert_failed' });
    expect(readdirSync(tmp())).toEqual([]);
    expect(row()).toMatchObject({ status: 'queued', stage: 'found' });
    ff.convert = 'ok';
    await expect(prepareAudio(row(), deps(), new AbortController().signal)).resolves.toMatchObject({ outcome: 'audio' });
    expect(api.callsOf('download')).toHaveLength(2);
  });

  it('reuses an existing final MP3: measured only, nothing downloaded', async () => {
    mkdirSync(join(dataDir, 'meetings', 'SHA', '2026-11'), { recursive: true });
    writeFileSync(finalAbs(), 'kept');
    ff.seconds = 1200;
    const r = await prepareAudio(row(), deps(), new AbortController().signal);
    expect(r).toEqual({ outcome: 'audio', audioPath: `meetings/SHA/2026-11/${id}.mp3`, audioSeconds: 1200 });
    expect(api.calls).toHaveLength(0);
    expect(ff.inputs).toEqual([finalAbs()]);
    expect(readFileSync(finalAbs(), 'utf8')).toBe('kept');
    expect(row()).toMatchObject({ stage: 'audio', audioSeconds: 1200 });
  });

  it('removes a leftover download from a crash before downloading again', async () => {
    mkdirSync(tmp(), { recursive: true });
    writeFileSync(join(tmp(), `${id}.mp4.part`), 'half');
    await expect(prepareAudio(row(), deps(), new AbortController().signal)).resolves.toMatchObject({ outcome: 'audio' });
    expect(api.callsOf('download')).toHaveLength(1);
    expect(readdirSync(tmp())).toEqual([]);
  });

  it('a file over the download cap is too_long (too_big), with nothing left in tmp', async () => {
    api.failWith.set('download', new DownloadTooBigError());
    const err = await prepareAudio(row(), deps(), new AbortController().signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MeetingFailure);
    expect(err).toMatchObject({ status: 'too_long', code: 'too_big' });
    expect(readdirSync(tmp())).toEqual([]);
  });

  it('a measured length over the limit is too_long, and the audio is kept', async () => {
    ff.seconds = 11 * 60;
    const r = await prepareAudio(row(), deps({ maxMinutes: 10 }), new AbortController().signal);
    expect(r).toEqual({ outcome: 'too_long', audioPath: `meetings/SHA/2026-11/${id}.mp3`, audioSeconds: 660 });
    expect(row()).toMatchObject({
      status: 'too_long', errorCode: 'too_long_measured', stage: 'found', audioPath: `meetings/SHA/2026-11/${id}.mp3`, audioSeconds: 660,
    });
    expect(existsSync(finalAbs())).toBe(true);
    expect(readdirSync(tmp())).toEqual([]);
  });

  it('a kept MP3 that cannot be measured is failed (bad_audio) and kept', async () => {
    mkdirSync(join(dataDir, 'meetings', 'SHA', '2026-11'), { recursive: true });
    writeFileSync(finalAbs(), 'not audio');
    ff.run = async (_f, _a, o) => {
      ff.opts.push(o);
      return { code: 1, stderr: 'Invalid data found when processing input' };
    };
    const err = await prepareAudio(row(), deps(), new AbortController().signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MeetingFailure);
    expect(err).toMatchObject({ status: 'failed', code: 'bad_audio' });
    expect(existsSync(finalAbs())).toBe(true);
    expect(api.calls).toHaveLength(0);
  });

  it('a video that cannot be removed after a good conversion is left for cleanupTemp; the MP3 is kept', async () => {
    const video = join(tmp(), `${id}.mp4.part`);
    fsHooks.unlink = (path) => {
      if (path === video) throw fsError('EPERM');
    };
    const lines: string[] = [];
    const log = createLogger('info', new Writable({ write(c, _e, cb) { lines.push(String(c)); cb(); } }));
    await expect(prepareAudio(row(), deps({ log }), new AbortController().signal)).resolves.toMatchObject({ outcome: 'audio' });
    expect(readFileSync(finalAbs(), 'utf8')).toBe('mp3-bytes');
    expect(readdirSync(tmp())).toEqual([`${id}.mp4.part`]);
    expect(row()).toMatchObject({ stage: 'audio' });
    const warning = lines.find((l) => l.includes('could not be removed'))!;
    expect(warning).toContain(`"meetingId":${id}`);
    expect(warning).toContain('"code":"EPERM"');
    expect(warning).not.toContain('mp4');
    fsHooks.unlink = undefined;
    expect(cleanupTemp(db, dataDir, silentLogger())).toEqual({ removed: 1, kept: 0 });
    expect(readdirSync(tmp())).toEqual([]);
  });

  it('a leftover that cannot be removed defers disk_busy without downloading', async () => {
    mkdirSync(tmp(), { recursive: true });
    writeFileSync(join(tmp(), `${id}.mp4.part`), 'half');
    fsHooks.unlink = () => {
      throw fsError('EPERM');
    };
    const err = await prepareAudio(row(), deps(), new AbortController().signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MeetingDeferral);
    expect(err).toMatchObject({ code: 'disk_busy' });
    expect(api.callsOf('download')).toHaveLength(0);
  });

  it('a move that fails defers disk_busy, with tmp emptied and no final MP3', async () => {
    fsHooks.rename = (from) => {
      if (from === join(tmp(), `${id}.mp3`)) throw fsError('EBUSY');
    };
    const err = await prepareAudio(row(), deps(), new AbortController().signal).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'MeetingDeferral', code: 'disk_busy' });
    expect(readdirSync(tmp())).toEqual([]);
    expect(existsSync(finalAbs())).toBe(false);
    expect(row()).toMatchObject({ status: 'queued', stage: 'found' });
  });

  it('a move across volumes (EXDEV) copies, then removes the source', async () => {
    fsHooks.rename = (from) => {
      if (from === join(tmp(), `${id}.mp3`)) throw fsError('EXDEV');
    };
    await expect(prepareAudio(row(), deps(), new AbortController().signal)).resolves.toMatchObject({ outcome: 'audio' });
    expect(readFileSync(finalAbs(), 'utf8')).toBe('mp3-bytes');
    expect(readdirSync(tmp())).toEqual([]);
  });

  it('a full disk during the download defers disk_full', async () => {
    api.failWith.set('download', fsError('ENOSPC'));
    const err = await prepareAudio(row(), deps(), new AbortController().signal).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'MeetingDeferral', code: 'disk_full' });
    expect(readdirSync(tmp())).toEqual([]);
  });

  it('ffmpeg calls get none of the parent environment by default', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'dummy-test-value';
    try {
      await prepareAudio(row(), deps(), new AbortController().signal);
      expect(ff.opts).toHaveLength(2);
      for (const o of ff.opts) {
        expect(o.env).toBeDefined();
        expect(Object.keys(o.env!).every((k) => ['SystemRoot', 'TEMP', 'TMP', 'PATH'].includes(k))).toBe(true);
        expect(Object.values(o.env!)).not.toContain('dummy-test-value');
      }
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});

describe('cleanupTemp', () => {
  let dataDir: string;
  let db: Db;
  const tmp = () => join(dataDir, 'meetings', 'tmp');
  const put = (name: string) => writeFileSync(join(tmp(), name), 'x');
  const partsDir = (id: number, files: string[]) => {
    mkdirSync(join(tmp(), `${id}-parts`));
    for (const f of files) writeFileSync(join(tmp(), `${id}-parts`, f), 'p');
  };
  const meetingAt = (status: MeetingStatus, stage?: 'audio' | 'transcribed'): number => {
    const id = insertFound(db, newMeeting({ status }))!;
    if (stage === 'audio' || stage === 'transcribed') advanceStage(db, id, 'audio', { audioPath: 'meetings/SHA/2026-11/x.mp3', audioSeconds: 60 }, NOW);
    if (stage === 'transcribed') advanceStage(db, id, 'transcribed', { transcript: [] }, NOW);
    return id;
  };

  beforeEach(() => {
    dataDir = tempDir('meet-clean-');
    db = seededDb();
    mkdirSync(tmp(), { recursive: true });
  });

  it('does nothing when there is no tmp folder', () => {
    const empty = tempDir('meet-clean-none-');
    expect(cleanupTemp(db, empty, silentLogger())).toEqual({ removed: 0, kept: 0 });
  });

  it('removes only matching work files of finished meetings and leaves everything else', () => {
    const working = meetingAt('queued'); // stage found: its files are in use
    const audioDone = meetingAt('queued', 'audio');
    const transcribed = meetingAt('queued', 'transcribed');
    const failed = meetingAt('failed');
    const done = meetingAt('done');
    for (const id of [working, audioDone, failed]) for (const ext of ['.mp4.part', '.mp3', '.mp3.part.mp3']) put(`${id}${ext}`);
    partsDir(working, ['part-000.mp3', '.done']);
    partsDir(audioDone, ['part-000.mp3']); // still needed for the transcript
    partsDir(transcribed, ['part-000.mp3', 'part-001.mp3', '.done']);
    partsDir(failed, ['part-000.mp3', 'notes.txt']); // an unexpected file: the folder is left alone
    partsDir(done, []);
    put('999.mp3'); // no such meeting
    put('1234567890123456.mp3'); // 16 digits: longer than any id
    put(`0${failed}.mp3`); // a leading zero: not the agent's name for meeting failed's file
    put(`${failed}.mp4`); // name does not match
    put(`${failed}.mp3.bak`);
    put('notes.txt');
    mkdirSync(join(tmp(), `${done}.mp3`)); // matching name but a folder, not a file
    const outside = join(dataDir, 'meetings', `${failed}.mp3`);
    writeFileSync(outside, 'outside tmp');

    const lines: string[] = [];
    const log = createLogger('info', new Writable({ write(c, _e, cb) { lines.push(String(c)); cb(); } }));
    const r = cleanupTemp(db, dataDir, log);

    const left = readdirSync(tmp()).sort();
    expect(left).toEqual(
      [
        `${working}.mp4.part`, `${working}.mp3`, `${working}.mp3.part.mp3`, `${working}-parts`,
        `${audioDone}-parts`,
        `${failed}-parts`, `${failed}.mp4`, `${failed}.mp3.bak`,
        `${done}.mp3`,
        '999.mp3', '1234567890123456.mp3', `0${failed}.mp3`, 'notes.txt',
      ].sort(),
    );
    expect(readdirSync(join(tmp(), `${failed}-parts`)).sort()).toEqual(['notes.txt', 'part-000.mp3']);
    expect(readdirSync(join(tmp(), `${working}-parts`)).sort()).toEqual(['.done', 'part-000.mp3']);
    expect(existsSync(outside)).toBe(true);
    // Removed: 3 for audioDone, 3 for failed, transcribed's and done's parts folders.
    expect(r.removed).toBe(8);
    expect(r.kept).toBe(left.length);
    const text = lines.join('');
    expect(text).toContain(`"meetingId":${failed}`);
    expect(text).not.toContain('notes.txt');
    expect(text).not.toContain(dataDir.replace(/\\/g, '\\\\'));
  });
});
