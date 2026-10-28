import { join, resolve } from 'node:path';
import type { Env } from './config/env.ts';
import type { VoiceProblem } from './health/health.ts';
import { Ffmpeg } from './stt/audio.ts';
import { checkLocalEngineFiles, type LocalEngine } from './stt/local.ts';
import { createVoiceTranscriber, type VoiceTranscriber } from './stt/voice.ts';
import type { Logger } from './util/logger.ts';

/** What the service gives the media pipeline for voice notes and audio files (Phase 2b Task 10). */
export interface VoiceDeps {
  /** Null: VOICE_STT_PROVIDER is none, or the local engine is not set up. Voice notes are then kept, not transcribed. */
  voice: VoiceTranscriber | null;
  /** STT_MAX_SECONDS. */
  maxVoiceSeconds: number;
  /** Why voice notes are not transcribed, for the health line; null when nothing is wrong (or they are off). */
  voiceProblem: VoiceProblem | null;
}

export interface VoiceDepsSeams {
  /** findFfmpeg from src/stt/audio.ts: the program's name or path when it runs, else null. May throw. */
  findFfmpeg: (configured: string | undefined) => Promise<string | null>;
  /** checkLocalEngineFiles from src/stt/local.ts: the first of the two settings that is not a file, by name. */
  check?: (env: Pick<Env, 'STT_LOCAL_BIN' | 'STT_LOCAL_MODEL'>) => 'STT_LOCAL_BIN' | 'STT_LOCAL_MODEL' | null;
  /**
   * sharedLocalEngine from src/stt/local.ts: the one engine voice notes and meetings share, so only one model runs at a
   * time. Its folder (DATA_DIR/tmp) holds DATA_DIR/tmp/voice. Not given: a local transcriber builds its own.
   */
  localEngine?: Pick<LocalEngine, 'transcribe'>;
  log: Logger;
}

/**
 * Builds the voice transcriber VOICE_STT_PROVIDER names, once, when the service starts. Never stops the service:
 * - none: no transcriber (stt_none, info). Nothing is searched or checked.
 * - local: STT_LOCAL_BIN and STT_LOCAL_MODEL must each be a file. If one is not, voice notes are kept but not
 *   transcribed (local_not_set_up_bin or local_not_set_up_model; a check that throws counts as STT_LOCAL_BIN), and the
 *   warning and the health line name the setting, never its path.
 * - local or paid: ffmpeg is looked for (FFMPEG_PATH, else the PATH). Without it the transcriber is still built, but
 *   sends nothing: every note is kept as format_not_supported for `cli transcribe-voice` later (no_ffmpeg).
 * The conversion folders go in DATA_DIR/tmp/voice, as an absolute path. Logs codes and setting names only: never a
 * path, a key or an error message.
 */
export async function buildVoiceDeps(env: Env, s: VoiceDepsSeams): Promise<VoiceDeps> {
  const { log } = s;
  const maxVoiceSeconds = env.STT_MAX_SECONDS;
  const choice = env.VOICE_STT_PROVIDER;
  if (choice === 'none') {
    log.info({ code: 'stt_none' }, 'voice notes are kept, not transcribed: VOICE_STT_PROVIDER is none');
    return { voice: null, maxVoiceSeconds, voiceProblem: null };
  }
  if (choice === 'local') {
    let missing: 'STT_LOCAL_BIN' | 'STT_LOCAL_MODEL' | null;
    try {
      missing = (s.check ?? checkLocalEngineFiles)(env);
    } catch {
      missing = 'STT_LOCAL_BIN'; // the check itself failed: treated as not set up, never a crash
    }
    if (missing !== null) {
      log.warn({ code: 'local_not_set_up', setting: missing }, 'voice notes are kept but not transcribed: the local speech engine is not set up');
      return { voice: null, maxVoiceSeconds, voiceProblem: missing === 'STT_LOCAL_MODEL' ? 'local_not_set_up_model' : 'local_not_set_up_bin' };
    }
  }
  let exe: string | null;
  try {
    exe = await s.findFfmpeg(env.FFMPEG_PATH);
  } catch {
    exe = null;
  }
  if (exe === null) log.warn({ code: 'no_ffmpeg_voice' }, 'voice notes are kept but not transcribed: ffmpeg not found');
  const voice = createVoiceTranscriber(env, {
    ffmpeg: exe === null ? null : new Ffmpeg(exe), tmpDir: resolve(join(env.DATA_DIR, 'tmp', 'voice')),
    ...(s.localEngine && choice === 'local' ? { localEngine: s.localEngine } : {}),
  });
  if (voice !== null && exe !== null) log.info({ provider: voice.provider }, 'voice notes are transcribed');
  return { voice, maxVoiceSeconds, voiceProblem: exe === null ? 'no_ffmpeg' : null };
}
