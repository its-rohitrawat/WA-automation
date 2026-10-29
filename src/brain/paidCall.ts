import Anthropic from '@anthropic-ai/sdk';
import type { SpendGuard } from '../spend/spendGuard.ts';
import { AiInvalidOutputError, AiRefusalError, SDK_MAX_RETRIES } from './claudeClient.ts';

/** A paid attempt could not reserve its estimate under the daily cap. */
export class SpendCapReachedError extends Error {
  /**
   * The estimate would fit if no paid call were in flight (SpendGuard.fitsIgnoringHolds): holds of calls still running,
   * or the guard closed at shutdown, are in the way, not the cap itself, so it clears within minutes (final review FR3c).
   */
  readonly busy: boolean;
  constructor(o: { busy?: boolean } = {}) {
    super('Daily spend cap reached');
    this.name = 'SpendCapReachedError';
    this.busy = o.busy ?? false;
  }
}

/**
 * Socket error codes that mean the request never left this machine, so nothing was billed. The SDK hides undici's
 * connect timeout (UND_ERR_CONNECT_TIMEOUT) unless the client is built with keepConnectTimeoutCode as its fetch.
 */
const NEVER_SENT = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

/** Node's fetch nests the socket error: APIConnectionError -> TypeError('fetch failed') -> { code }. */
export function neverSent(e: Error): boolean {
  let c: unknown = e.cause;
  for (let depth = 0; depth < 4 && typeof c === 'object' && c !== null; depth++) {
    const code = (c as { code?: unknown }).code;
    if (typeof code === 'string' && NEVER_SENT.has(code)) return true;
    c = (c as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Books a paid call that ended in an error. It books what the server billed (refusal, invalid output); an estimate
 * when the outcome is unknown (once per SDK attempt for a lost connection); nothing when it was never billed.
 * `label`: ids only, never content, for example "batch 12" or "media 7".
 * `attempts`: how many SDK attempts the client makes (its maxRetries + 1). The default fits the reconciler's client,
 * built with SDK_MAX_RETRIES.
 * Returns the dollars booked (0 when the reservation was released).
 */
export function settleFailedCall(
  spend: Pick<SpendGuard, 'settle' | 'release'>,
  rid: number,
  e: unknown,
  estimate: number,
  label: string,
  attempts: number = SDK_MAX_RETRIES + 1,
): number {
  const book = (usd: number, detail: string): number => {
    spend.settle(rid, 'ai', usd, detail);
    return usd;
  };
  if (e instanceof AiRefusalError || e instanceof AiInvalidOutputError) {
    return book(e.costUsd ?? estimate, `${label} (failed)`);
  } else if (e instanceof Anthropic.APIConnectionError) {
    // Checked before APIError, its parent class. A timeout or a reset after sending may have been billed,
    // once per SDK attempt.
    if (!neverSent(e)) return book(estimate * attempts, `${label} (connection lost, estimated)`);
    spend.release(rid);
    return 0;
  } else if (e instanceof Anthropic.APIError) {
    spend.release(rid); // the server answered with an error status: not billed
    return 0;
  }
  return book(estimate, `${label} (unknown, estimated)`);
}

/**
 * Reserves the estimate, makes one paid call, and settles or releases the reservation whatever happens.
 * Throws SpendCapReachedError, without calling, when the estimate does not fit under the daily cap; `busy` says whether
 * only holds of other calls in flight are in the way.
 * `attempts`: SDK attempts the call's client makes, as for settleFailedCall. It has no default, so every caller states
 * its client's count and a one-attempt media call is never booked as three: media calls pass
 * `MEDIA_SDK_MAX_RETRIES + 1` (amendment 9h).
 * `onFailureBooked`: told what a failed call booked (settleFailedCall's amount) before the error is thrown again.
 */
export async function withReservation<T extends { costUsd: number; fallbackUsed: boolean }>(
  spend: Pick<SpendGuard, 'reserve' | 'settle' | 'release' | 'fitsIgnoringHolds'>,
  estimate: number,
  label: string,
  call: () => Promise<T>,
  attempts: number,
  onFailureBooked: (usd: number) => void = () => {},
): Promise<T> {
  const rid = spend.reserve(estimate);
  if (rid === null) throw new SpendCapReachedError({ busy: spend.fitsIgnoringHolds(estimate) });
  let r: T;
  try {
    r = await call();
  } catch (e) {
    const booked = settleFailedCall(spend, rid, e, estimate, label, attempts);
    onFailureBooked(booked);
    throw e;
  }
  spend.settle(rid, 'ai', r.costUsd, `${label}${r.fallbackUsed ? ' (fallback)' : ''}`);
  return r;
}
