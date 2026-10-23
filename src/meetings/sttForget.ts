import type { Db } from '../store/db.ts';
import { countSttForgetAttempt, deleteSttForget, pendingSttForgets } from '../store/meetings.ts';
import { SttHttpError } from '../stt/http.ts';
import { systemClock, type Clock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';
import { errorCode } from './sttParts.ts';
import type { MeetingTranscriber } from './transcribe.ts';

// Deleting the providers' own copies of speech answers (M7). A copy's id is noted in stt_forget in the same write that
// stores the finished part, and the row is removed only once the provider has deleted the copy.

/** Tries per stt_forget row; then it is left, logged, for a person to look at. */
export const MAX_FORGET_ATTEMPTS = 5;
/** The wait before try n + 1 after try n started (15 minutes, 1 hour, 6 hours, then 24 hours), so restarts do not use up the tries. */
export const FORGET_WAITS_MS = [15 * 60_000, 60 * 60_000, 6 * 3_600_000, 24 * 3_600_000] as const;

/**
 * Deletes the provider copies noted in stt_forget that are due, each through its own row's provider: a row whose provider
 * is not the one set up now (or keeps no copies) is skipped and logged with the code provider_unavailable, without
 * counting a try. Each try is counted, with the time of the next one, before the provider is asked; a row is removed
 * once the provider has deleted the copy (a 404: it is already gone). After MAX_FORGET_ATTEMPTS tries a row is left
 * alone. Run right after a meeting's transcript is stored (o.meetingId: that meeting only) and at processor start after
 * recoverInflightParts (all). Logs the meeting id, provider and a code only. Returns how many were deleted.
 */
export async function forgetPending(
  db: Db,
  transcriber: MeetingTranscriber | null,
  log: Logger,
  o: { meetingId?: number; clock?: Clock } = {},
): Promise<number> {
  const clock = o.clock ?? systemClock;
  const rows = pendingSttForgets(db, {
    nowIso: clock.now().toISOString(),
    maxAttempts: MAX_FORGET_ATTEMPTS,
    ...(o.meetingId !== undefined ? { meetingId: o.meetingId } : {}),
  });
  let deleted = 0;
  for (const f of rows) {
    if (transcriber === null || transcriber.provider !== f.provider || !transcriber.canForget) {
      log.warn({ meetingId: f.meetingId, provider: f.provider, code: 'provider_unavailable' }, 'meeting speech copy left for later: its provider is not set up now');
      continue;
    }
    const attempts = f.attempts + 1;
    const wait = FORGET_WAITS_MS[Math.min(attempts, FORGET_WAITS_MS.length) - 1]!;
    countSttForgetAttempt(db, f.id, new Date(clock.now().getTime() + wait).toISOString());
    try {
      await transcriber.forget(f.ref);
    } catch (e) {
      if (!(e instanceof SttHttpError && e.status === 404)) {
        const fields = { meetingId: f.meetingId, provider: f.provider, code: errorCode(e), attempts };
        if (attempts >= MAX_FORGET_ATTEMPTS) log.warn(fields, 'meeting speech copy could not be deleted at the provider; no more tries');
        else log.warn(fields, 'meeting speech copy could not be deleted at the provider; tried again later');
        continue;
      }
    }
    deleteSttForget(db, f.id);
    deleted++;
  }
  return deleted;
}
