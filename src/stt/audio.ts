import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AudioPart } from './types.ts';

/** Which environment a program gets: env when given, else minimalEnv(); the parent's whole env only with inheritEnv (nothing uses it). */
export interface EnvChoice {
  env?: NodeJS.ProcessEnv;
  inheritEnv?: true;
}

export interface RunOptions extends EnvChoice {
  timeoutMs: number;
  /** An abort kills the program; the call resolves with code -1 once it has exited and released its files. */
  signal?: AbortSignal;
}

/** Runs a program without a shell. Resolves with its exit code (-1 when it could not start or was stopped) and stderr. */
export type RunFile = (file: string, args: readonly string[], opts: RunOptions) => Promise<{ code: number; stderr: string }>;

export const runFile: RunFile = (file, args, opts) =>
  new Promise((resolve) => {
    const options = {
      timeout: opts.timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' as const,
      env: opts.inheritEnv ? process.env : (opts.env ?? minimalEnv()),
      ...(opts.signal ? { signal: opts.signal } : {}),
    };
    const child = execFile(file, [...args], options, (err, _stdout, stderr) => {
      const result = { code: err === null ? 0 : typeof err.code === 'number' ? err.code : -1, stderr };
      // On an abort the callback comes as soon as the kill is sent, maybe before the program has exited. Wait for its
      // 'exit' only while it is still running, so a caller that then removes the program's files does not race it. Once
      // it has exited (the abort came after the exit, before its pipes closed) there is nothing to wait for: an event
      // that has already fired would never come, and the call would hang.
      if (opts.signal?.aborted && child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        child.once('exit', () => resolve(result));
      } else {
        resolve(result);
      }
    });
  });

const MINIMAL_ENV_NAMES = ['SystemRoot', 'TEMP', 'TMP', 'PATH'] as const;

/**
 * Only what ffmpeg needs to start on Windows: SystemRoot, TEMP, TMP and PATH, those that are set. The default for every
 * program run here, so no key or other setting of the agent's own environment reaches a child program.
 */
export function minimalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of MINIMAL_ENV_NAMES) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** The env a call is given, resolved now, so a runner always sees the env it must use. */
const resolveEnv = (c: EnvChoice): EnvChoice => (c.inheritEnv ? { inheritEnv: true } : { env: c.env ?? minimalEnv() });

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

/**
 * "[Parsed_volumedetect_0 @ 0x...] mean_volume: -23.5 dB" in ffmpeg's volumedetect report -> -23.5. "-inf" is
 * -Infinity. Null when it is missing. Anchored to the filter's own log prefix, so a metadata tag that contains
 * "mean_volume: ..." is never read as the volume.
 */
export function parseMeanVolume(stderr: string): number | null {
  const m = /^\[Parsed_volumedetect_\d+ @ [^\]]+\] mean_volume: (-?(?:\d+(?:\.\d+)?|inf)) dB/m.exec(stderr);
  if (!m) return null;
  return m[1] === '-inf' || m[1] === 'inf' ? Number.NEGATIVE_INFINITY : Number(m[1]);
}

const QUIET = ['-hide_banner', '-nostdin', '-loglevel', 'error'];
/** toMp3's and toWav's default timeout: a whole meeting recording. */
const CONVERT_TIMEOUT_MS = 60 * 60_000;

/** The checked opts of a conversion: maxSeconds (-t) when given, and the timeout. Throws on a value that is not positive. */
function conversionOpts(name: string, opts: { maxSeconds?: number; timeoutMs?: number }): { max: number | undefined; timeoutMs: number } {
  const max = opts.maxSeconds;
  if (max !== undefined && !(Number.isFinite(max) && max > 0)) throw new Error(`${name}: maxSeconds must be a positive number`);
  const timeoutMs = opts.timeoutMs ?? CONVERT_TIMEOUT_MS;
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) throw new Error(`${name}: timeoutMs must be a positive number`);
  return { max, timeoutMs };
}

/**
 * The demuxers an input may be read with. ffmpeg picks the input format from the file's content, so without a list a
 * crafted file (an #EXTM3U playlist, concat or dash) could make it read other local files, such as another client's
 * meeting audio, or fetch a URL. mov covers MP4 and Meet recordings; mp3 covers the prepared parts.
 */
export const INPUT_FORMATS = 'ogg,mp3,mov,mp4,m4a,3gp,3g2,mj2,aac,amr,wav,matroska,webm,flac';
/** Put before every -i: local files only, and only the formats above. */
export const SAFE_INPUT: readonly string[] = ['-protocol_whitelist', 'file', '-format_whitelist', INPUT_FORMATS];

export class Ffmpeg {
  readonly #exe: string;
  readonly #run: RunFile;
  readonly #env: EnvChoice;

  /** opts: the env every call runs with; by default minimalEnv(). */
  constructor(exe: string, run: RunFile = runFile, opts: EnvChoice = {}) {
    this.#exe = exe;
    this.#run = run;
    this.#env = opts;
  }

  /** Runs ffmpeg. A stop through the signal throws its reason, never an AudioError, so callers can tell the two apart. */
  async #ffmpeg(args: readonly string[], timeoutMs: number, signal: AbortSignal | undefined): Promise<{ code: number; stderr: string }> {
    signal?.throwIfAborted();
    const r = await this.#run(this.#exe, args, { timeoutMs, ...(signal ? { signal } : {}), ...resolveEnv(this.#env) });
    signal?.throwIfAborted();
    return r;
  }

  /** Length in seconds, read from ffmpeg's input summary, so ffprobe is not needed. */
  async seconds(input: string, signal?: AbortSignal): Promise<number> {
    // With no output named, ffmpeg exits with an error, after printing the input summary.
    const { stderr } = await this.#ffmpeg(['-hide_banner', '-nostdin', ...SAFE_INPUT, '-i', input], 60_000, signal);
    const seconds = parseDuration(stderr);
    if (seconds === null || !(seconds > 0)) throw new AudioError('no_duration');
    return seconds;
  }

  /**
   * Mono 16 kHz MP3 at 64 kbit/s, the one format all three providers document; the video track of a recording is
   * dropped. An existing output is kept, and a new one appears only when complete (written under a temporary name).
   * Tags and chapters are dropped too: title, GPS location, device or contact name must not leave the PC.
   * opts.maxSeconds (Phase 2b voice notes): the output stops there (`-t`, an output option), so no file, whatever its
   * header claims, is converted past it. Without it the arguments are exactly those meetings have always used.
   * opts.timeoutMs: how long the conversion may run, 60 minutes by default (meetings); voice notes pass a shorter one.
   * It changes no argument.
   */
  async toMp3(input: string, output: string, signal?: AbortSignal, opts: { maxSeconds?: number; timeoutMs?: number } = {}): Promise<void> {
    const { max, timeoutMs } = conversionOpts('toMp3', opts);
    if (existsSync(output)) return;
    const tmp = `${output}.part.mp3`;
    const args = [
      ...QUIET, '-y', ...SAFE_INPUT, '-i', input, '-vn', '-map_metadata', '-1', '-map_chapters', '-1',
      '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '64k', ...(max === undefined ? [] : ['-t', String(max)]), tmp,
    ];
    const { code } = await this.#ffmpeg(args, timeoutMs, signal);
    if (code !== 0 || !existsSync(tmp)) throw new AudioError('convert_failed');
    renameSync(tmp, output);
  }

  /**
   * Mono 16 kHz 16-bit PCM WAV, what the local speech engine takes (Phase 2b amendment L2). Like toMp3: SAFE_INPUT, the
   * video track, tags and chapters dropped, an existing output kept, a new one written under a temporary name, and
   * opts.maxSeconds as the output's -t, just before the output path. opts.timeoutMs as for toMp3.
   */
  async toWav(input: string, output: string, signal?: AbortSignal, opts: { maxSeconds?: number; timeoutMs?: number } = {}): Promise<void> {
    const { max, timeoutMs } = conversionOpts('toWav', opts);
    if (existsSync(output)) return;
    const tmp = `${output}.part.wav`;
    const args = [
      ...QUIET, '-y', ...SAFE_INPUT, '-i', input, '-vn', '-map_metadata', '-1', '-map_chapters', '-1',
      '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', ...(max === undefined ? [] : ['-t', String(max)]), tmp,
    ];
    const { code } = await this.#ffmpeg(args, timeoutMs, signal);
    if (code !== 0 || !existsSync(tmp)) throw new AudioError('convert_failed');
    renameSync(tmp, output);
  }

  /**
   * The mean volume of a file in dB, from ffmpeg's volumedetect filter (decoded into the null muxer, nothing written).
   * -Infinity or about -91 for digital silence. Null when ffmpeg printed none (no audio, or it failed). The local
   * engine's empty-output rule tells silence from sound with it (Phase 2b amendment L2).
   */
  async meanVolumeDb(input: string, signal?: AbortSignal): Promise<number | null> {
    // Not QUIET: volumedetect reports at the info level. -nostats keeps the progress lines out.
    const args = ['-hide_banner', '-nostdin', '-nostats', ...SAFE_INPUT, '-i', input, '-vn', '-af', 'volumedetect', '-f', 'null', '-'];
    const { stderr } = await this.#ffmpeg(args, 60_000, signal);
    return parseMeanVolume(stderr);
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
      const args = [...QUIET, '-y', ...SAFE_INPUT, '-i', input.path, '-f', 'segment', '-segment_time', segmentTime, '-c', 'copy', join(dir, 'part-%03d.mp3')];
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

/** The ffmpeg to use: FFMPEG_PATH when set, otherwise "ffmpeg" on PATH. Null when it does not start. env as for Ffmpeg. */
export async function findFfmpeg(configured: string | undefined, run: RunFile = runFile, env: EnvChoice = {}): Promise<string | null> {
  const exe = configured ?? 'ffmpeg';
  const { code } = await run(exe, ['-hide_banner', '-version'], { timeoutMs: 15_000, ...resolveEnv(env) });
  return code === 0 ? exe : null;
}
