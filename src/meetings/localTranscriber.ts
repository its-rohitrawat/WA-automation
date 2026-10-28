import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, type Dirent } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Env } from '../config/env.ts';
import type { Ffmpeg } from '../stt/audio.ts';
import { createLocalEngine, LocalEngineError, type LocalEngine, type LocalEngineName, type LocalRunFile } from '../stt/local.ts';
import { modelFor } from '../stt/prices.ts';
import type { Segment } from '../stt/types.ts';
import { ONLY_MARKERS, silent } from '../stt/voice.ts';
import { MeetingDeferral } from './audio.ts';
import type { MeetingTranscriber } from './transcribe.ts';

/*
 * Meetings on the local engine (plan docs/superpowers/plans/2026-10-28-meetings-local-stt.md, Task 2): the free
 * open-source model on this machine that voice notes use (src/stt/local.ts), with no key, no network and no spend.
 * - Ten-minute parts (LOCAL_MEETING_PART_SECONDS), cut by the meeting's existing part planning (src/meetings/sttParts.ts).
 * - Each part's MP3 is turned into the engine's 16 kHz mono WAV in a work folder of its own inside tmpDir, run on the
 *   engine (one run at a time, its own timeout per run: STT_LOCAL_TIMEOUT_SECONDS), and the folder removed.
 * - The engine gives plain text: one segment per part, from the part's start to its end, with no speaker label
 *   (speaker null). An empty transcript (or only whisper's non-speech markers) follows the voice notes' EMPTY-OUTPUT
 *   RULE (src/stt/voice.ts): the part's WAV is measured, and only a silent part (mean volume at or below
 *   LOCAL_SILENCE_DB) gives no segment; any other, or one whose volume is unknown, is LocalEngineError('empty_output'),
 *   retried by the processor with the part back to todo, so no stretch of a meeting is lost quietly.
 * - The stop signal stops the conversion and the engine (SIGTERM, then SIGKILL), and the part is run again later.
 * Nothing is logged here (src/meetings/sttParts.ts logs ids, part numbers, seconds and durations); stderr, transcripts
 * and paths never reach a log or an error.
 */

/** Ten-minute parts: a 3-hour meeting is 18 parts, each run (and timed) on its own. */
export const LOCAL_MEETING_PART_SECONDS = 600;

/** How long ffmpeg may take to turn one ten-minute part into a WAV. */
export const LOCAL_PART_CONVERT_TIMEOUT_MS = 10 * 60_000;

/**
 * Where the service puts the parts' work folders: DATA_DIR/tmp/meetings-local (absolute), inside the shared engine's
 * DATA_DIR/tmp (localEngineTmpDir), never under data/meetings/tmp (cleanupTemp's folder).
 */
export const localMeetingTmpDir = (dataDir: string): string => resolve(join(dataDir, 'tmp', 'meetings-local'));

/** The prefix of a part's work folder inside tmpDir; only folders with it are ever removed as left over. */
const WORK_PREFIX = 'meeting-part-';

/** The local engine as a MeetingTranscriber: free (ceiling and cost 0), and it keeps no copies (no forget). */
export interface LocalMeetingTranscriber extends MeetingTranscriber {
  readonly provider: 'local';
  readonly canForget: false;
}

export interface LocalMeetingTranscriberOptions {
  /** STT_LOCAL_ENGINE: names the model (local:<engine>) and says whether whisper's markers are read as nothing. */
  engine: LocalEngineName;
  /** null when ffmpeg is not found: the meeting then waits (no_ffmpeg). */
  ffmpeg: Ffmpeg | null;
  /** Where each part's work folder is made. It must be inside the engine's own tmpDir. */
  tmpDir: string;
  inrPerUsd: number;
}

const removeQuietly = (dir: string): void => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort: a folder left here is removed before the next part (sweep).
  }
};

/**
 * The LocalMeetingTranscriber over an engine. One LocalEngine runs one program at a time, so voice notes and meetings
 * share one (createLocalEngine) to keep the CPU to one model. Exported for tests (a fake engine runner and ffmpeg).
 */
export function localMeetingTranscriber(engine: Pick<LocalEngine, 'transcribe'>, given: LocalMeetingTranscriberOptions): LocalMeetingTranscriber {
  // Absolute: the engine refuses a WAV path that is not.
  const tmpDir = resolve(given.tmpDir);
  const model = modelFor('local', false, given.engine).model;
  let swept = false;
  /**
   * Work folders an earlier run left (a crash, or a removal that failed) go before the first new part. As the voice
   * sweep (src/app.ts), nothing is listed in or removed through a link or junction: tmpDir and the folder above it
   * (DATA_DIR/tmp in the service) must each be a plain folder, and each entry is removed only when it is a plain folder
   * itself. Best effort and silent (this module logs nothing).
   */
  const sweep = (): void => {
    if (swept) return;
    swept = true;
    let entries: Dirent[];
    try {
      for (const path of [dirname(tmpDir), tmpDir]) {
        const st = lstatSync(path); // a junction shows as a link here, as a symlink does
        if (!st.isDirectory() || st.isSymbolicLink()) return;
      }
      entries = readdirSync(tmpDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.name.startsWith(WORK_PREFIX) || !e.isDirectory()) continue;
      const path = join(tmpDir, e.name);
      try {
        if (!lstatSync(path).isDirectory()) continue; // a link or junction: never followed
      } catch {
        continue;
      }
      removeQuietly(path);
    }
  };

  return {
    provider: 'local',
    maxPartSeconds: LOCAL_MEETING_PART_SECONDS,
    inrPerUsd: given.inrPerUsd,
    partCeilingUsd: () => 0,
    partCostUsd: () => 0,
    async transcribePart(part, o) {
      const ffmpeg = given.ffmpeg;
      if (ffmpeg === null) throw new MeetingDeferral('no_ffmpeg');
      const { signal } = o;
      signal?.throwIfAborted();
      mkdirSync(tmpDir, { recursive: true });
      sweep();
      const dir = mkdtempSync(join(tmpDir, WORK_PREFIX));
      try {
        const wav = join(dir, 'audio.wav');
        await ffmpeg.toWav(part.path, wav, signal, { timeoutMs: LOCAL_PART_CONVERT_TIMEOUT_MS });
        const ran = await engine.transcribe(wav, { workDir: dir, ...(signal ? { signal } : {}) });
        // whisper writes a marker for silence, never an empty file: such a transcript is nothing heard.
        const text = given.engine === 'whisper' && ONLY_MARKERS.test(ran.text) ? '' : ran.text;
        // EMPTY-OUTPUT RULE: nothing heard counts only for a silent part; measured before its folder is removed.
        if (text === '' && !silent(await ffmpeg.meanVolumeDb(wav, signal))) throw new LocalEngineError('empty_output');
        const segments: Segment[] = text === '' ? [] : [{ start: 0, end: part.seconds, speaker: null, text }];
        return { model, segments, billedSeconds: null, forgetRef: null };
      } finally {
        // The engine resolves only once its program has exited, so its files are released here.
        removeQuietly(dir);
      }
    },
    canForget: false,
    async forget() {
      // The local engine keeps no copies.
    },
  };
}

/**
 * The LocalMeetingTranscriber STT_PROVIDER=local sets up: the engine STT_LOCAL_ENGINE, STT_LOCAL_BIN, STT_LOCAL_MODEL,
 * STT_LOCAL_THREADS, STT_LOCAL_TIMEOUT_SECONDS (per run, so per part) and STT_LOCAL_LANGUAGE set, working inside
 * deps.tmpDir. deps.localEngine, when given, is run instead: the one engine shared with voice notes (createLocalEngine,
 * with a tmpDir that holds deps.tmpDir), so a voice note and a meeting part never run at once. deps.localRun replaces
 * the engine's runner in tests. No key.
 */
export function createLocalMeetingTranscriber(
  env: Pick<Env, 'STT_LOCAL_ENGINE' | 'STT_LOCAL_BIN' | 'STT_LOCAL_MODEL' | 'STT_LOCAL_THREADS' | 'STT_LOCAL_TIMEOUT_SECONDS' | 'STT_LOCAL_LANGUAGE'>,
  deps: { ffmpeg: Ffmpeg | null; tmpDir: string; inrPerUsd: number; localRun?: LocalRunFile; localEngine?: Pick<LocalEngine, 'transcribe'> },
): LocalMeetingTranscriber {
  const tmpDir = resolve(deps.tmpDir);
  // The settings are checked even with a shared engine given (the same error when bin or model is unset).
  const own = createLocalEngine(env, { tmpDir, setting: 'STT_PROVIDER', ...(deps.localRun ? { localRun: deps.localRun } : {}) });
  return localMeetingTranscriber(deps.localEngine ?? own, { engine: env.STT_LOCAL_ENGINE, ffmpeg: deps.ffmpeg, tmpDir, inrPerUsd: deps.inrPerUsd });
}
