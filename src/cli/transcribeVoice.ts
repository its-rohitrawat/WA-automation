import type { Env } from '../config/env.ts';
import { trackerDbPath } from '../config/paths.ts';
import { getClientByCode } from '../store/clients.ts';
import { openDb, type Db } from '../store/db.ts';
import { queueVoiceBacklog, voiceBacklog } from '../store/media.ts';
import { findFfmpeg } from '../stt/audio.ts';
import { canSendVoice, sizeBoundSeconds, voiceCeilingUsd } from '../stt/voice.ts';
import { systemClock, type Clock } from '../util/clock.ts';
import { CorrectionError } from './corrections.ts';

/*
 * `cli transcribe-voice` (Phase 2b Task 8, V6, N2, N4): the voice notes and audio files saved before Phase 2b, still
 * without a transcript. Without --yes it only counts them and prints the minutes and the cost ceiling; with --yes it
 * queues them, and the running service transcribes them (each counts toward the daily spend cap).
 * - No key, no provider and no network: the rules and prices come from src/stt/voice.ts (canSendVoice,
 *   sizeBoundSeconds, voiceCeilingUsd). STT_API_KEY is never read here.
 * - A file whose size allows more than STT_MAX_SECONDS is too long and never queued (N4), as the extractor would refuse
 *   it. A file the transcriber could not send (it needs ffmpeg, which is missing, N2) is never queued either, so it does
 *   not finish format_not_supported again; it stays listed, and running this again once ffmpeg is there picks it up.
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
}

const NOT_SET_UP = 'Speech-to-text is not set up (STT_PROVIDER is none). Nothing changed.';
const NOTHING = 'No saved voice notes or audio files are waiting for a transcript. Nothing changed.';

const files = (n: number) => `${n} voice note${n === 1 ? '' : 's'} or audio file${n === 1 ? '' : 's'}`;
const minutes = (n: number) => `${n} minute${n === 1 ? '' : 's'}`;
/** A ceiling is rounded up to the cent, so a few seconds never print as $0.00. */
const dollarsUp = (usd: number) => (Math.ceil(usd * 100 - 1e-9) / 100).toFixed(2);

async function hasFfmpeg(deps: TranscribeVoiceDeps): Promise<boolean> {
  try {
    return (await (deps.findFfmpeg ?? findFfmpeg)(deps.env.FFMPEG_PATH)) !== null;
  } catch {
    return false;
  }
}

/** `cli transcribe-voice [--client CODE] [--yes]`. */
export async function transcribeVoiceCommand(opts: { client?: string; yes: boolean }, deps: TranscribeVoiceDeps): Promise<void> {
  const { env, out } = deps;
  const provider = env.STT_PROVIDER;
  if (provider === 'none') {
    out(NOT_SET_UP);
    return;
  }
  const db = deps.db ?? openDb(trackerDbPath(env.DATA_DIR));
  try {
    let clientId: number | undefined;
    if (opts.client !== undefined) {
      const code = opts.client.trim().toUpperCase();
      const c = getClientByCode(db, code);
      if (!c) throw new CorrectionError(`No client with code ${opts.client}`);
      if (!c.active) throw new CorrectionError(`Client ${c.code} is not in the allow-list`);
      clientId = c.id;
    }
    const rows = voiceBacklog(db, clientId === undefined ? {} : { clientId });
    if (rows.length === 0) {
      out(NOTHING);
      return;
    }
    // A saved file always has its size; one without is counted as too long, since nothing shows it fits.
    const bounded = rows.map((r) => ({ ...r, seconds: r.fileSize === null ? Infinity : sizeBoundSeconds(r.fileSize) }));
    const fits = bounded.filter((r) => r.seconds <= env.STT_MAX_SECONDS);
    const tooLong = bounded.length - fits.length;
    // ffmpeg is looked for only when a file cannot go as it is.
    const ffmpeg = fits.some((r) => !canSendVoice(provider, r.mimeType, false)) ? await hasFfmpeg(deps) : false;
    const send = fits.filter((r) => canSendVoice(provider, r.mimeType, ffmpeg));
    const needsFfmpeg = fits.length - send.length;

    const seconds = send.reduce((a, r) => a + r.seconds, 0);
    const ceiling = send.reduce((a, r) => a + voiceCeilingUsd(provider, r.seconds, env.INR_PER_USD), 0);
    out(`To transcribe: ${files(send.length)} saved before Phase 2b${send.length > 0 ? `, ${minutes(Math.ceil(seconds / 60))} at most` : ''}.`);
    if (send.length > 0) out(`Cost ceiling: up to $${dollarsUp(ceiling)} (speech, ${provider} list price).`);
    if (tooLong > 0) out(`${tooLong} too long, skipped (by file size, over STT_MAX_SECONDS: ${env.STT_MAX_SECONDS} seconds).`);
    if (needsFfmpeg > 0) {
      out(`${needsFfmpeg} need${needsFfmpeg === 1 ? 's' : ''} ffmpeg, skipped (install ffmpeg, or set FFMPEG_PATH, then run this again).`);
    }
    const cap = `This costs money and counts toward the daily spend cap ($${env.DAILY_SPEND_CAP_USD.toFixed(2)}).`;
    if (send.length === 0) {
      out('Nothing was changed.');
      return;
    }
    if (!opts.yes) {
      out(`With --yes the running service transcribes them, for the record. ${cap}`);
      out('Nothing was changed. Re-run with --yes to queue them.');
      return;
    }
    const queued = queueVoiceBacklog(db, send.map((r) => r.id), (deps.clock ?? systemClock).now().toISOString());
    out(`${queued} queued. The running service now transcribes them, for the record. ${cap}`);
    if (queued < send.length) out(`${send.length - queued} changed since they were counted and were left alone.`);
  } finally {
    if (deps.db === undefined) db.close();
  }
}
