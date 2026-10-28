import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseEnv } from '../../src/config/env.ts';
import { localMeetingTmpDir } from '../../src/meetings/localTranscriber.ts';
import { minimalEnv } from '../../src/stt/audio.ts';
import {
  checkLocalEngineFiles, LocalEngine, LocalEngineError, localEngineArgs, localEngineTmpDir, runLocalEngine, sharedLocalEngine,
  type LocalEngineOptions, type LocalRunFile as RunFile, type LocalRunOptions as RunOptions,
} from '../../src/stt/local.ts';

const BIN = '/opt/stt/transcribe.cpp/build/bin/transcribe-cli';
const MODEL = '/opt/stt/models/Voxtral-Mini-3B-2507-Q4_K_M.gguf';
const WAV = '/tmp/note-1/note.wav';

/** The transcript file the engine was told to write: after -o for transcribe.cpp, <-of>.txt for whisper. */
function outputOf(args: readonly string[]): string {
  const of = args.indexOf('-of');
  if (of >= 0) return `${args[of + 1]!}.txt`;
  return args[args.indexOf('-o') + 1]!;
}

interface Call {
  file: string;
  args: readonly string[];
  opts: RunOptions;
}

/** A RunFile that writes `text` to the output file the args name (unless null) and exits with `code`. */
function fakeRun(result: { code?: number; text?: string | null; stderr?: string } = {}) {
  const calls: Call[] = [];
  const run: RunFile = async (file, args, opts) => {
    calls.push({ file, args, opts });
    const text = result.text === undefined ? 'transcript\n' : result.text;
    if (text !== null) writeFileSync(outputOf(args), text);
    return { code: result.code ?? 0, stderr: result.stderr ?? '' };
  };
  return { run, calls };
}

/** A RunFile that runs until its signal aborts, then resolves with -1 as runFile does. */
function hangingRun() {
  const calls: Call[] = [];
  const run: RunFile = (file, args, opts) =>
    new Promise((resolve) => {
      calls.push({ file, args, opts });
      const stop = () => resolve({ code: -1, stderr: '' });
      if (opts.signal?.aborted) stop();
      else opts.signal?.addEventListener('abort', stop, { once: true });
    });
  return { run, calls };
}

async function engineError(p: Promise<unknown>): Promise<LocalEngineError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(LocalEngineError);
    return e as LocalEngineError;
  }
  throw new Error('expected a LocalEngineError');
}

let root: string;
let workDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'local-stt-'));
  workDir = join(root, 'note-1');
  mkdirSync(workDir);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function engine(over: Partial<LocalEngineOptions> & { run: RunFile }): LocalEngine {
  return new LocalEngine({ engine: 'voxtral', bin: BIN, model: MODEL, threads: 8, timeoutMs: 60_000, language: 'hi', tmpDir: root, ...over });
}

describe('localEngineArgs', () => {
  const base = { model: MODEL, wav: WAV, outPath: '/tmp/note-1/transcript.txt', threads: 8 };

  it('voxtral: model, --threads, quiet, output file, the language hint, then the WAV', () => {
    expect(localEngineArgs({ ...base, engine: 'voxtral', language: 'hi' })).toEqual({
      args: ['-m', MODEL, '--threads', '8', '-q', '-o', '/tmp/note-1/transcript.txt', '-l', 'hi', WAV],
      outputFile: '/tmp/note-1/transcript.txt',
    });
    expect(localEngineArgs({ ...base, engine: 'voxtral', language: 'en' }).args).toEqual(['-m', MODEL, '--threads', '8', '-q', '-o', '/tmp/note-1/transcript.txt', '-l', 'en', WAV]);
  });

  it('voxtral with auto passes no -l', () => {
    expect(localEngineArgs({ ...base, engine: 'voxtral', language: 'auto' }).args).toEqual(['-m', MODEL, '--threads', '8', '-q', '-o', '/tmp/note-1/transcript.txt', WAV]);
  });

  it('qwen3-asr never gets -l, whatever the language', () => {
    for (const language of ['hi', 'en', 'auto'] as const) {
      expect(localEngineArgs({ ...base, engine: 'qwen3-asr', language, threads: 4 })).toEqual({
        args: ['-m', MODEL, '--threads', '4', '-q', '-o', '/tmp/note-1/transcript.txt', WAV],
        outputFile: '/tmp/note-1/transcript.txt',
      });
    }
  });

  it('transcribe.cpp never gets the short -t, which means translate there', () => {
    for (const engine of ['voxtral', 'qwen3-asr'] as const) {
      for (const language of ['hi', 'en', 'auto'] as const) {
        const { args } = localEngineArgs({ ...base, engine, language });
        expect(args).not.toContain('-t');
        expect(args).not.toContain('-tr');
      }
    }
  });

  it('whisper: model, input, the language always, -t threads, no prints or timestamps, text written to <base>.txt', () => {
    for (const language of ['hi', 'en', 'auto'] as const) {
      expect(localEngineArgs({ ...base, engine: 'whisper', language })).toEqual({
        args: ['-m', MODEL, '-f', WAV, '-l', language, '-t', '8', '-np', '-nt', '-otxt', '-of', '/tmp/note-1/transcript'],
        outputFile: '/tmp/note-1/transcript.txt',
      });
    }
  });

  it('whisper: an output path without .txt is the base itself', () => {
    expect(localEngineArgs({ ...base, engine: 'whisper', language: 'hi', outPath: '/tmp/note-1/out' })).toEqual({
      args: ['-m', MODEL, '-f', WAV, '-l', 'hi', '-t', '8', '-np', '-nt', '-otxt', '-of', '/tmp/note-1/out'],
      outputFile: '/tmp/note-1/out.txt',
    });
  });

  it('whisper never translates', () => {
    expect(localEngineArgs({ ...base, engine: 'whisper', language: 'hi' }).args).not.toContain('-tr');
  });
});

describe('LocalEngine.transcribe', () => {
  it('runs the configured program with the args, the timeout and minimalEnv, writing into the work folder', async () => {
    const { run, calls } = fakeRun();
    const wav = join(workDir, 'note.wav');
    await engine({ run, timeoutMs: 90_000 }).transcribe(wav, { workDir });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.file).toBe(BIN);
    expect(call!.args).toEqual(['-m', MODEL, '--threads', '8', '-q', '-o', join(workDir, 'transcript.txt'), '-l', 'hi', wav]);
    expect(call!.opts.timeoutMs).toBe(90_000);
    expect(call!.opts.env).toEqual(minimalEnv());
    expect(call!.opts.inheritEnv).toBeUndefined();
    // A stopped program has 5 s after SIGTERM before SIGKILL.
    expect(call!.opts.killGraceMs).toBe(5_000);
  });

  it('passes its own kill grace time to the runner', async () => {
    const { run, calls } = fakeRun();
    await engine({ run, killGraceMs: 250 }).transcribe(join(workDir, 'note.wav'), { workDir });
    expect(calls[0]!.opts.killGraceMs).toBe(250);
  });

  it('refuses a WAV path that is not absolute, before running anything, without echoing it', async () => {
    const { run, calls } = fakeRun();
    for (const wav of ['note.wav', 'zz-rel-zz/note.wav', './note.wav', '-h', '--threads', '-zz-rel-zz.wav', '-', '']) {
      const e = await engine({ run }).transcribe(wav, { workDir }).then(() => null, (err: unknown) => err);
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toMatch(/WAV path must be absolute/);
      expect((e as Error).message).not.toContain('zz-rel-zz');
    }
    expect(calls).toHaveLength(0);
  });

  it('uses the env it is given instead of minimalEnv', async () => {
    const { run, calls } = fakeRun();
    await engine({ run, env: { env: { PATH: '/usr/bin' } } }).transcribe(join(workDir, 'note.wav'), { workDir });
    expect(calls[0]!.opts.env).toEqual({ PATH: '/usr/bin' });
  });

  it('whisper writes <base>.txt, which is read', async () => {
    const { run, calls } = fakeRun({ text: 'whisper words\n' });
    const r = await engine({ run, engine: 'whisper', bin: '/opt/stt/whisper.cpp/build/bin/whisper-cli' }).transcribe(join(workDir, 'note.wav'), { workDir });
    expect(r).toEqual({ text: 'whisper words' });
    expect(calls[0]!.args.slice(-2)).toEqual(['-of', join(workDir, 'transcript')]);
  });

  it('gives the text trimmed, with line breaks and runs of whitespace as single spaces', async () => {
    const { run } = fakeRun({ text: '﻿  Site visit  kal\r\n\tsubah   10 baje.\n\nThanks \n' });
    expect(await engine({ run }).transcribe(join(workDir, 'note.wav'), { workDir })).toEqual({ text: 'Site visit kal subah 10 baje. Thanks' });
  });

  it('leaves Devanagari and Latin text unchanged', async () => {
    const said = 'नमस्ते sir, कल की site visit क्या 10 बजे है? क्‍ष ठीक है।';
    const { run } = fakeRun({ text: `${said}\n` });
    expect((await engine({ run }).transcribe(join(workDir, 'note.wav'), { workDir })).text).toBe(said);
    const { run: run2 } = fakeRun({ text: 'नमस्ते\nsir,\n  कल   की\r\nsite visit\n' });
    expect((await engine({ run: run2 }).transcribe(join(workDir, 'note.wav'), { workDir })).text).toBe('नमस्ते sir, कल की site visit');
  });

  it('an empty output file gives empty text', async () => {
    for (const text of ['', '\n', '  \n\t\n']) {
      const { run } = fakeRun({ text });
      expect(await engine({ run }).transcribe(join(workDir, 'note.wav'), { workDir })).toEqual({ text: '' });
    }
  });

  it('removes the output file after reading it', async () => {
    const { run } = fakeRun();
    await engine({ run }).transcribe(join(workDir, 'note.wav'), { workDir });
    expect(readdirSync(workDir)).toEqual([]);
  });

  it('never reads an output file left from an earlier run', async () => {
    writeFileSync(join(workDir, 'transcript.txt'), 'stale words');
    const { run } = fakeRun({ text: null });
    expect((await engineError(engine({ run }).transcribe(join(workDir, 'note.wav'), { workDir }))).code).toBe('no_output');
  });

  it('exit code 0 without an output file is no_output', async () => {
    const { run } = fakeRun({ text: null });
    const e = await engineError(engine({ run }).transcribe(join(workDir, 'note.wav'), { workDir }));
    expect(e.code).toBe('no_output');
  });

  it('a non-zero exit is exit_<n>, never carries stderr, and leaves no output file', async () => {
    const said = 'zz-words-from-the-audio-zz';
    for (const code of [1, 3, 134]) {
      const { run } = fakeRun({ code, text: 'partial', stderr: `error: ${said}` });
      const e = await engineError(engine({ run }).transcribe(join(workDir, 'note.wav'), { workDir }));
      expect(e.code).toBe(`exit_${code}`);
      expect(e.message).not.toContain(said);
      expect(JSON.stringify(e)).not.toContain(said);
      expect(existsSync(join(workDir, 'transcript.txt'))).toBe(false);
    }
  });

  it('a program that could not start (-1, no timeout or abort) is exit_-1', async () => {
    const { run } = fakeRun({ code: -1, text: null });
    expect((await engineError(engine({ run }).transcribe(join(workDir, 'note.wav'), { workDir }))).code).toBe('exit_-1');
  });

  it('stops the run at the timeout: timeout', async () => {
    const { run, calls } = hangingRun();
    const e = await engineError(engine({ run, timeoutMs: 50 }).transcribe(join(workDir, 'note.wav'), { workDir }));
    expect(e.code).toBe('timeout');
    expect(calls[0]!.opts.signal?.aborted).toBe(true);
  });

  it('a run stopped by RunFile at the timeout (code -1 after timeoutMs) is timeout too', async () => {
    const run: RunFile = async (_f, _a, opts) => {
      await new Promise((r) => setTimeout(r, opts.timeoutMs + 20));
      return { code: -1, stderr: '' };
    };
    // A RunFile that ignores the signal still stops at its own timeout.
    const ignoring: RunFile = (f, a, o) => run(f, a, { timeoutMs: o.timeoutMs, killGraceMs: o.killGraceMs });
    expect((await engineError(engine({ run: ignoring, timeoutMs: 40 }).transcribe(join(workDir, 'note.wav'), { workDir }))).code).toBe('timeout');
  });

  it('a -1 after timeoutMs is timeout even when its own timer could not fire first', async () => {
    // The runner holds the thread past the timeout and returns at once, so the engine's own timer never runs.
    const run: RunFile = (_f, _a, opts) => {
      const until = Date.now() + opts.timeoutMs + 15;
      while (Date.now() < until) {
        // busy
      }
      return Promise.resolve({ code: -1, stderr: '' });
    };
    expect((await engineError(engine({ run, timeoutMs: 20 }).transcribe(join(workDir, 'note.wav'), { workDir }))).code).toBe('timeout');
  });

  it('a runner that answers its stop with a real exit code is still timeout, through its own timer', async () => {
    const run: RunFile = (_f, _a, opts) =>
      new Promise((resolve) => {
        opts.signal?.addEventListener('abort', () => resolve({ code: 143, stderr: '' }), { once: true });
      });
    expect((await engineError(engine({ run, timeoutMs: 30 }).transcribe(join(workDir, 'note.wav'), { workDir }))).code).toBe('timeout');
  });

  it('an abort stops the run: aborted', async () => {
    const { run, calls } = hangingRun();
    const ac = new AbortController();
    const p = engine({ run }).transcribe(join(workDir, 'note.wav'), { workDir, signal: ac.signal });
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toHaveLength(1);
    ac.abort();
    const e = await engineError(p);
    expect(e.code).toBe('aborted');
    expect(calls[0]!.opts.signal?.aborted).toBe(true);
  });

  it('an abort of a running program is answered only once the program has exited', async () => {
    let exited = false;
    const run: RunFile = (_f, _a, opts) =>
      new Promise((resolve) => {
        opts.signal?.addEventListener('abort', () => setTimeout(() => {
          exited = true;
          resolve({ code: -1, stderr: '' });
        }, 30), { once: true });
      });
    const ac = new AbortController();
    const p = engine({ run }).transcribe(join(workDir, 'note.wav'), { workDir, signal: ac.signal });
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    const e = await engineError(p);
    expect(e.code).toBe('aborted');
    expect(exited).toBe(true);
  });

  it('an abort before the run starts never runs the program', async () => {
    const { run, calls } = fakeRun();
    const ac = new AbortController();
    ac.abort();
    expect((await engineError(engine({ run }).transcribe(join(workDir, 'note.wav'), { workDir, signal: ac.signal }))).code).toBe('aborted');
    expect(calls).toHaveLength(0);
  });

  it('an abort after the program finished is still aborted, and the output is removed', async () => {
    const ac = new AbortController();
    const run: RunFile = async (_f, args) => {
      writeFileSync(outputOf(args), 'words');
      ac.abort();
      return { code: 0, stderr: '' };
    };
    expect((await engineError(engine({ run }).transcribe(join(workDir, 'note.wav'), { workDir, signal: ac.signal }))).code).toBe('aborted');
    expect(existsSync(join(workDir, 'transcript.txt'))).toBe(false);
  });

  it('refuses a work folder outside its temporary folder, before running anything', async () => {
    const { run, calls } = fakeRun();
    const outside = mkdtempSync(join(tmpdir(), 'local-stt-outside-'));
    try {
      await expect(engine({ run }).transcribe(join(outside, 'note.wav'), { workDir: outside })).rejects.toThrow(/temporary folder/);
      await expect(engine({ run }).transcribe(join(root, 'note.wav'), { workDir: join(root, '..') })).rejects.toThrow(/temporary folder/);
      // The temporary folder itself is not a note's own folder.
      await expect(engine({ run }).transcribe(join(root, 'note.wav'), { workDir: root })).rejects.toThrow(/temporary folder/);
      await expect(engine({ run }).transcribe(join(root, 'note.wav'), { workDir: join(root, '.') })).rejects.toThrow(/temporary folder/);
      expect(calls).toHaveLength(0);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

it.skipIf(process.platform !== 'win32')('(Windows) refuses a work folder on another drive', async () => {
  const { run, calls } = fakeRun();
  const drive = parse(root).root.slice(0, 1).toUpperCase() === 'Z' ? 'Y' : 'Z';
  const other = `${drive}:\\local-stt\\note-1`;
  await expect(engine({ run }).transcribe(`${other}\\note.wav`, { workDir: other })).rejects.toThrow(/temporary folder/);
  expect(calls).toHaveLength(0);
});

describe('LocalEngine: one run at a time', () => {
  /** A RunFile whose runs finish only when the test says so, in any order. */
  function gatedRun() {
    const started: string[] = [];
    const gates = new Map<string, (r: { code: number; text: string | null }) => void>();
    const run: RunFile = (_f, args) =>
      new Promise((resolve) => {
        const wav = args[args.length - 1]!;
        started.push(wav);
        gates.set(wav, ({ code, text }) => {
          if (text !== null) writeFileSync(outputOf(args), text);
          resolve({ code, stderr: '' });
        });
      });
    const finish = (wav: string, r: { code: number; text: string | null }) => gates.get(wav)!(r);
    return { run, started, finish };
  }
  const tick = () => new Promise((r) => setTimeout(r, 10));

  it('two calls at once run in order, the second only after the first has finished', async () => {
    const { run, started, finish } = gatedRun();
    const e = engine({ run });
    const dirA = join(root, 'a');
    const dirB = join(root, 'b');
    mkdirSync(dirA);
    mkdirSync(dirB);
    const a = e.transcribe(join(dirA, 'a.wav'), { workDir: dirA });
    const b = e.transcribe(join(dirB, 'b.wav'), { workDir: dirB });
    await tick();
    expect(started).toEqual([join(dirA, 'a.wav')]);
    finish(join(dirA, 'a.wav'), { code: 0, text: 'first' });
    expect(await a).toEqual({ text: 'first' });
    await tick();
    expect(started).toEqual([join(dirA, 'a.wav'), join(dirB, 'b.wav')]);
    finish(join(dirB, 'b.wav'), { code: 0, text: 'second' });
    expect(await b).toEqual({ text: 'second' });
  });

  it('a failing first call does not block the second', async () => {
    const { run, started, finish } = gatedRun();
    const e = engine({ run });
    const a = e.transcribe(join(workDir, 'a.wav'), { workDir });
    const b = e.transcribe(join(workDir, 'b.wav'), { workDir });
    const aDone = engineError(a);
    await tick();
    finish(join(workDir, 'a.wav'), { code: 2, text: null });
    expect((await aDone).code).toBe('exit_2');
    await tick();
    expect(started).toHaveLength(2);
    finish(join(workDir, 'b.wav'), { code: 0, text: 'ok' });
    expect(await b).toEqual({ text: 'ok' });
  });

  it('a call aborted while waiting its turn is aborted without running, and the queue goes on', async () => {
    const { run, started, finish } = gatedRun();
    const e = engine({ run });
    const ac = new AbortController();
    const a = e.transcribe(join(workDir, 'a.wav'), { workDir });
    const b = e.transcribe(join(workDir, 'b.wav'), { workDir, signal: ac.signal });
    const c = e.transcribe(join(workDir, 'c.wav'), { workDir });
    const bDone = engineError(b);
    ac.abort();
    await tick();
    finish(join(workDir, 'a.wav'), { code: 0, text: 'a' });
    expect(await a).toEqual({ text: 'a' });
    expect((await bDone).code).toBe('aborted');
    await tick();
    expect(started).toEqual([join(workDir, 'a.wav'), join(workDir, 'c.wav')]);
    finish(join(workDir, 'c.wav'), { code: 0, text: 'c' });
    expect(await c).toEqual({ text: 'c' });
  });
});

describe('LocalEngine: a call waiting in line is answered at once when aborted', () => {
  function gated() {
    const started: string[] = [];
    let release: (() => void) | undefined;
    const run: RunFile = (_f, args) =>
      new Promise((resolve) => {
        started.push(args[args.length - 1]!);
        release = () => {
          writeFileSync(outputOf(args), 'a');
          resolve({ code: 0, stderr: '' });
        };
      });
    return { run, started, release: () => release!() };
  }

  it('a later abort rejects b with aborted while a is still running', async () => {
    const { run, started, release } = gated();
    const e = engine({ run });
    const a = e.transcribe(join(workDir, 'a.wav'), { workDir });
    let aDone = false;
    void a.then(() => {
      aDone = true;
    });
    const ac = new AbortController();
    const b = e.transcribe(join(workDir, 'b.wav'), { workDir, signal: ac.signal });
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    expect((await engineError(b)).code).toBe('aborted');
    expect(aDone).toBe(false);
    expect(started).toEqual([join(workDir, 'a.wav')]);
    release();
    expect(await a).toEqual({ text: 'a' });
    await new Promise((r) => setTimeout(r, 10));
    expect(started).toEqual([join(workDir, 'a.wav')]);
  });

  it('an already-aborted signal rejects b with aborted while a is still running', async () => {
    const { run, started, release } = gated();
    const e = engine({ run });
    const a = e.transcribe(join(workDir, 'a.wav'), { workDir });
    let aDone = false;
    void a.then(() => {
      aDone = true;
    });
    const ac = new AbortController();
    ac.abort();
    expect((await engineError(e.transcribe(join(workDir, 'b.wav'), { workDir, signal: ac.signal }))).code).toBe('aborted');
    expect(aDone).toBe(false);
    release();
    expect(await a).toEqual({ text: 'a' });
    await new Promise((r) => setTimeout(r, 10));
    expect(started).toEqual([join(workDir, 'a.wav')]);
  });
});

describe('runLocalEngine with a real program', () => {
  // On Windows a kill always ends the program at once, so a program cannot ignore the first one there.
  it.skipIf(process.platform === 'win32')('a program that ignores SIGTERM is killed with SIGKILL after the grace time', async () => {
    const script = join(root, 'stubborn.mjs');
    writeFileSync(script, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n");
    const ac = new AbortController();
    const p = runLocalEngine(process.execPath, [script], { timeoutMs: 30_000, killGraceMs: 400, signal: ac.signal });
    // Time for node to start and set its SIGTERM handler.
    await new Promise((r) => setTimeout(r, 1000));
    const stoppedAt = Date.now();
    ac.abort();
    expect(await p).toEqual({ code: -1, stderr: '' });
    expect(Date.now() - stoppedAt).toBeGreaterThanOrEqual(350);
  });
});

describe('LocalEngineError', () => {
  it('carries its code, and only its code in the message', () => {
    const e = new LocalEngineError('timeout');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('LocalEngineError');
    expect(e.code).toBe('timeout');
    expect(e.message).toBe('Local speech engine failed (timeout)');
  });
});

describe('checkLocalEngineFiles', () => {
  const file = { isFile: () => true };
  const dir = { isFile: () => false };
  const enoent = () => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };

  it('is null when both are regular files', () => {
    expect(checkLocalEngineFiles({ STT_LOCAL_BIN: BIN, STT_LOCAL_MODEL: MODEL }, () => file)).toBeNull();
  });

  it('names the first setting that is unset, missing or not a regular file', () => {
    expect(checkLocalEngineFiles({ STT_LOCAL_BIN: undefined, STT_LOCAL_MODEL: MODEL }, () => file)).toBe('STT_LOCAL_BIN');
    expect(checkLocalEngineFiles({ STT_LOCAL_BIN: BIN, STT_LOCAL_MODEL: undefined }, () => file)).toBe('STT_LOCAL_MODEL');
    expect(checkLocalEngineFiles({ STT_LOCAL_BIN: BIN, STT_LOCAL_MODEL: MODEL }, enoent)).toBe('STT_LOCAL_BIN');
    expect(checkLocalEngineFiles({ STT_LOCAL_BIN: BIN, STT_LOCAL_MODEL: MODEL }, (p) => (p === BIN ? file : enoent()))).toBe('STT_LOCAL_MODEL');
    expect(checkLocalEngineFiles({ STT_LOCAL_BIN: BIN, STT_LOCAL_MODEL: MODEL }, (p) => (p === BIN ? dir : file))).toBe('STT_LOCAL_BIN');
    expect(checkLocalEngineFiles({ STT_LOCAL_BIN: BIN, STT_LOCAL_MODEL: MODEL }, (p) => (p === MODEL ? dir : file))).toBe('STT_LOCAL_MODEL');
  });

  it('works on the real file system by default', () => {
    const bin = join(root, 'transcribe-cli');
    writeFileSync(bin, '');
    expect(checkLocalEngineFiles({ STT_LOCAL_BIN: bin, STT_LOCAL_MODEL: bin })).toBeNull();
    expect(checkLocalEngineFiles({ STT_LOCAL_BIN: bin, STT_LOCAL_MODEL: workDir })).toBe('STT_LOCAL_MODEL');
    expect(checkLocalEngineFiles({ STT_LOCAL_BIN: join(root, 'missing'), STT_LOCAL_MODEL: bin })).toBe('STT_LOCAL_BIN');
  });
});

describe('sharedLocalEngine (meetings on the local engine, Task 3)', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'wa-shared-engine-'));
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));
  const env = (vars: Partial<Record<'STT_PROVIDER' | 'VOICE_STT_PROVIDER', string>>) =>
    parseEnv({ DATA_DIR: dataDir, STT_LOCAL_BIN: BIN, STT_LOCAL_MODEL: MODEL, ...vars });

  it('is undefined when neither meetings nor voice notes use the local engine', () => {
    expect(sharedLocalEngine(parseEnv({ DATA_DIR: dataDir }))).toBeUndefined();
    expect(sharedLocalEngine(parseEnv({ DATA_DIR: dataDir, STT_PROVIDER: 'sarvam', STT_API_KEY: 'test-key', VOICE_STT_PROVIDER: 'sarvam' }))).toBeUndefined();
  });

  it.each([
    ['meetings only', { STT_PROVIDER: 'local' }],
    ['voice notes only', { VOICE_STT_PROVIDER: 'local' }],
    ['both', { STT_PROVIDER: 'local', VOICE_STT_PROVIDER: 'local' }],
  ] as const)('%s: one engine working in DATA_DIR/tmp, which holds both work folders (voice and meetings-local)', async (_name, vars) => {
    const { run, calls } = fakeRun({ text: 'namaste' });
    const engine = sharedLocalEngine(env(vars), { localRun: run })!;
    expect(engine).toBeInstanceOf(LocalEngine);
    expect(localEngineTmpDir(dataDir)).toBe(resolve(dataDir, 'tmp'));
    const voiceWork = join(localEngineTmpDir(dataDir), 'voice', 'voice-1');
    const meetingWork = join(localMeetingTmpDir(dataDir), 'meeting-part-x');
    expect(localMeetingTmpDir(dataDir)).toBe(resolve(dataDir, 'tmp', 'meetings-local'));
    for (const workDir of [voiceWork, meetingWork]) {
      mkdirSync(workDir, { recursive: true });
      await expect(engine.transcribe(join(workDir, 'audio.wav'), { workDir })).resolves.toEqual({ text: 'namaste' });
    }
    expect(calls).toHaveLength(2);
    expect(calls[0]!.file).toBe(BIN);
    // A folder outside DATA_DIR/tmp is still refused.
    await expect(engine.transcribe(join(dataDir, 'meetings', 'tmp', 'a.wav'), { workDir: join(dataDir, 'meetings', 'tmp') })).rejects.toThrow(/inside its temporary folder/);
  });
});
