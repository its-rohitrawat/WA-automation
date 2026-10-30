import type { Env } from '../config/env.ts';
import { trackerDbPath } from '../config/paths.ts';
import { getClientByCode } from '../store/clients.ts';
import { openDb, type Db } from '../store/db.ts';
import { failedLocalVoice, queueFailedLocalVoice, queueVoiceBacklog, voiceBacklog, type VoiceBacklogRow } from '../store/media.ts';
import { findFfmpeg } from '../stt/audio.ts';
import { checkLocalEngineFiles } from '../stt/local.ts';
import { canSendVoice, sizeBoundSeconds, VOICE_LENGTH_TOLERANCE_S, voiceCeilingUsd } from '../stt/voice.ts';
import { systemClock, type Clock } from '../util/clock.ts';
import { CorrectionError } from './corrections.ts';

/*
 * `cli transcribe-voice` (Phase 2b Task 8, V6, N2, N4): the voice notes and audio files saved before Phase 2b, still
 * without a transcript. Without --yes it only counts them and prints the minutes and the cost; with --yes it queues
 * them, and the running service transcribes them (with a paid provider each counts toward the daily spend cap).
 * - Two cost figures. The service measures each note after converting it, refuses one measured longer than
 *   STT_MAX_SECONDS + VOICE_LENGTH_TOLERANCE_S, and holds the measured length plus the tolerance. The length is not
 *   known here, so: about $X, each file estimated from its size at min(size bound, STT_MAX_SECONDS + tolerance)
 *   seconds (a file with no size at that limit), and at most $Y if every file runs to that limit, which never
 *   understates. Both are rounded up to the cent; the minutes are the estimates, rounded up.
 * - VOICE_STT_PROVIDER decides (Phase 2b amendment L2; STT_PROVIDER is the meetings' setting). With 'local' the engine
 *   on this computer transcribes them: the cost lines say $0 and nothing counts toward the spend cap. Every file still
 *   needs ffmpeg (it is converted to the engine's WAV).
 * - With 'local', STT_LOCAL_BIN and STT_LOCAL_MODEL must each be a file (checkLocalEngineFiles, as the service checks
 *   when it starts; Phase 2b final review). Otherwise nothing is listed or queued: the running service has no engine,
 *   so a queued note would only finish "not transcribed" again. The refusal names the setting, never its path.
 * - --failed (Phase 2b final review): instead of the backlog, the notes that failed on this computer (the local engine's
 *   local_* errors, or ffmpeg's audio_convert_failed, audio_no_duration, audio_split_failed) are listed and, with
 *   --yes, queued again with a fresh set of tries. Only with 'local': a note never fails at a paid provider without
 *   possibly having been paid, so stt_* failures are never queued again, and the option is refused for a paid provider.
 * - No key, no provider and no network: the rules and prices come from src/stt/voice.ts (canSendVoice,
 *   sizeBoundSeconds, voiceCeilingUsd). STT_API_KEY is never read here, and no STT_LOCAL_* value is shown.
 * - The size never refuses a file (Task 5 review round 2: a 1-minute 128 kbit/s MP3 is about 960 KB, a size bound of
 *   640 s); the service refuses only a note measured too long. Every file is converted with ffmpeg first, whatever its
 *   format and provider (Task 5 review round 1), so without ffmpeg no file is queued (canSendVoice), and none finishes
 *   format_not_supported again; they stay listed, and running this again once ffmpeg is there picks them up. The
 *   service looks for ffmpeg only when it starts, so the line says to restart it after installing ffmpeg.
 * - The output is counts, minutes, dollars and the setting names only: never a file name, a path, a transcript or a key.
 */

/** What the command needs. CliDeps (src/cli/commands.ts) fits; the optional seams are for tests. */
export interface TranscribeVoiceDeps {
  env: Env;
  out: (line: string) => void;
  /** The tracker database; tests pass a seeded one, which is left open. Without it DATA_DIR's is opened and closed. */
  db?: Db;
  clock?: Clock;
  /** Finds ffmpeg (src/stt/audio.ts by default); null or a throw means there is none. Asked only when a file needs it. */
  findFfmpeg?: (configured: string | undefined) => Promise<string | null>;
  /**
   * checkLocalEngineFiles (src/stt/local.ts) by default: the first of STT_LOCAL_BIN and STT_LOCAL_MODEL that is not a
   * file, by name. Asked only with VOICE_STT_PROVIDER=local; a throw counts as STT_LOCAL_BIN.
   */
  checkLocalEngine?: (env: Pick<Env, 'STT_LOCAL_BIN' | 'STT_LOCAL_MODEL'>) => 'STT_LOCAL_BIN' | 'STT_LOCAL_MODEL' | null;
}

const NOT_SET_UP = 'Speech-to-text for voice notes is not set up (VOICE_STT_PROVIDER is none). Nothing changed.';
const LOCAL_COST = 'Cost: $0 (local engine on this computer).';
const FREE = 'It costs nothing and does not count toward the daily spend cap.';
const NOTHING = 'No saved voice notes or audio files are waiting for a transcript. Nothing changed.';
const NOTHING_FAILED = 'No voice notes or audio files failed in the local engine. Nothing changed.';
const FAILED_NEEDS_LOCAL =
  'transcribe-voice --failed tries again notes the local engine could not transcribe: it works only with VOICE_STT_PROVIDER=local. Nothing changed.';
/** The setting's name only, never its value. */
const localNotSetUp = (name: string) =>
  `The local speech engine is not set up (${name}). Fix ${name} in .env (docs/SETUP-mac.md, section 8), restart the service, then run this again. Nothing changed.`;

const files = (n: number) => `${n} voice note${n === 1 ? '' : 's'} or audio file${n === 1 ? '' : 's'}`;
const minutes = (n: number) => `${n} minute${n === 1 ? '' : 's'}`;
/** A cost is rounded up to the cent, so a few seconds never print as $0.00. */
const dollarsUp = (usd: number) => (Math.ceil(usd * 100 - 1e-9) / 100).toFixed(2);

async function hasFfmpeg(deps: TranscribeVoiceDeps): Promise<boolean> {
  try {
    return (await (deps.findFfmpeg ?? findFfmpeg)(deps.env.FFMPEG_PATH)) !== null;
  } catch {
    return false;
  }
}

/** The first local engine setting that is not a file, by name; null when both are. A check that throws is STT_LOCAL_BIN. */
function localEngineMissing(deps: TranscribeVoiceDeps): 'STT_LOCAL_BIN' | 'STT_LOCAL_MODEL' | null {
  try {
    return (deps.checkLocalEngine ?? checkLocalEngineFiles)(deps.env);
  } catch {
    return 'STT_LOCAL_BIN';
  }
}

/** What differs between the backlog and --failed: which files, how they are queued, and the words. */
interface Listing {
  rows: (db: Db, o: { clientId?: number }) => Promise<VoiceBacklogRow[]>;
  queue: (db: Db, ids: number[], at: string) => Promise<number>;
  nothing: string;
  /** The first line: "To transcribe: ..." with the count (and the minutes, when there are files to send). */
  count: (n: string) => string;
  /** The dry run's line before "Nothing was changed", and the --yes line after the count queued. */
  dryRun: (cap: string) => string;
  queued: (n: number, cap: string) => string;
  rerun: string;
}

const BACKLOG: Listing = {
  rows: voiceBacklog,
  queue: queueVoiceBacklog,
  nothing: NOTHING,
  count: (n) => `To transcribe: ${n} saved before Phase 2b`,
  dryRun: (cap) => `With --yes the running service transcribes them, for the record. ${cap}`,
  queued: (n, cap) => `${n} queued. The running service now transcribes them, for the record. ${cap}`,
  rerun: 'Nothing was changed. Re-run with --yes to queue them.',
};

const FAILED: Listing = {
  rows: failedLocalVoice,
  queue: queueFailedLocalVoice,
  nothing: NOTHING_FAILED,
  count: (n) => `To try again: ${n} the local engine could not transcribe`,
  dryRun: (cap) => `With --yes the running service tries them again (3 tries each). ${cap}`,
  queued: (n, cap) => `${n} queued again. The running service now tries them again (3 tries each). ${cap}`,
  rerun: 'Nothing was changed. Re-run with --yes to queue them again.',
};

/** `cli transcribe-voice [--client CODE] [--failed] [--yes]`. */
export async function transcribeVoiceCommand(opts: { client?: string; yes: boolean; failed?: boolean }, deps: TranscribeVoiceDeps): Promise<void> {
  const { env, out } = deps;
  const provider = env.VOICE_STT_PROVIDER;
  if (provider === 'none') {
    out(NOT_SET_UP);
    return;
  }
  if (opts.failed === true && provider !== 'local') {
    out(FAILED_NEEDS_LOCAL);
    return;
  }
  if (provider === 'local') {
    const missing = localEngineMissing(deps);
    if (missing !== null) {
      out(localNotSetUp(missing));
      return;
    }
  }
  const listing = opts.failed === true ? FAILED : BACKLOG;
  const db = deps.db ?? openDb(trackerDbPath(env.DATA_DIR));
  try {
    let clientId: number | undefined;
    if (opts.client !== undefined) {
      const code = opts.client.trim().toUpperCase();
      const c = await getClientByCode(db, code);
      if (!c) throw new CorrectionError(`No client with code ${opts.client}`);
      if (!c.active) throw new CorrectionError(`Client ${c.code} is not in the allow-list`);
      clientId = c.id;
    }
    const rows = await listing.rows(db, clientId === undefined ? {} : { clientId });
    if (rows.length === 0) {
      out(listing.nothing);
      return;
    }
    // The longest a note may measure and still be sent. Each file is estimated at its size bound, no higher than that;
    // a saved file always has its size, and one without is estimated at the limit.
    const limit = env.STT_MAX_SECONDS + VOICE_LENGTH_TOLERANCE_S;
    const estimated = rows.map((r) => ({ ...r, seconds: r.fileSize === null ? limit : Math.min(sizeBoundSeconds(r.fileSize), limit) }));
    // ffmpeg is looked for only when a file would need it: since every file is converted, any file.
    const ffmpeg = estimated.some((r) => !canSendVoice(provider, r.mimeType, false)) ? await hasFfmpeg(deps) : false;
    const send = estimated.filter((r) => canSendVoice(provider, r.mimeType, ffmpeg));
    const needsFfmpeg = estimated.length - send.length;

    const seconds = send.reduce((a, r) => a + r.seconds, 0);
    out(`${listing.count(files(send.length))}${send.length > 0 ? `, about ${minutes(Math.ceil(seconds / 60))}` : ''}.`);
    if (send.length > 0) {
      if (provider === 'local') {
        out(LOCAL_COST);
      } else {
        const about = send.reduce((a, r) => a + voiceCeilingUsd(provider, r.seconds, env.INR_PER_USD), 0);
        const most = send.length * voiceCeilingUsd(provider, limit, env.INR_PER_USD);
        out(
          `Cost: about $${dollarsUp(about)} from the file sizes (speech, ${provider} list price); ` +
            `at most $${dollarsUp(most)} if every file runs to the STT_MAX_SECONDS limit (${env.STT_MAX_SECONDS} seconds).`,
        );
      }
    }
    if (needsFfmpeg > 0) {
      out(`${needsFfmpeg} need${needsFfmpeg === 1 ? 's' : ''} ffmpeg, skipped (install ffmpeg, or set FFMPEG_PATH; after installing ffmpeg, restart the service, then run this again).`);
    }
    const cap = provider === 'local' ? FREE : `This costs money and counts toward the daily spend cap ($${env.DAILY_SPEND_CAP_USD.toFixed(2)}).`;
    if (send.length === 0) {
      out('Nothing was changed.');
      return;
    }
    if (!opts.yes) {
      out(listing.dryRun(cap));
      out(listing.rerun);
      return;
    }
    const queued = await listing.queue(db, send.map((r) => r.id), (deps.clock ?? systemClock).now().toISOString());
    out(listing.queued(queued, cap));
    if (queued < send.length) out(`${send.length - queued} changed since they were counted and were left alone.`);
  } finally {
    if (deps.db === undefined) db.raw.close();
  }
}
