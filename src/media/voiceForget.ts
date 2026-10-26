import { FORGET_WAITS_MS, MAX_FORGET_ATTEMPTS } from '../meetings/sttForget.ts';
import { errorCode } from '../meetings/sttParts.ts';
import type { Db } from '../store/db.ts';
import { countMediaForgetAttempt, deleteMediaForget, pendingMediaForgets } from '../store/media.ts';
import { SttHttpError } from '../stt/http.ts';
import type { VoiceTranscriber } from '../stt/voice.ts';
import { systemClock, type Clock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';

// Deleting the speech provider's own copies of voice-note transcripts (N1), the voice-note twin of forgetPending in
// src/meetings/sttForget.ts, with the same waits and the same limit. A copy's id is noted in media_stt_forget by
// finishMedia in the same write that stores the transcript (or by the processor, for an unreadable answer that still
// named its copy), and the row is removed only once the provider has deleted the copy.

/**
 * Deletes the voice-note copies noted in media_stt_forget that are due, each through the transcriber set up now: a row
 * whose provider is not that one (or keeps no copies), or every row when `voice` is null, is skipped and logged with the
 * code provider_unavailable, without counting a try. Each try is counted, with the time of the next one from
 * FORGET_WAITS_MS, before the provider is asked; a row is removed once the provider has deleted the copy (a 404: it is
 * already gone). After MAX_FORGET_ATTEMPTS tries a row is left alone. Run for one file (o.mediaId) after its
 * transcript is stored (the processor's afterFinish) and by the processor itself once it has noted a copy (Task 6
 * review round 1, fix 5); and for all rows at service start and hourly (the sweep, Task 10). Logs the media id,
 * provider, a code and, for a failed try, which try it was (attempts), never the copy's id. Returns how many were
 * deleted.
 */
export async function forgetVoiceCopies(
  db: Db,
  voice: VoiceTranscriber | null,
  log: Logger,
  o: { mediaId?: number; clock?: Clock } = {},
): Promise<number> {
  const clock = o.clock ?? systemClock;
  const rows = pendingMediaForgets(db, {
    nowIso: clock.now().toISOString(),
    maxAttempts: MAX_FORGET_ATTEMPTS,
    ...(o.mediaId !== undefined ? { mediaId: o.mediaId } : {}),
  });
  let deleted = 0;
  for (const f of rows) {
    if (voice === null || voice.provider !== f.provider || !voice.canForget) {
      log.warn({ mediaId: f.mediaId, provider: f.provider, code: 'provider_unavailable' }, 'voice note speech copy left for later: its provider is not set up now');
      continue;
    }
    const attempts = f.attempts + 1;
    const wait = FORGET_WAITS_MS[Math.min(attempts, FORGET_WAITS_MS.length) - 1]!;
    countMediaForgetAttempt(db, f.id, new Date(clock.now().getTime() + wait).toISOString());
    try {
      await voice.forget(f.ref);
    } catch (e) {
      if (!(e instanceof SttHttpError && e.status === 404)) {
        const fields = { mediaId: f.mediaId, provider: f.provider, code: errorCode(e), attempts };
        if (attempts >= MAX_FORGET_ATTEMPTS) log.warn(fields, 'voice note speech copy could not be deleted at the provider; no more tries');
        else log.warn(fields, 'voice note speech copy could not be deleted at the provider; tried again later');
        continue;
      }
    }
    deleteMediaForget(db, f.id);
    deleted++;
  }
  return deleted;
}
