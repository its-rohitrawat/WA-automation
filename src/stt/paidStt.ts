import { SpendCapReachedError } from '../brain/paidCall.ts';
import type { SpendGuard } from '../spend/spendGuard.ts';
import { SttHttpError, SttJobError } from './http.ts';

/** What a paid speech call booked: its reported cost, the ceiling (the outcome is unknown or failed), or nothing. */
export type SttBooking = { outcome: 'actual' | 'ceiling'; usd: number } | { outcome: 'none'; usd: 0 };

export interface SttHoldHooks {
  /** Told what was booked, synchronously, right after booking and before the result is returned or the error rethrown. */
  onBooked?: (b: SttBooking) => void;
  /**
   * Told when settlePending booked the hold at shutdown while the call was still running. The call's own settle then
   * books nothing more. Must not throw.
   */
  onBookedAtShutdown?: () => void;
}

/**
 * Holds the ceiling as 'stt' spend, makes one paid speech call and books it whatever happens:
 * - no room under the daily cap: SpendCapReachedError without calling (`busy`: only holds of calls in flight are in the
 *   way, see SpendGuard.fitsIgnoringHolds);
 * - success: the cost the call reports;
 * - SttHttpError (the provider answered with an error status: refused or failed, not billed): nothing, the hold is freed;
 * - SttNoAnswerError / SttJobLostError (sent, no usable answer: may be billed): the ceiling, "<label> (unknown, estimated)";
 * - SttJobError (the job failed; provider docs do not promise that failed jobs are free): the ceiling,
 *   "<label> (job failed, estimated)";
 * - anything else: the ceiling, "(unknown, estimated)", the safe side.
 * Errors are thrown again after booking. `label`: ids only, for example "meeting 12 part 2".
 * Phase 2b's withSttReservation(spend, transcriber, maxSeconds, label, call) is this with the ceiling computed from
 * maxSeconds.
 */
export async function withSttHold<T>(
  spend: SpendGuard,
  ceilingUsd: number,
  label: string,
  call: () => Promise<{ result: T; costUsd: number }>,
  hooks: SttHoldHooks = {},
): Promise<{ result: T; costUsd: number }> {
  const rid = spend.reserve(ceilingUsd, 'stt', hooks.onBookedAtShutdown);
  if (rid === null) throw new SpendCapReachedError({ busy: spend.fitsIgnoringHolds(ceilingUsd) });
  let r: { result: T; costUsd: number };
  try {
    r = await call();
  } catch (e) {
    hooks.onBooked?.(settleFailedSttCall(spend, rid, e, ceilingUsd, label));
    throw e;
  }
  spend.settle(rid, 'stt', r.costUsd, label);
  hooks.onBooked?.({ outcome: 'actual', usd: r.costUsd });
  return r;
}

/** Books a speech call that ended in an error, as withSttHold describes, and returns what was booked. */
export function settleFailedSttCall(spend: SpendGuard, rid: number, e: unknown, ceilingUsd: number, label: string): SttBooking {
  if (e instanceof SttHttpError) {
    spend.release(rid);
    return { outcome: 'none', usd: 0 };
  }
  // SttNoAnswerError and its SttJobLostError, and anything not known: may have been billed.
  const note = e instanceof SttJobError ? 'job failed, estimated' : 'unknown, estimated';
  spend.settle(rid, 'stt', ceilingUsd, `${label} (${note})`);
  return { outcome: 'ceiling', usd: ceilingUsd };
}
