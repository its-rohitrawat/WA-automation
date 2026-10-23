import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AudioPart } from './types.ts';

export interface RunOptions {
  timeoutMs: number;
  /** An abort kills the program; the call then resolves with code -1. */
  signal?: AbortSignal;
  /** The program's whole environment. Missing: the parent's is inherited (the bake-off script only). */
  env?: NodeJS.ProcessEnv;
}

/** Runs a program without a shell. Resolves with its exit code (-1 when it could not start or was stopped) and stderr. */
export type RunFile = (file: string, args: readonly string[], opts: RunOptions) => Promise<{ code: number; stderr: string }>;

export const runFile: RunFile = (file, args, opts) =>
  new Promise((resolve) => {
    const options = {
      timeout: opts.timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' as const,
      ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.env ? { env: opts.env } : {}),
    };
    execFile(file, [...args], options, (err, _stdout, stderr) => {
      resolve({ code: err === null ? 0 : typeof err.code === 'number' ? err.code : -1, stderr });
    });
  });

const MINIMAL_ENV_NAMES = ['SystemRoot', 'TEMP', 'TMP', 'PATH'] as const;

/**
 * Only what ffmpeg needs to start on Windows: SystemRoot, TEMP, TMP and PATH, those that are set. Production passes this,
 * so no key or other setting of the agent's own environment reaches a child program.
 */
export function minimalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of MINIMAL_ENV_NAMES) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

export class AudioError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Audio step failed (${code})`);
    this.name = 'AudioError';
    this.code = code;
  }
}

/**
 * "  Duration: 00:01:02.50" in ffmpeg's input summary -> 62.5 seconds. Null when it is missing or "N/A". Anchored to the
 * summary line's two-space indent, so a metadata tag that contains "Duration: ..." is never read as the length.
 */
export function parseDuration(stderr: string): number | null {
  const m = /^ {2}Duration: (\d+):(\d{2}):(\d{2}(?:\.\d+)?)/m.exec(stderr);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

const QUIET = ['-hide_banner', '-nostdin', '-loglevel', 'error'];

export class Ffmpeg {
  readonly #exe: string;
  readonly #run: RunFile;
  readonly #env: NodeJS.ProcessEnv | undefined;

  /** opts.env: the env every call runs with (production passes minimalEnv()); missing, the parent's is inherited. */
  constructor(exe: string, run: RunFile = runFile, opts: { env?: NodeJS.ProcessEnv } = {}) {
    this.#exe = exe;
    this.#run = run;
    this.#env = opts.env;
  }

  /** Runs ffmpeg. A stop through the signal throws its reason, never an AudioError, so callers can tell the two apart. */
  async #ffmpeg(args: readonly string[], timeoutMs: number, signal: AbortSignal | undefined): Promise<{ code: number; stderr: string }> {
    signal?.throwIfAborted();
    const r = await this.#run(this.#exe, args, { timeoutMs, ...(signal ? { signal } : {}), ...(this.#env ? { env: this.#env } : {}) });
    signal?.throwIfAborted();
    return r;
  }

  /** Length in seconds, read from ffmpeg's input summary, so ffprobe is not needed. */
  async seconds(input: string, signal?: AbortSignal): Promise<number> {
    // With no output named, ffmpeg exits with an error, after printing the input summary.
    const { stderr } = await this.#ffmpeg(['-hide_banner', '-nostdin', '-i', input], 60_000, signal);
    const seconds = parseDuration(stderr);
    if (seconds === null || !(seconds > 0)) throw new AudioError('no_duration');
    return seconds;
  }

  /**
   * Mono 16 kHz MP3 at 64 kbit/s, the one format all three providers document; the video track of a recording is
   * dropped. An existing output is kept, and a new one appears only when complete (written under a temporary name).
   * Tags and chapters are dropped too: title, GPS location, device or contact name must not leave the PC.
   */
  async toMp3(input: string, output: string, signal?: AbortSignal): Promise<void> {
    if (existsSync(output)) return;
    const tmp = `${output}.part.mp3`;
    const args = [
      ...QUIET, '-y', '-i', input, '-vn', '-map_metadata', '-1', '-map_chapters', '-1',
      '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '64k', tmp,
    ];
    const { code } = await this.#ffmpeg(args, 60 * 60_000, signal);
    if (code !== 0 || !existsSync(tmp)) throw new AudioError('convert_failed');
    renameSync(tmp, output);
  }

  /**
   * Cuts a prepared MP3 into equal parts of at most partSeconds without re-encoding, into its own folder, and measures
   * every part so the offsets are exact. A folder that was finished before is reused.
   */
  async split(input: AudioPart, dir: string, partSeconds: number, signal?: AbortSignal): Promise<AudioPart[]> {
    if (input.seconds <= partSeconds) return [input];
    const finished = join(dir, '.done');
    if (!existsSync(finished)) {
      mkdirSync(dir, { recursive: true });
      // Equal parts, so there is no tiny, separately paid last part. The count still matches the plan's ceil.
      const count = Math.ceil(input.seconds / partSeconds);
      const segmentTime = (input.seconds / count).toFixed(3);
      const args = [...QUIET, '-y', '-i', input.path, '-f', 'segment', '-segment_time', segmentTime, '-c', 'copy', join(dir, 'part-%03d.mp3')];
      const { code } = await this.#ffmpeg(args, 30 * 60_000, signal);
      if (code !== 0) throw new AudioError('split_failed');
      writeFileSync(finished, '');
    }
    const files = readdirSync(dir).filter((f) => /^part-\d{3}\.mp3$/.test(f)).sort();
    if (files.length === 0) throw new AudioError('split_failed');
    const parts: AudioPart[] = [];
    let offset = input.offset;
    for (const f of files) {
      const path = join(dir, f);
      const seconds = await this.seconds(path, signal);
      parts.push({ path, seconds, offset });
      offset += seconds;
    }
    return parts;
  }
}

/**
 * The ffmpeg to use: FFMPEG_PATH when set, otherwise "ffmpeg" on PATH. Null when it does not start. env as for Ffmpeg
 * (production passes minimalEnv()).
 */
export async function findFfmpeg(configured: string | undefined, run: RunFile = runFile, env?: NodeJS.ProcessEnv): Promise<string | null> {
  const exe = configured ?? 'ffmpeg';
  const { code } = await run(exe, ['-hide_banner', '-version'], { timeoutMs: 15_000, ...(env ? { env } : {}) });
  return code === 0 ? exe : null;
}
