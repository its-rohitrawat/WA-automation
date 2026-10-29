import { SpendCapReachedError } from '../brain/paidCall.ts';
import type { SpendGuard } from '../spend/spendGuard.ts';
import type { Sql } from '../store/db.ts';
import { SttHttpError, SttJobError } from './http.ts';

/**
 * The booking of a failed paid speech call could not be written (the spend row or the owner's record of it). `cause` is
 * the call's own error, so a caller can still map it (a refused key stays a refused key); `writeError` is what the
 * write threw. The owner's durable record still says "sent, nothing booked", which is how the call gets booked later.
 */
export class SttBookingError extends Error {
  readonly writeError: unknown;
  constructor(writeError: unknown, callError: unknown) {
    super('The booking of a paid speech call could not be written', { cause: callError });
    this.name = 'SttBookingError';
    this.writeError = writeError;
  }
}

/** What a paid speech call booked: its reported cost, the ceiling (the outcome is unknown or failed), or nothing. */
export type SttBooking = { outcome: 'actual' | 'ceiling'; usd: number } | { outcome: 'none'; usd: 0 };

export interface SttHoldHooks<T> {
  /**
   * Told what was booked, with the result on success, inside the same `atomically` step as the booking: the owner writes
   * its own record of the call there (a meeting part's state), so the booking and that record are kept or lost together.
   * If it throws, the step is undone (with `atomically`) and the error thrown on.
   */
  onBooked?: (b: SttBooking, result: T | undefined, q: Sql | undefined) => void | Promise<void>;
  /**
   * Runs the booking and onBooked as one step, for example a database transaction, whose handle onBooked gets as q. By
   * default they just run, with no handle.
   */
  atomically?: (fn: (q?: Sql) => Promise<void>) => Promise<void>;
  /**
   * Called inside settlePending's booking of the hold at shutdown, while the call is still running (see SpendGuard.reserve).
   * The call's own settle then books nothing more.
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
 * Errors from the call are thrown again after booking. If the booking step itself throws (the spend write or onBooked
 * failed), the hold is gone and nothing may be booked: that error is thrown (after a failed call, as an SttBookingError
 * whose cause is the call's error), and the owner's durable record, which still
 * says the call was sent with nothing booked, is what books it later (a meeting part left inflight). `label`: ids only,
 * for example "meeting 12 part 2". Phase 2b's withSttReservation(spend, transcriber, maxSeconds, label, call) is this
 * with the ceiling computed from maxSeconds.
 */
export async function withSttHold<T>(
  spend: SpendGuard,
  ceilingUsd: number,
  label: string,
  call: () => Promise<{ result: T; costUsd: number }>,
  hooks: SttHoldHooks<T> = {},
): Promise<{ result: T; costUsd: number }> {
  const rid = spend.reserve(ceilingUsd, 'stt', hooks.onBookedAtShutdown);
  if (rid === null) throw new SpendCapReachedError({ busy: spend.fitsIgnoringHolds(ceilingUsd) });
  const atomically = hooks.atomically ?? ((fn: (q?: Sql) => Promise<void>) => fn());
  let r: { result: T; costUsd: number };
  try {
    r = await call();
  } catch (e) {
    try {
      // Booked as its own statement: inside `hooks.onBooked?.(…)` the booking would be skipped when there is no hook.
      await atomically(async (q) => {
        const booked = settleFailedSttCall(spend, rid, e, ceilingUsd, label);
        await hooks.onBooked?.(booked, undefined, q);
      });
    } catch (writeErr) {
      throw new SttBookingError(writeErr, e);
    }
    throw e;
  }
  const done = r;
  await atomically(async (q) => {
    spend.settle(rid, 'stt', done.costUsd, label);
    await hooks.onBooked?.({ outcome: 'actual', usd: done.costUsd }, done.result, q);
  });
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
