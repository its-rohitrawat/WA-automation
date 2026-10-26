import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadEnv, type Env } from '../src/config/env.ts';
import { checkLocalEngineFiles, LocalEngine, LocalEngineError } from '../src/stt/local.ts';
import { isEngineWav, readWavFile, type WavInfo } from '../src/stt/wav.ts';

/*
 * The owner's check of the local speech-to-text engine (docs/SETUP-mac.md, "Voice notes: local speech-to-text"). Runs
 * the engine set in .env once on one WAV and prints the engine, the lengths, the speed and the transcript to this
 * terminal only. Nothing is logged, stored or sent; no network is used. Of the settings only the engine's name is shown.
 * Takes a 16 kHz mono WAV for now; converting any audio file comes with the service wiring (amendment task L2).
 */

const MAKE_WAV = 'ffmpeg -i in -ar 16000 -ac 1 -c:a pcm_s16le out.wav';

const USAGE = `Local speech-to-text check (docs/SETUP-mac.md, "Voice notes: local speech-to-text").

  npm run stt:local-check -- <note.wav>

Runs the engine set in .env once on a 16 kHz mono WAV and prints the transcript here. Nothing is logged, stored or sent.
Make the WAV from a voice note with: ${MAKE_WAV}
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

/** The one WAV path. A mistake prints the usage, never the argument itself. */
function readWavArg(): string {
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
  return resolve(parsed.positionals[0]!);
}
const wavPath = readWavArg();

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

function readWav(): WavInfo {
  let wav: WavInfo | null;
  try {
    wav = readWavFile(wavPath);
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    return stop(`Could not read the file${typeof code === 'string' ? ` (${code})` : ''}.`);
  }
  if (wav === null) return stop(`This is not a WAV file. Make one from the voice note with:\n  ${MAKE_WAV}`);
  if (!isEngineWav(wav)) return stop(`This WAV is not 16 kHz mono 16-bit. Make one from the voice note with:\n  ${MAKE_WAV}`);
  if (!(wav.seconds > 0)) return stop('This WAV holds no audio.');
  return wav;
}
const wav = readWav();

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
// Ctrl+C or closing the window stops the engine, which is waited for, then the temporary folder is removed.
for (const signal of ['SIGINT', 'SIGHUP', 'SIGTERM'] as const) process.on(signal, () => ac.abort());

workRoot = mkdtempSync(join(tmpdir(), 'wa-stt-check-'));
const workDir = join(workRoot, 'note');
mkdirSync(workDir);
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
console.log('Transcribing (a long note can take longer than the note itself)...');
const started = performance.now();
let text: string;
try {
  ({ text } = await engine.transcribe(wavPath, { workDir, signal: ac.signal }));
} catch (e) {
  removeWorkRoot();
  if (!(e instanceof LocalEngineError)) throw e;
  if (e.code === 'aborted') {
    console.log('Stopped.');
    process.exit(130);
  }
  stop(`Failed (${e.code}). ${HINTS[e.code] ?? EXIT_HINT}`);
}
const wall = (performance.now() - started) / 1000;
removeWorkRoot();

console.log(`Wall time: ${wall.toFixed(1)} s`);
console.log(`Realtime factor: ${(wall / wav.seconds).toFixed(2)} (wall time / audio length; under 1 is faster than realtime)`);
console.log(`Speed: ${(wav.seconds / wall).toFixed(2)}x realtime`);
console.log(`\nTranscript:\n${text === '' ? '(no speech)' : text}`);
