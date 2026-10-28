import { execFile } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, relative, resolve, isAbsolute } from 'node:path';
import type { Env } from '../config/env.ts';
import { minimalEnv, type EnvChoice, type RunOptions } from './audio.ts';

/*
 * The local speech-to-text engine for voice notes (Phase 2b amendment, docs/superpowers/plans/phase-2b-amendments/
 * 2026-10-26-local-stt.md). An open-source model runs on this machine as a child program: Voxtral or Qwen3-ASR through
 * transcribe.cpp, or Whisper through whisper.cpp. It takes a 16 kHz mono WAV and writes the transcript to a text file.
 * - Only fixed flags, the configured paths and paths in the note's own temporary folder are passed: nothing from the
 *   sender. No shell (the engine's own runner is execFile), minimalEnv(), a timeout, and the abort signal.
 * - A stop (abort or timeout) sends SIGTERM, then SIGKILL if the program has not exited 5 s later, so a program that
 *   ignores the first kill never holds the line, or the service's shutdown, forever.
 * - One run at a time, so the CPU's cores are not shared by several models.
 * - Nothing is logged, and stderr is never logged or put in an error: it may echo what was said.
 * - It costs nothing and uses no network.
 */

export type LocalEngineName = Env['STT_LOCAL_ENGINE'];
export type LocalLanguage = Env['STT_LOCAL_LANGUAGE'];

/** Codes: exit_<n> (the program's exit code; -1 when it could not start), no_output, timeout, aborted. */
export class LocalEngineError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Local speech engine failed (${code})`);
    this.name = 'LocalEngineError';
    this.code = code;
  }
}

/**
 * The arguments for one run, exactly as the amendment's command lines, and the file the transcript is written to.
 * - transcribe.cpp (voxtral, qwen3-asr): -m <model> --threads <N> -q -o <out> [-l <lang>] <wav>. The short -t means
 *   translate there, so never -t. -l is documented for Voxtral only, and left out for auto.
 * - whisper.cpp: -m <model> -f <wav> -l <lang> -t <N> -np -nt -otxt -of <base>, which writes <base>.txt. Its default
 *   language is en, so -l is always passed. Never -tr (translate).
 * outPath is the transcript file; for whisper a trailing .txt is taken off to make the base.
 */
export function localEngineArgs(o: {
  engine: LocalEngineName;
  model: string;
  wav: string;
  outPath: string;
  threads: number;
  language: LocalLanguage;
}): { args: string[]; outputFile: string } {
  const threads = String(o.threads);
  if (o.engine === 'whisper') {
    const base = o.outPath.endsWith('.txt') ? o.outPath.slice(0, -'.txt'.length) : o.outPath;
    return { args: ['-m', o.model, '-f', o.wav, '-l', o.language, '-t', threads, '-np', '-nt', '-otxt', '-of', base], outputFile: `${base}.txt` };
  }
  const language = o.engine === 'voxtral' && o.language !== 'auto' ? ['-l', o.language] : [];
  return { args: ['-m', o.model, '--threads', threads, '-q', '-o', o.outPath, ...language, o.wav], outputFile: o.outPath };
}

export interface LocalRunOptions extends RunOptions {
  /** After a stop has sent SIGTERM, how long the program has to exit before SIGKILL. */
  killGraceMs: number;
}

/**
 * Runs the engine's program without a shell. Resolves with its exit code, or -1 when it could not start or was stopped
 * (once it has exited and released its files), and stderr, which is never logged or shown.
 */
export type LocalRunFile = (file: string, args: readonly string[], opts: LocalRunOptions) => Promise<{ code: number; stderr: string }>;

/** How long a stopped program has to exit after SIGTERM before it is killed. */
export const KILL_GRACE_MS = 5_000;

/**
 * The engine's own runner: execFile (no shell, windowsHide), the env given or minimalEnv(). An abort, or timeoutMs as a
 * backstop, sends SIGTERM, then SIGKILL after killGraceMs if the program is still running. It resolves only once the
 * program has exited, so the caller can remove its files.
 */
export const runLocalEngine: LocalRunFile = (file, args, opts) =>
  new Promise((resolveRun) => {
    if (opts.signal?.aborted) {
      resolveRun({ code: -1, stderr: '' });
      return;
    }
    let result: { code: number; stderr: string } | null = null;
    let exited = false;
    let stopped = false;
    let grace: NodeJS.Timeout | undefined;
    let backstop: NodeJS.Timeout | undefined;
    let child: ReturnType<typeof execFile>;
    const hasExited = (): boolean => exited || child.pid === undefined || child.exitCode !== null || child.signalCode !== null;
    const settle = (): void => {
      if (result === null || !hasExited()) return;
      clearTimeout(backstop);
      clearTimeout(grace);
      opts.signal?.removeEventListener('abort', stop);
      resolveRun(stopped ? { code: -1, stderr: result.stderr } : result);
    };
    function stop(): void {
      if (stopped || hasExited()) return;
      stopped = true;
      child.kill('SIGTERM');
      grace = setTimeout(() => {
        if (!hasExited()) child.kill('SIGKILL');
      }, opts.killGraceMs);
    }
    try {
      child = execFile(
        file,
        [...args],
        { windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', env: opts.inheritEnv ? process.env : (opts.env ?? minimalEnv()) },
        (err, _stdout, stderr) => {
          result = { code: err === null ? 0 : typeof err.code === 'number' ? err.code : -1, stderr };
          // execFile also calls back when the output is too large, after sending only SIGTERM: stop it the same way.
          stop();
          settle();
        },
      );
    } catch {
      resolveRun({ code: -1, stderr: '' });
      return;
    }
    child.once('exit', () => {
      exited = true;
      settle();
    });
    backstop = setTimeout(stop, opts.timeoutMs);
    opts.signal?.addEventListener('abort', stop, { once: true });
  });

export interface LocalEngineOptions {
  engine: LocalEngineName;
  /** Absolute path to transcribe-cli or whisper-cli. */
  bin: string;
  /** Absolute path to the model file. */
  model: string;
  threads: number;
  timeoutMs: number;
  language: LocalLanguage;
  /** By default runLocalEngine. */
  run?: LocalRunFile;
  /** After a stop's SIGTERM, how long the program has before SIGKILL; KILL_GRACE_MS by default. */
  killGraceMs?: number;
  /** The temporary folder every note's work folder is inside; a work folder elsewhere is refused. */
  tmpDir: string;
  /** The env the program runs with; by default minimalEnv(). */
  env?: EnvChoice;
}

/** The transcript file's name, in the note's work folder. */
const OUTPUT_NAME = 'transcript.txt';

/** Trimmed, with line breaks and runs of whitespace as single spaces. Devanagari, Latin and their marks are kept as they are. */
const tidy = (text: string): string => text.replace(/\s+/g, ' ').trim();

const removeQuietly = (path: string): void => {
  try {
    rmSync(path, { force: true });
  } catch {
    // Best-effort: the note's work folder is removed with the note.
  }
};

export class LocalEngine {
  readonly #o: LocalEngineOptions;
  readonly #run: LocalRunFile;
  /** The end of the last run in line; it never rejects, so a failed run does not block the next. */
  #tail: Promise<void> = Promise.resolve();

  constructor(o: LocalEngineOptions) {
    this.#o = o;
    this.#run = o.run ?? runLocalEngine;
  }

  /**
   * Transcribes one 16 kHz mono WAV, after any run already in line. The transcript is written into workDir (inside
   * tmpDir), read, then removed. Throws LocalEngineError; an abort, also while waiting in line, is 'aborted'.
   * wavPath must be absolute, so it can never be read as an option (a path starting with '-').
   */
  transcribe(wavPath: string, o: { workDir: string; signal?: AbortSignal }): Promise<{ text: string }> {
    if (!isAbsolute(wavPath)) return Promise.reject(new Error("The local engine's WAV path must be absolute"));
    const workDir = resolve(o.workDir);
    const inside = relative(resolve(this.#o.tmpDir), workDir);
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
      return Promise.reject(new Error("The local engine's work folder must be inside its temporary folder"));
    }
    const { signal } = o;
    let running = false;
    const turn = this.#tail.then(() => {
      running = true;
      return this.#runOnce(wavPath, workDir, signal);
    });
    this.#tail = turn.then(
      () => undefined,
      () => undefined,
    );
    if (!signal) return turn;
    // An abort while waiting in line is answered at once, and the run is skipped when its turn comes. Once the program
    // runs, the answer waits until it has exited, so the caller can remove the work folder safely.
    return new Promise((resolveTurn, rejectTurn) => {
      const onAbort = () => {
        if (!running) rejectTurn(new LocalEngineError('aborted'));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
      turn.then(resolveTurn, rejectTurn).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  async #runOnce(wavPath: string, workDir: string, signal: AbortSignal | undefined): Promise<{ text: string }> {
    if (signal?.aborted) throw new LocalEngineError('aborted');
    const { engine, bin, model, threads, timeoutMs, language } = this.#o;
    const { args, outputFile } = localEngineArgs({ engine, model, wav: wavPath, outPath: join(workDir, OUTPUT_NAME), threads, language });
    // A transcript left by an earlier, stopped run must never be read as this run's.
    removeQuietly(outputFile);

    // The timeout is this engine's own, through the signal, so it is told apart from an abort for certain; the runner's
    // timeout stays as a backstop. A -1 after timeoutMs is a timeout too, for a runner that does not watch the signal.
    const timer = new AbortController();
    let timedOut = false;
    const clock = setTimeout(() => {
      timedOut = true;
      timer.abort();
    }, timeoutMs);
    const started = Date.now();
    let code: number;
    try {
      const env = this.#o.env?.inheritEnv ? { inheritEnv: true as const } : { env: this.#o.env?.env ?? minimalEnv() };
      const killGraceMs = this.#o.killGraceMs ?? KILL_GRACE_MS;
      ({ code } = await this.#run(bin, args, { timeoutMs, killGraceMs, signal: signal ? AbortSignal.any([signal, timer.signal]) : timer.signal, ...env }));
    } finally {
      clearTimeout(clock);
    }

    try {
      if (signal?.aborted) throw new LocalEngineError('aborted');
      if (timedOut || (code === -1 && Date.now() - started >= timeoutMs)) throw new LocalEngineError('timeout');
      if (code !== 0) throw new LocalEngineError(`exit_${code}`);
      if (!existsSync(outputFile)) throw new LocalEngineError('no_output');
      return { text: tidy(readFileSync(outputFile, 'utf8')) };
    } finally {
      removeQuietly(outputFile);
    }
  }
}

/**
 * The first of STT_LOCAL_BIN and STT_LOCAL_MODEL that is unset, missing or not a regular file, by name; null when both
 * are files. Paths are never returned or shown. A link is followed, as the program would follow it.
 */
export function checkLocalEngineFiles(
  env: Pick<Env, 'STT_LOCAL_BIN' | 'STT_LOCAL_MODEL'>,
  stat: (path: string) => { isFile(): boolean } = statSync,
): 'STT_LOCAL_BIN' | 'STT_LOCAL_MODEL' | null {
  for (const name of ['STT_LOCAL_BIN', 'STT_LOCAL_MODEL'] as const) {
    const path = env[name];
    if (path === undefined) return name;
    try {
      if (!stat(path).isFile()) return name;
    } catch {
      return name;
    }
  }
  return null;
}

/**
 * The one LocalEngine the settings describe (STT_LOCAL_ENGINE, STT_LOCAL_BIN, STT_LOCAL_MODEL, STT_LOCAL_THREADS,
 * STT_LOCAL_TIMEOUT_SECONDS per run, STT_LOCAL_LANGUAGE), working inside deps.tmpDir (made absolute). Voice notes and
 * meetings can share it (createVoiceTranscriber's and createLocalMeetingTranscriber's localEngine), so their runs stay
 * one at a time on the CPU; each one's work folder must then be inside this tmpDir. deps.localRun replaces the runner in
 * tests. `setting` names the setting that asked for the engine in the error, never a value. No key.
 */
export function createLocalEngine(
  env: Pick<Env, 'STT_LOCAL_ENGINE' | 'STT_LOCAL_BIN' | 'STT_LOCAL_MODEL' | 'STT_LOCAL_THREADS' | 'STT_LOCAL_TIMEOUT_SECONDS' | 'STT_LOCAL_LANGUAGE'>,
  deps: { tmpDir: string; localRun?: LocalRunFile; setting: 'STT_PROVIDER' | 'VOICE_STT_PROVIDER' },
): LocalEngine {
  const bin = env.STT_LOCAL_BIN;
  const model = env.STT_LOCAL_MODEL;
  // parseEnv refuses this already; checked again for an Env built by hand (defence in depth).
  if (bin === undefined || model === undefined) throw new Error(`STT_LOCAL_BIN and STT_LOCAL_MODEL are required when ${deps.setting} is local`);
  return new LocalEngine({
    engine: env.STT_LOCAL_ENGINE,
    bin,
    model,
    threads: env.STT_LOCAL_THREADS,
    timeoutMs: env.STT_LOCAL_TIMEOUT_SECONDS * 1000,
    language: env.STT_LOCAL_LANGUAGE,
    // Absolute (review round 1, fix 3), so a relative tmpDir cannot break the engine's absolute-path rule.
    tmpDir: resolve(deps.tmpDir),
    ...(deps.localRun ? { run: deps.localRun } : {}),
  });
}

/**
 * The shared engine's temporary folder, DATA_DIR/tmp (absolute). Each user's work folder sits inside it: voice notes in
 * DATA_DIR/tmp/voice, meeting parts in DATA_DIR/tmp/meetings-local (localMeetingTmpDir).
 */
export const localEngineTmpDir = (dataDir: string): string => resolve(join(dataDir, 'tmp'));

/**
 * The one LocalEngine the service builds when STT_PROVIDER or VOICE_STT_PROVIDER is local (plan
 * 2026-10-28-meetings-local-stt.md, Task 3), undefined otherwise. Voice notes and meetings both run on it, so only one
 * model ever runs on the CPU: a voice note that arrives while a meeting part runs waits for that part (at most
 * STT_LOCAL_TIMEOUT_SECONDS), and the reverse. Its folder is localEngineTmpDir. Checks no file (checkLocalEngineFiles
 * does, per user) and runs nothing. deps.localRun replaces the runner in tests.
 */
export function sharedLocalEngine(
  env: Pick<
    Env,
    'DATA_DIR' | 'STT_PROVIDER' | 'VOICE_STT_PROVIDER' | 'STT_LOCAL_ENGINE' | 'STT_LOCAL_BIN' | 'STT_LOCAL_MODEL' | 'STT_LOCAL_THREADS' | 'STT_LOCAL_TIMEOUT_SECONDS' | 'STT_LOCAL_LANGUAGE'
  >,
  deps: { localRun?: LocalRunFile } = {},
): LocalEngine | undefined {
  const setting = env.STT_PROVIDER === 'local' ? 'STT_PROVIDER' : env.VOICE_STT_PROVIDER === 'local' ? 'VOICE_STT_PROVIDER' : null;
  if (setting === null) return undefined;
  return createLocalEngine(env, { tmpDir: localEngineTmpDir(env.DATA_DIR), setting, ...(deps.localRun ? { localRun: deps.localRun } : {}) });
}
