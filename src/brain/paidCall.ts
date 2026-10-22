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

/** Socket error codes that mean the request never left this machine, so nothing was billed. */
const NEVER_SENT = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH']);

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
 */
export function settleFailedCall(spend: SpendGuard, rid: number, e: unknown, estimate: number, label: string): void {
  if (e instanceof AiRefusalError || e instanceof AiInvalidOutputError) {
    spend.settle(rid, 'ai', e.costUsd ?? estimate, `${label} (failed)`);
  } else if (e instanceof Anthropic.APIConnectionError) {
    // Checked before APIError, its parent class. A timeout or a reset after sending may have been billed,
    // once per SDK attempt.
    if (neverSent(e)) spend.release(rid);
    else spend.settle(rid, 'ai', estimate * (SDK_MAX_RETRIES + 1), `${label} (connection lost, estimated)`);
  } else if (e instanceof Anthropic.APIError) {
    spend.release(rid); // the server answered with an error status: not billed
  } else {
    spend.settle(rid, 'ai', estimate, `${label} (unknown, estimated)`);
  }
}

/**
 * Reserves the estimate, makes one paid call, and settles or releases the reservation whatever happens.
 * Throws SpendCapReachedError, without calling, when the estimate does not fit under the daily cap.
 */
export async function withReservation<T extends { costUsd: number; fallbackUsed: boolean }>(
  spend: SpendGuard,
  estimate: number,
  label: string,
  call: () => Promise<T>,
): Promise<T> {
  const rid = spend.reserve(estimate);
  if (rid === null) throw new SpendCapReachedError();
  let r: T;
  try {
    r = await call();
  } catch (e) {
    settleFailedCall(spend, rid, e, estimate, label);
    throw e;
  }
  spend.settle(rid, 'ai', r.costUsd, `${label}${r.fallbackUsed ? ' (fallback)' : ''}`);
  return r;
}
