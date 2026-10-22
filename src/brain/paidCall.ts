import Anthropic from '@anthropic-ai/sdk';
import type { SpendGuard } from '../spend/spendGuard.ts';
import { AiInvalidOutputError, AiRefusalError, SDK_MAX_RETRIES } from './claudeClient.ts';

/** A paid attempt could not reserve its estimate under the daily cap. */
export class SpendCapReachedError extends Error {
  constructor() {
    super('Daily spend cap reached');
    this.name = 'SpendCapReachedError';
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
 */
export function settleFailedCall(
  spend: SpendGuard,
  rid: number,
  e: unknown,
  estimate: number,
  label: string,
  attempts: number = SDK_MAX_RETRIES + 1,
): void {
  if (e instanceof AiRefusalError || e instanceof AiInvalidOutputError) {
    spend.settle(rid, 'ai', e.costUsd ?? estimate, `${label} (failed)`);
  } else if (e instanceof Anthropic.APIConnectionError) {
    // Checked before APIError, its parent class. A timeout or a reset after sending may have been billed,
    // once per SDK attempt.
    if (neverSent(e)) spend.release(rid);
    else spend.settle(rid, 'ai', estimate * attempts, `${label} (connection lost, estimated)`);
  } else if (e instanceof Anthropic.APIError) {
    spend.release(rid); // the server answered with an error status: not billed
  } else {
    spend.settle(rid, 'ai', estimate, `${label} (unknown, estimated)`);
  }
}

/**
 * Reserves the estimate, makes one paid call, and settles or releases the reservation whatever happens.
 * Throws SpendCapReachedError, without calling, when the estimate does not fit under the daily cap.
 * `attempts`: SDK attempts the call's client makes, as for settleFailedCall. It has no default, so every caller states
 * its client's count and a one-attempt media call is never booked as three: media calls pass
 * `MEDIA_SDK_MAX_RETRIES + 1` (amendment 9h).
 */
export async function withReservation<T extends { costUsd: number; fallbackUsed: boolean }>(
  spend: SpendGuard,
  estimate: number,
  label: string,
  call: () => Promise<T>,
  attempts: number,
): Promise<T> {
  const rid = spend.reserve(estimate);
  if (rid === null) throw new SpendCapReachedError();
  let r: T;
  try {
    r = await call();
  } catch (e) {
    settleFailedCall(spend, rid, e, estimate, label, attempts);
    throw e;
  }
  spend.settle(rid, 'ai', r.costUsd, `${label}${r.fallbackUsed ? ' (fallback)' : ''}`);
  return r;
}
