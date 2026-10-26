import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadEnv, type Env } from '../src/config/env.ts';
import { AudioError, Ffmpeg, findFfmpeg } from '../src/stt/audio.ts';
import { checkLocalEngineFiles, LocalEngine, LocalEngineError } from '../src/stt/local.ts';
import { LOCAL_SILENCE_DB } from '../src/stt/voice.ts';
import { isEngineWav, readWavFile, type WavInfo } from '../src/stt/wav.ts';

/*
 * The owner's check of the local speech-to-text engine (docs/SETUP-mac.md, "Voice notes: local speech-to-text"). Runs
 * the engine set in .env once on one audio file and prints the engine, the lengths, the mean volume, the speed and the
 * transcript to this terminal only. Nothing is logged, stored or sent; no network is used. Of the settings only the
 * engine's name is shown.
 * Any audio file is converted first, as the service does (Phase 2b amendment L2): with ffmpeg (FFMPEG_PATH, or ffmpeg
 * on PATH) to a 16 kHz mono WAV in this run's own temporary folder. A 16 kHz mono 16-bit WAV is used as it is, so the
 * check also runs without ffmpeg; the mean volume is then not measured.
 */

const MAKE_WAV = 'ffmpeg -i in -ar 16000 -ac 1 -c:a pcm_s16le out.wav';

const USAGE = `Local speech-to-text check (docs/SETUP-mac.md, "Voice notes: local speech-to-text").

  npm run stt:local-check -- <audio file>

Runs the engine set in .env once on the file and prints the transcript here. Nothing is logged, stored or sent.
Any audio file (a WhatsApp voice note, .mp3, .m4a, ...) is converted with ffmpeg first. A 16 kHz mono WAV is used as it
is, without ffmpeg. Make one by hand with: ${MAKE_WAV}
`;

/** This run's own temporary folder, removed when the run ends however it ends. */
let workRoot: string | null = null;
function removeWorkRoot(): void {
  if (workRoot === null) return;
  try {
    rmSync(workRoot, { recursive: true, force: true });
  } catch {
    // Left in the system's temporary folder, which the system clears.
  }
  workRoot = null;
}
process.on('exit', removeWorkRoot);

// Anything unexpected shows its type and code only: a message can carry a path or what was said.
function fatal(err: unknown): void {
  const code = (err as { code?: unknown } | null)?.code;
  process.stderr.write(`Stopped: ${err instanceof Error ? err.name : 'error'}${typeof code === 'string' || typeof code === 'number' ? ` (${code})` : ''}\n`);
  process.exit(1);
}
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);

function stop(message: string): never {
  console.log(message);
  process.exit(1);
}

/** The one file path. A mistake prints the usage, never the argument itself. */
function readFileArg(): string {
  let parsed;
  try {
    parsed = parseArgs({ options: { help: { type: 'boolean', short: 'h', default: false } }, allowPositionals: true });
  } catch {
    return stop(`Unknown option.\n\n${USAGE}`);
  }
  if (parsed.values.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (parsed.positionals.length !== 1) return stop(USAGE);
  // Absolute, so the file can never be read as an option by ffmpeg or the engine.
  return resolve(parsed.positionals[0]!);
}
const inputPath = readFileArg();

/** The worktree's own .env, wherever the command is started from. Errors name settings, never their values. */
const ENV_FILE = fileURLToPath(new URL('../.env', import.meta.url));
function readSettings(): Env {
  try {
    return loadEnv(ENV_FILE);
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    const why =
      typeof code === 'string' ? `could not be read (${code})`
      : e instanceof Error && e.message.startsWith('Invalid configuration in: ') ? e.message
      : 'has a setting the check cannot use';
    return stop(`.env: ${why} (see docs/SETUP-mac.md)`);
  }
}
const env = readSettings();

if (env.VOICE_STT_PROVIDER !== 'local') {
  stop('VOICE_STT_PROVIDER is not local in .env. Set VOICE_STT_PROVIDER=local, STT_LOCAL_BIN and STT_LOCAL_MODEL first (see docs/SETUP-mac.md).');
}
const missing = checkLocalEngineFiles(env);
if (missing !== null) stop(`${missing} in .env is not a file that exists. Check the full path (see docs/SETUP-mac.md).`);

/** The file's WAV header when it is a WAV (null when it is not one). A file that cannot be read stops the check. */
function readHeader(): WavInfo | null {
  try {
    return readWavFile(inputPath);
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    return stop(`Could not read the file${typeof code === 'string' ? ` (${code})` : ''}.`);
  }
}
const header = readHeader();
/** A ready engine WAV is used as it is; anything else is converted. */
const ready = header !== null && isEngineWav(header);
if (ready && !(header.seconds > 0)) stop('This WAV holds no audio.');

/** ffmpeg, found as the service finds it: FFMPEG_PATH, else ffmpeg on PATH. Null when it does not start. */
async function ffmpegOrNull(): Promise<Ffmpeg | null> {
  try {
    const exe = await findFfmpeg(env.FFMPEG_PATH);
    return exe === null ? null : new Ffmpeg(exe);
  } catch {
    return null;
  }
}
const ffmpeg = await ffmpegOrNull();
if (!ready && ffmpeg === null) {
  const what = header === null ? 'This is not a 16 kHz mono WAV' : 'This WAV is not 16 kHz mono 16-bit.';
  stop(
    `${what}${header === null ? ',' : ''} and ffmpeg was not found to convert it. Install ffmpeg, or set FFMPEG_PATH in .env ` +
      `(see docs/SETUP-mac.md), or make a WAV from the voice note with:\n  ${MAKE_WAV}`,
  );
}

const HINTS: Record<string, string> = {
  timeout: 'The engine took longer than STT_LOCAL_TIMEOUT_SECONDS. Try a shorter note, more STT_LOCAL_THREADS, or STT_LOCAL_ENGINE=qwen3-asr.',
  no_output: 'The engine finished but wrote no transcript file. Its version may take other options: build the version docs/SETUP-mac.md names.',
  'exit_-1': 'The program in STT_LOCAL_BIN did not start, or the system stopped it (for example when memory ran out).',
};
const EXIT_HINT =
  'The engine stopped with an error. Check that STT_LOCAL_ENGINE fits the program in STT_LOCAL_BIN (transcribe-cli for voxtral and ' +
  'qwen3-asr, whisper-cli for whisper) and that STT_LOCAL_MODEL is that engine\'s model. Its own message is not shown, since it can ' +
  'repeat what was said.';

const ac = new AbortController();
// Ctrl+C or closing the window stops ffmpeg or the engine, which is waited for, then the temporary folder is removed.
for (const signal of ['SIGINT', 'SIGHUP', 'SIGTERM'] as const) process.on(signal, () => ac.abort());

function stopped(): never {
  removeWorkRoot();
  console.log('Stopped.');
  process.exit(130);
}

workRoot = mkdtempSync(join(tmpdir(), 'wa-stt-check-'));
const workDir = join(workRoot, 'note');
mkdirSync(workDir);

/** The WAV the engine reads, and its length: the file itself, or the conversion in this run's folder. */
async function engineWav(): Promise<{ path: string; seconds: number }> {
  if (ready) return { path: inputPath, seconds: header.seconds };
  const out = join(workDir, 'audio.wav');
  console.log('Converting with ffmpeg to a 16 kHz mono WAV...');
  try {
    await ffmpeg!.toWav(inputPath, out, ac.signal);
  } catch (e) {
    if (ac.signal.aborted) stopped();
    if (e instanceof AudioError) {
      removeWorkRoot();
      stop(`ffmpeg could not convert this file (${e.code}). Check that it is an audio file.`);
    }
    throw e;
  }
  const converted = readWavFile(out);
  if (converted === null || !isEngineWav(converted) || !(converted.seconds > 0)) {
    removeWorkRoot();
    stop('The converted file holds no audio.');
  }
  return { path: out, seconds: converted.seconds };
}
const wav = await engineWav();

/** The mean volume in dB, as the service measures it; null when ffmpeg is not there or reported none. */
async function meanVolume(): Promise<number | null> {
  if (ffmpeg === null) return null;
  try {
    return await ffmpeg.meanVolumeDb(wav.path, ac.signal);
  } catch (e) {
    if (ac.signal.aborted) stopped();
    throw e;
  }
}
const volume = await meanVolume();

const engine = new LocalEngine({
  engine: env.STT_LOCAL_ENGINE,
  // checkLocalEngineFiles found both.
  bin: env.STT_LOCAL_BIN!,
  model: env.STT_LOCAL_MODEL!,
  threads: env.STT_LOCAL_THREADS,
  timeoutMs: env.STT_LOCAL_TIMEOUT_SECONDS * 1000,
  language: env.STT_LOCAL_LANGUAGE,
  tmpDir: workRoot,
});

console.log(`Engine: ${env.STT_LOCAL_ENGINE}`);
console.log(`Audio length: ${wav.seconds.toFixed(1)} s`);
console.log(
  volume !== null ? `Mean volume: ${volume.toFixed(1)} dB (${LOCAL_SILENCE_DB} dB or lower counts as silence)`
  : ffmpeg === null ? 'Mean volume: not measured (ffmpeg not found)'
  : 'Mean volume: not measured (ffmpeg reported none)',
);
console.log('Transcribing (a long note can take longer than the note itself)...');
const started = performance.now();
let text: string;
try {
  ({ text } = await engine.transcribe(wav.path, { workDir, signal: ac.signal }));
} catch (e) {
  removeWorkRoot();
  if (!(e instanceof LocalEngineError)) throw e;
  if (e.code === 'aborted') stopped();
  stop(`Failed (${e.code}). ${HINTS[e.code] ?? EXIT_HINT}`);
}
const wall = (performance.now() - started) / 1000;
removeWorkRoot();

console.log(`Wall time: ${wall.toFixed(1)} s`);
console.log(`Realtime factor: ${(wall / wav.seconds).toFixed(2)} (wall time / audio length; under 1 is faster than realtime)`);
console.log(`Speed: ${(wav.seconds / wall).toFixed(2)}x realtime`);
// The service's empty-output rule: an empty transcript of audio that is not silent is retried, never "no speech".
const silent = volume !== null && volume <= LOCAL_SILENCE_DB;
const empty =
  silent ? '(no speech)'
  : volume === null ? '(empty; the volume was not measured, so the service would retry this note as empty_output)'
  : '(empty, but the audio is not silent: the service would retry this note as empty_output)';
console.log(`\nTranscript:\n${text === '' ? empty : text}`);
