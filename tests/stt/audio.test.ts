import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Ffmpeg, findFfmpeg, minimalEnv, parseDuration, runFile, type RunFile, type RunOptions } from '../../src/stt/audio.ts';

const BANNER =
  "Input #0, ogg, from 'a.ogg':\n  Duration: 00:01:02.50, start: 0.000000, bitrate: 31 kb/s\n" +
  '  Stream #0:0: Audio: opus, 16000 Hz, mono\nAt least one output file must be specified\n';

function fakeRun(handler: (args: readonly string[]) => { code: number; stderr?: string }) {
  const calls: (readonly string[])[] = [];
  const opts: RunOptions[] = [];
  const run: RunFile = async (_file, args, o) => {
    calls.push(args);
    opts.push(o);
    const r = handler(args);
    return { code: r.code, stderr: r.stderr ?? '' };
  };
  return { run, calls, opts };
}

const lastArg = (args: readonly string[]): string => args[args.length - 1]!;

describe('parseDuration', () => {
  it('reads hours, minutes and seconds', () => {
    expect(parseDuration(BANNER)).toBe(62.5);
    expect(parseDuration('  Duration: 01:30:00.00, start: 0')).toBe(5400);
  });

  it('is null when the duration is missing or N/A', () => {
    expect(parseDuration('  Duration: N/A, bitrate: N/A')).toBeNull();
    expect(parseDuration('')).toBeNull();
  });

  it('ignores "Duration:" inside a metadata tag and reads the real summary line', () => {
    const tag = '    comment         : Duration: 00:00:09.00';
    const stderr = `Input #0, mov,mp4,m4a, from 'a.m4a':\n  Metadata:\n${tag}\n  Duration: 00:01:02.50, start: 0.000000, bitrate: 31 kb/s\n`;
    expect(parseDuration(stderr)).toBe(62.5);
    expect(parseDuration(`  Metadata:\r\n${tag}\r\n  Duration: N/A, bitrate: N/A\r\n`)).toBeNull();
  });
});

describe('runFile', () => {
  it('resolves with -1 when the program does not exist', async () => {
    expect((await runFile('no-such-program-xyz', [], { timeoutMs: 5000 })).code).toBe(-1);
  });

  it('resolves with -1 when the program is stopped at the timeout', async () => {
    expect((await runFile(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { timeoutMs: 300 })).code).toBe(-1);
  });

  it("resolves with the program's own exit code", async () => {
    expect((await runFile(process.execPath, ['-e', 'process.exit(3)'], { timeoutMs: 5000 })).code).toBe(3);
  });

  it('stops the program when the signal is aborted and resolves with -1', async () => {
    const ac = new AbortController();
    const started = Date.now();
    setTimeout(() => ac.abort(), 200);
    const r = await runFile(process.execPath, ['-e', 'setTimeout(()=>{},20000)'], { timeoutMs: 30_000, signal: ac.signal });
    expect(r.code).toBe(-1);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('resolves on an abort only after the program has exited', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stt-run-'));
    try {
      const pidFile = join(dir, 'pid');
      const script = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`;
      const ac = new AbortController();
      const p = runFile(process.execPath, ['-e', script], { timeoutMs: 30_000, signal: ac.signal });
      await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 5000 });
      const pid = Number(readFileSync(pidFile, 'utf8'));
      ac.abort();
      expect((await p).code).toBe(-1);
      expect(() => process.kill(pid, 0)).toThrow(); // gone, not merely told to stop
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gives the program only the minimal env by default, or the env it is passed', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'dummy-test-value';
    try {
      const script = "process.stderr.write(String(process.env.ANTHROPIC_API_KEY === undefined) + ' ' + String(process.env.SystemRoot !== undefined || process.platform !== 'win32'))";
      expect(await runFile(process.execPath, ['-e', script], { timeoutMs: 10_000 })).toEqual({ code: 0, stderr: 'true true' });
      const given = await runFile(process.execPath, ['-e', 'process.stderr.write(String(process.env.X_ONLY))'], { timeoutMs: 10_000, env: { ...minimalEnv(), X_ONLY: 'x' } });
      expect(given.stderr).toBe('x');
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});

describe('minimalEnv', () => {
  it('keeps only SystemRoot, TEMP, TMP and PATH', () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'dummy-test-value';
    try {
      const env = minimalEnv();
      expect(Object.keys(env).every((k) => ['SystemRoot', 'TEMP', 'TMP', 'PATH'].includes(k))).toBe(true);
      expect(Object.values(env)).not.toContain('dummy-test-value');
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});

describe('Ffmpeg', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stt-audio-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('measures a file from the input summary', async () => {
    const { run, calls } = fakeRun(() => ({ code: 1, stderr: BANNER }));
    expect(await new Ffmpeg('ffmpeg.exe', run).seconds('a.ogg')).toBe(62.5);
    expect(calls[0]).toEqual(['-hide_banner', '-nostdin', '-i', 'a.ogg']);
  });

  it('throws AudioError when there is no duration', async () => {
    const { run } = fakeRun(() => ({ code: 1, stderr: 'a.ogg: Invalid data found when processing input' }));
    await expect(new Ffmpeg('ffmpeg.exe', run).seconds('a.ogg')).rejects.toMatchObject({ name: 'AudioError', code: 'no_duration' });
  });

  it('converts to mono 16 kHz MP3 through a temporary file', async () => {
    const { run, calls } = fakeRun((args) => {
      writeFileSync(lastArg(args), 'mp3');
      return { code: 0 };
    });
    const out = join(dir, 'x.mp3');
    await new Ffmpeg('ffmpeg.exe', run).toMp3('in.mp4', out);
    const args = calls[0]!;
    expect(args).toEqual(expect.arrayContaining(['-i', 'in.mp4', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '64k']));
    // No tags (title, GPS location, device or contact name) or chapters are copied into the uploaded MP3.
    const vn = args.indexOf('-vn');
    expect(args.slice(vn, vn + 5)).toEqual(['-vn', '-map_metadata', '-1', '-map_chapters', '-1']);
    expect(lastArg(args)).toBe(`${out}.part.mp3`);
    expect(existsSync(out)).toBe(true);
    expect(existsSync(`${out}.part.mp3`)).toBe(false);
  });

  it('keeps an existing MP3 without running ffmpeg', async () => {
    const out = join(dir, 'x.mp3');
    writeFileSync(out, 'old');
    const { run, calls } = fakeRun(() => ({ code: 0 }));
    await new Ffmpeg('ffmpeg.exe', run).toMp3('in.mp4', out);
    expect(calls).toHaveLength(0);
    expect(readFileSync(out, 'utf8')).toBe('old');
  });

  it('throws when the conversion fails', async () => {
    const { run } = fakeRun(() => ({ code: 1 }));
    await expect(new Ffmpeg('ffmpeg.exe', run).toMp3('in.mp4', join(dir, 'y.mp3'))).rejects.toMatchObject({ code: 'convert_failed' });
  });

  it('passes the signal, the env and each step timeout to the runner', async () => {
    const { run, opts } = fakeRun((args) => {
      if (args.includes('libmp3lame')) writeFileSync(lastArg(args), 'mp3');
      return { code: args.includes('libmp3lame') ? 0 : 1, stderr: BANNER };
    });
    const env = { PATH: 'C:\\bin' };
    const ac = new AbortController();
    const ff = new Ffmpeg('ffmpeg.exe', run, { env });
    await ff.toMp3('in.mp4', join(dir, 'z.mp3'), ac.signal);
    await ff.seconds('a.ogg', ac.signal);
    expect(opts).toEqual([
      { timeoutMs: 60 * 60_000, signal: ac.signal, env },
      { timeoutMs: 60_000, signal: ac.signal, env },
    ]);
    // Without an env the minimal one is passed; without a signal none is.
    const plain = fakeRun(() => ({ code: 1, stderr: BANNER }));
    await new Ffmpeg('ffmpeg.exe', plain.run).seconds('a.ogg');
    expect(plain.opts).toEqual([{ timeoutMs: 60_000, env: minimalEnv() }]);
  });

  it('throws the abort, not an AudioError, when the signal stopped ffmpeg', async () => {
    const ac = new AbortController();
    const reason = new Error('stop');
    const { run } = fakeRun(() => {
      ac.abort(reason);
      return { code: -1 };
    });
    const ff = new Ffmpeg('ffmpeg.exe', run);
    await expect(ff.toMp3('in.mp4', join(dir, 'w.mp3'), ac.signal)).rejects.toBe(reason);
    await expect(ff.seconds('a.ogg', ac.signal)).rejects.toBe(reason);
    await expect(ff.split({ path: 'long.mp3', seconds: 900, offset: 0 }, join(dir, 'p2'), 300, ac.signal)).rejects.toBe(reason);
  });

  it('returns a short file as one part without running ffmpeg', async () => {
    const { run, calls } = fakeRun(() => ({ code: 0 }));
    const input = { path: 'a.mp3', seconds: 200, offset: 0 };
    expect(await new Ffmpeg('ffmpeg.exe', run).split(input, join(dir, 'parts'), 300)).toEqual([input]);
    expect(calls).toHaveLength(0);
  });

  it('splits a long file into equal parts and measures each part for exact offsets', async () => {
    const lengths: Record<string, string> = { 'part-000.mp3': '00:03:35.50', 'part-001.mp3': '00:03:34.50' };
    const { run, calls } = fakeRun((args) => {
      if (args.includes('segment')) {
        const pattern = lastArg(args);
        writeFileSync(pattern.replace('%03d', '000'), 'a');
        writeFileSync(pattern.replace('%03d', '001'), 'b');
        return { code: 0 };
      }
      return { code: 1, stderr: `  Duration: ${lengths[basename(lastArg(args))]}, start: 0` };
    });
    const ff = new Ffmpeg('ffmpeg.exe', run);
    const partsDir = join(dir, 'parts');
    const long = { path: 'long.mp3', seconds: 430, offset: 0 };
    expect(await ff.split(long, partsDir, 300)).toEqual([
      { path: join(partsDir, 'part-000.mp3'), seconds: 215.5, offset: 0 },
      { path: join(partsDir, 'part-001.mp3'), seconds: 214.5, offset: 215.5 },
    ]);
    // 430 s in at most 300 s parts: two parts of 215 s, not 300 s and a short, separately paid 130 s.
    expect(calls[0]).toEqual(expect.arrayContaining(['-i', 'long.mp3', '-f', 'segment', '-segment_time', '215.000', '-c', 'copy']));
    // A second call reuses the finished parts instead of cutting again.
    await ff.split(long, partsDir, 300);
    expect(calls.filter((a) => a.includes('segment'))).toHaveLength(1);
  });
});

describe('findFfmpeg', () => {
  it('uses FFMPEG_PATH when it starts', async () => {
    const { run, calls } = fakeRun(() => ({ code: 0 }));
    expect(await findFfmpeg('C:\\tools\\ffmpeg.exe', run)).toBe('C:\\tools\\ffmpeg.exe');
    expect(calls[0]).toEqual(['-hide_banner', '-version']);
  });

  it('falls back to ffmpeg on PATH', async () => {
    const { run } = fakeRun(() => ({ code: 0 }));
    expect(await findFfmpeg(undefined, run)).toBe('ffmpeg');
  });

  it('passes the minimal env by default, or the env it is given', async () => {
    const { run, opts } = fakeRun(() => ({ code: 0 }));
    await findFfmpeg(undefined, run);
    await findFfmpeg(undefined, run, { env: { PATH: 'x' } });
    expect(opts).toEqual([{ timeoutMs: 15_000, env: minimalEnv() }, { timeoutMs: 15_000, env: { PATH: 'x' } }]);
  });

  it('is null when ffmpeg does not start', async () => {
    const { run } = fakeRun(() => ({ code: -1 }));
    expect(await findFfmpeg(undefined, run)).toBeNull();
  });
});
