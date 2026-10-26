import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Ffmpeg, findFfmpeg, minimalEnv, parseDuration, parseMeanVolume, runFile, SAFE_INPUT, type RunFile, type RunOptions } from '../../src/stt/audio.ts';

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
    expect(calls[0]).toEqual(['-hide_banner', '-nostdin', ...SAFE_INPUT, '-i', 'a.ogg']);
  });

  it('reads every input as a local file in an allowed format only', async () => {
    const { run, calls } = fakeRun((args) => {
      if (args.includes('segment')) {
        writeFileSync(lastArg(args).replace('%03d', '000'), 'a');
        return { code: 0 };
      }
      if (args.includes('libmp3lame') || args.includes('pcm_s16le')) {
        writeFileSync(lastArg(args), 'audio');
        return { code: 0 };
      }
      return { code: 1, stderr: BANNER };
    });
    const ff = new Ffmpeg('ffmpeg.exe', run);
    await ff.seconds('a.ogg');
    await ff.toMp3('in.mp4', join(dir, 'safe.mp3'));
    await ff.split({ path: 'long.mp3', seconds: 430, offset: 0 }, join(dir, 'safe-parts'), 300);
    await ff.toWav('in.ogg', join(dir, 'safe.wav'));
    await ff.meanVolumeDb('a.wav');
    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const args of calls) {
      const i = args.indexOf('-i');
      expect(i).toBeGreaterThan(SAFE_INPUT.length - 1);
      // The whitelist sits right before -i, so it applies to the input, never to an output.
      expect(args.slice(i - SAFE_INPUT.length, i)).toEqual([...SAFE_INPUT]);
    }
    // No playlist, concat or dash demuxer, and no network protocol.
    const formats = SAFE_INPUT[SAFE_INPUT.indexOf('-format_whitelist') + 1]!.split(',');
    for (const bad of ['hls', 'concat', 'dash', 'm3u8']) expect(formats).not.toContain(bad);
    expect(SAFE_INPUT[SAFE_INPUT.indexOf('-protocol_whitelist') + 1]).toBe('file');
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

  // Phase 3's meetings call toMp3 without opts: their arguments must stay exactly these.
  const MP3_ARGS = (out: string) => [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...SAFE_INPUT, '-i', 'in.ogg', '-vn', '-map_metadata', '-1', '-map_chapters', '-1',
    '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '64k', `${out}.part.mp3`,
  ];
  const writing = () =>
    fakeRun((args) => {
      writeFileSync(lastArg(args), 'mp3');
      return { code: 0 };
    });

  it('without opts, or without maxSeconds, the arguments are exactly the meetings ones', async () => {
    for (const opts of [undefined, {}]) {
      const { run, calls } = writing();
      const out = join(dir, `plain-${opts === undefined ? 'a' : 'b'}.mp3`);
      await new Ffmpeg('ffmpeg.exe', run).toMp3('in.ogg', out, undefined, opts);
      expect(calls).toEqual([MP3_ARGS(out)]);
    }
  });

  it('with maxSeconds, stops the output there: -t just before the output path, nothing else changed', async () => {
    const { run, calls } = writing();
    const out = join(dir, 'capped.mp3');
    await new Ffmpeg('ffmpeg.exe', run).toMp3('in.ogg', out, undefined, { maxSeconds: 606 });
    const plain = MP3_ARGS(out);
    expect(calls).toEqual([[...plain.slice(0, -1), '-t', '606', `${out}.part.mp3`]]);
    // An output option: after -i, so it limits what is written, never how the input is read.
    expect(calls[0]!.indexOf('-t')).toBeGreaterThan(calls[0]!.indexOf('-i'));
    expect(existsSync(out)).toBe(true);
  });

  // Task 5 review round 2: voice notes get a shorter conversion timeout; meetings keep the 60 minutes.
  it('the conversion timeout is 60 minutes without opts, without timeoutMs, and with maxSeconds alone', async () => {
    for (const [name, opts] of [['a', undefined], ['b', {}], ['c', { maxSeconds: 606 }]] as const) {
      const { run, opts: given } = writing();
      await new Ffmpeg('ffmpeg.exe', run).toMp3('in.ogg', join(dir, `timeout-${name}.mp3`), undefined, opts);
      expect(given.map((o) => o.timeoutMs)).toEqual([60 * 60_000]);
    }
  });

  it('opts.timeoutMs replaces the conversion timeout, and changes no argument', async () => {
    const { run, calls, opts } = writing();
    const out = join(dir, 'short.mp3');
    await new Ffmpeg('ffmpeg.exe', run).toMp3('in.ogg', out, undefined, { timeoutMs: 5 * 60_000 });
    expect(opts.map((o) => o.timeoutMs)).toEqual([5 * 60_000]);
    expect(calls).toEqual([MP3_ARGS(out)]);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('refuses a timeoutMs of %s without running ffmpeg', async (timeoutMs) => {
    const { run, calls } = writing();
    await expect(new Ffmpeg('ffmpeg.exe', run).toMp3('in.ogg', join(dir, 'bad-t.mp3'), undefined, { timeoutMs })).rejects.toThrow(/timeoutMs/);
    expect(calls).toEqual([]);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('refuses a maxSeconds of %s without running ffmpeg', async (maxSeconds) => {
    const { run, calls } = writing();
    await expect(new Ffmpeg('ffmpeg.exe', run).toMp3('in.ogg', join(dir, 'bad.mp3'), undefined, { maxSeconds })).rejects.toThrow(/maxSeconds/);
    expect(calls).toEqual([]);
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

// Phase 2b amendment L2: the local engine takes a 16 kHz mono 16-bit WAV. Additive: toMp3, seconds and split are unchanged.
describe('Ffmpeg.toWav', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stt-wav-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const WAV_ARGS = (out: string) => [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...SAFE_INPUT, '-i', 'in.ogg', '-vn', '-map_metadata', '-1', '-map_chapters', '-1',
    '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', `${out}.part.wav`,
  ];
  const writing = () =>
    fakeRun((args) => {
      writeFileSync(lastArg(args), 'wav');
      return { code: 0 };
    });

  it('converts to a 16 kHz mono pcm_s16le WAV through a temporary file, without tags, chapters or video: exactly these arguments', async () => {
    for (const opts of [undefined, {}]) {
      const { run, calls } = writing();
      const out = join(dir, `plain-${opts === undefined ? 'a' : 'b'}.wav`);
      await new Ffmpeg('ffmpeg.exe', run).toWav('in.ogg', out, undefined, opts);
      expect(calls).toEqual([WAV_ARGS(out)]);
      expect(existsSync(out)).toBe(true);
      expect(existsSync(`${out}.part.wav`)).toBe(false);
    }
  });

  it('with maxSeconds, stops the output there: -t just before the output path, as toMp3 does', async () => {
    const { run, calls } = writing();
    const out = join(dir, 'capped.wav');
    await new Ffmpeg('ffmpeg.exe', run).toWav('in.ogg', out, undefined, { maxSeconds: 606 });
    expect(calls).toEqual([[...WAV_ARGS(out).slice(0, -1), '-t', '606', `${out}.part.wav`]]);
    expect(calls[0]!.indexOf('-t')).toBeGreaterThan(calls[0]!.indexOf('-i'));
  });

  it('the timeout is 60 minutes by default, and opts.timeoutMs replaces it without changing an argument', async () => {
    const plain = writing();
    await new Ffmpeg('ffmpeg.exe', plain.run).toWav('in.ogg', join(dir, 'a.wav'), undefined, { maxSeconds: 606 });
    expect(plain.opts.map((o) => o.timeoutMs)).toEqual([60 * 60_000]);
    const short = writing();
    const out = join(dir, 'b.wav');
    await new Ffmpeg('ffmpeg.exe', short.run).toWav('in.ogg', out, undefined, { timeoutMs: 5 * 60_000 });
    expect(short.opts.map((o) => o.timeoutMs)).toEqual([5 * 60_000]);
    expect(short.calls).toEqual([WAV_ARGS(out)]);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('refuses a maxSeconds or timeoutMs of %s without running ffmpeg', async (bad) => {
    const { run, calls } = writing();
    const ff = new Ffmpeg('ffmpeg.exe', run);
    await expect(ff.toWav('in.ogg', join(dir, 'x.wav'), undefined, { maxSeconds: bad })).rejects.toThrow(/maxSeconds/);
    await expect(ff.toWav('in.ogg', join(dir, 'x.wav'), undefined, { timeoutMs: bad })).rejects.toThrow(/timeoutMs/);
    expect(calls).toEqual([]);
  });

  it('keeps an existing WAV without running ffmpeg', async () => {
    const out = join(dir, 'x.wav');
    writeFileSync(out, 'old');
    const { run, calls } = writing();
    await new Ffmpeg('ffmpeg.exe', run).toWav('in.ogg', out);
    expect(calls).toEqual([]);
    expect(readFileSync(out, 'utf8')).toBe('old');
  });

  it('throws AudioError convert_failed when ffmpeg fails or writes nothing', async () => {
    const failed = fakeRun(() => ({ code: 1 }));
    await expect(new Ffmpeg('ffmpeg.exe', failed.run).toWav('in.ogg', join(dir, 'y.wav'))).rejects.toMatchObject({ name: 'AudioError', code: 'convert_failed' });
    const nothing = fakeRun(() => ({ code: 0 }));
    await expect(new Ffmpeg('ffmpeg.exe', nothing.run).toWav('in.ogg', join(dir, 'z.wav'))).rejects.toMatchObject({ code: 'convert_failed' });
  });

  it('passes the signal and the env, and throws the abort, not an AudioError', async () => {
    const env = { PATH: 'C:\\bin' };
    const ac = new AbortController();
    const ok = writing();
    await new Ffmpeg('ffmpeg.exe', ok.run, { env }).toWav('in.ogg', join(dir, 'w.wav'), ac.signal);
    expect(ok.opts).toEqual([{ timeoutMs: 60 * 60_000, signal: ac.signal, env }]);
    const reason = new Error('stop');
    const { run } = fakeRun(() => {
      ac.abort(reason);
      return { code: -1 };
    });
    await expect(new Ffmpeg('ffmpeg.exe', run).toWav('in.ogg', join(dir, 'v.wav'), ac.signal)).rejects.toBe(reason);
  });
});

describe('Ffmpeg.meanVolumeDb', () => {
  const VOLUME_ARGS = ['-hide_banner', '-nostdin', '-nostats', ...SAFE_INPUT, '-i', 'a.wav', '-vn', '-af', 'volumedetect', '-f', 'null', '-'];
  const report = (mean: string) =>
    `[Parsed_volumedetect_0 @ 000001] n_samples: 160000\n[Parsed_volumedetect_0 @ 000001] mean_volume: ${mean} dB\n` +
    '[Parsed_volumedetect_0 @ 000001] max_volume: -3.1 dB\n';

  it('runs volumedetect into the null muxer, reading the input as SAFE_INPUT allows: exactly these arguments', async () => {
    const { run, calls, opts } = fakeRun(() => ({ code: 0, stderr: report('-23.5') }));
    expect(await new Ffmpeg('ffmpeg.exe', run).meanVolumeDb('a.wav')).toBe(-23.5);
    expect(calls).toEqual([VOLUME_ARGS]);
    expect(opts).toEqual([{ timeoutMs: 60_000, env: minimalEnv() }]);
  });

  it.each([
    ['-23.5', -23.5],
    ['-91.0', -91],
    ['-0.0', -0],
    ['3.2', 3.2],
    ['-inf', Number.NEGATIVE_INFINITY],
  ])('reads mean_volume: %s dB', async (mean, db) => {
    const { run } = fakeRun(() => ({ code: 0, stderr: report(mean) }));
    expect(await new Ffmpeg('ffmpeg.exe', run).meanVolumeDb('a.wav')).toBe(db);
  });

  it('is null when ffmpeg printed no mean volume (no audio, or it failed)', async () => {
    for (const r of [{ code: 0, stderr: '' }, { code: 1, stderr: 'a.wav: Invalid data found when processing input' }, { code: -1, stderr: '' }]) {
      const { run } = fakeRun(() => r);
      expect(await new Ffmpeg('ffmpeg.exe', run).meanVolumeDb('a.wav')).toBeNull();
    }
  });

  it('passes the signal, and throws the abort', async () => {
    const ac = new AbortController();
    const reason = new Error('stop');
    const { run, opts } = fakeRun(() => {
      ac.abort(reason);
      return { code: -1 };
    });
    await expect(new Ffmpeg('ffmpeg.exe', run).meanVolumeDb('a.wav', ac.signal)).rejects.toBe(reason);
    expect(opts[0]!.signal).toBe(ac.signal);
  });
});

describe('parseMeanVolume', () => {
  it('reads the volumedetect line only, not a tag that looks like it', () => {
    expect(parseMeanVolume('[Parsed_volumedetect_0 @ 0x1] mean_volume: -40.2 dB\n')).toBe(-40.2);
    expect(parseMeanVolume('    comment         : mean_volume: -1.0 dB\n')).toBeNull();
    expect(parseMeanVolume('')).toBeNull();
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
