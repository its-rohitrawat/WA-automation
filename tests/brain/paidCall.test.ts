import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { AiInvalidOutputError, AiRefusalError, SDK_MAX_RETRIES } from '../../src/brain/claudeClient.ts';
import { MEDIA_SDK_MAX_RETRIES } from '../../src/brain/mediaClient.ts';
import { SpendCapReachedError, withReservation } from '../../src/brain/paidCall.ts';
import { SpendGuard } from '../../src/spend/spendGuard.ts';
import { manualClock } from '../../src/util/clock.ts';
import { FAKE_USAGE } from '../helpers/ai.ts';
import { seededDb } from '../helpers/db.ts';

function setup(capUsd = 1) {
  const db = seededDb();
  const spend = new SpendGuard({ db, clock: manualClock('2026-10-19T08:00:00Z'), capUsd });
  const rows = () => db.prepare('SELECT usd, detail FROM spend ORDER BY id').all() as { usd: number; detail: string }[];
  return { spend, rows };
}
const ok = (costUsd: number, fallbackUsed = false) => async () => ({ costUsd, fallbackUsed, text: 'x' });
const expectNoReservation = (spend: SpendGuard) => expect(spend.reserve(spend.capUsd - spend.spentToday() - 1e-9)).not.toBeNull();
/** SDK attempts per call of the media client, which media callers pass to withReservation (amendment 9h). */
const MEDIA_ATTEMPTS = MEDIA_SDK_MAX_RETRIES + 1;
const lostConnection = (cause: Error) => new Anthropic.APIConnectionError({ message: 'Connection error.', cause });

describe('withReservation', () => {
  it('books the actual cost of a successful call and marks a fallback', async () => {
    const { spend, rows } = setup();
    expect((await withReservation(spend, 0.1, 'media 7', ok(0.02), MEDIA_ATTEMPTS)).text).toBe('x');
    await withReservation(spend, 0.1, 'media 8', ok(0.03, true), MEDIA_ATTEMPTS);
    expect(rows()).toEqual([{ usd: 0.02, detail: 'media 7' }, { usd: 0.03, detail: 'media 8 (fallback)' }]);
    expectNoReservation(spend);
  });

  it('does not make the call when the estimate does not fit under the cap', async () => {
    const { spend } = setup(0.05);
    const call = vi.fn(ok(0.01));
    await expect(withReservation(spend, 0.1, 'media 7', call, MEDIA_ATTEMPTS)).rejects.toBeInstanceOf(SpendCapReachedError);
    expect(call).not.toHaveBeenCalled();
  });

  it('books what a refusal or an invalid output cost', async () => {
    const { spend, rows } = setup();
    await expect(withReservation(spend, 0.1, 'media 7', async () => { throw new AiRefusalError('cyber', FAKE_USAGE, 0.004); }, MEDIA_ATTEMPTS)).rejects.toBeInstanceOf(AiRefusalError);
    await expect(withReservation(spend, 0.1, 'media 8', async () => { throw new AiInvalidOutputError('no text', FAKE_USAGE, null); }, MEDIA_ATTEMPTS)).rejects.toBeInstanceOf(AiInvalidOutputError);
    expect(rows()).toEqual([{ usd: 0.004, detail: 'media 7 (failed)' }, { usd: 0.1, detail: 'media 8 (failed)' }]);
    expectNoReservation(spend);
  });

  it('books nothing for a server error or a request that never left; the estimate for a lost connection', async () => {
    const { spend, rows } = setup();
    const server = new Anthropic.APIError(500, undefined, 'server error', new Headers());
    await expect(withReservation(spend, 0.1, 'media 7', async () => { throw server; }, MEDIA_ATTEMPTS)).rejects.toBe(server);
    const dns = lostConnection(new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }));
    await expect(withReservation(spend, 0.1, 'media 8', async () => { throw dns; }, MEDIA_ATTEMPTS)).rejects.toBe(dns);
    expect(rows()).toEqual([]);
    await expect(withReservation(spend, 0.1, 'media 9', async () => { throw new Anthropic.APIConnectionTimeoutError(); }, MEDIA_ATTEMPTS)).rejects.toBeInstanceOf(Anthropic.APIConnectionTimeoutError);
    await expect(withReservation(spend, 0.05, 'media 10', async () => { throw new Error('boom'); }, MEDIA_ATTEMPTS)).rejects.toThrow('boom');
    expect(rows()).toEqual([
      { usd: 0.1, detail: 'media 9 (connection lost, estimated)' },
      { usd: 0.05, detail: 'media 10 (unknown, estimated)' },
    ]);
    expectNoReservation(spend);
  });

  it.each(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH'])('books nothing when the request never left (%s)', async (code) => {
    const { spend, rows } = setup();
    const e = lostConnection(new TypeError('fetch failed', { cause: { code } }));
    await expect(withReservation(spend, 0.1, 'media 8', async () => { throw e; }, MEDIA_ATTEMPTS)).rejects.toBe(e);
    expect(rows()).toEqual([]);
    expectNoReservation(spend);
  });

  // The socket error may be wrapped more deeply. Booking a scanned PDF that never left would cost about $4.
  it('finds a never-sent socket code four causes down', async () => {
    const { spend, rows } = setup();
    const e = lostConnection(new TypeError('fetch failed', { cause: new Error('connect', { cause: new Error('socket', { cause: { code: 'ECONNREFUSED' } }) }) }));
    await expect(withReservation(spend, 0.1, 'media 8', async () => { throw e; }, MEDIA_ATTEMPTS)).rejects.toBe(e);
    expect(rows()).toEqual([]);
    expectNoReservation(spend);
  });

  it('books a reset as a lost connection, since the request may have been billed', async () => {
    const { spend, rows } = setup();
    const e = lostConnection(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }));
    await expect(withReservation(spend, 0.1, 'media 13', async () => { throw e; }, MEDIA_ATTEMPTS)).rejects.toBe(e);
    expect(rows()).toEqual([{ usd: 0.1, detail: 'media 13 (connection lost, estimated)' }]);
    expectNoReservation(spend);
  });

  it('books a lost connection once per SDK attempt the caller says its client makes', async () => {
    const { spend, rows } = setup();
    const timeout = new Anthropic.APIConnectionTimeoutError();
    await expect(withReservation(spend, 0.1, 'call 11', async () => { throw timeout; }, SDK_MAX_RETRIES + 1)).rejects.toBe(timeout);
    expect(rows()).toEqual([{ usd: 0.1 * (SDK_MAX_RETRIES + 1), detail: 'call 11 (connection lost, estimated)' }]);
    expectNoReservation(spend);
  });

  // A default would book a one-attempt media call as several attempts (amendment 9h), so a missing count fails tsc.
  it('needs the caller to say how many SDK attempts its client makes', () => {
    const { spend } = setup();
    // @ts-expect-error `attempts` has no default
    const missing = () => withReservation(spend, 0.1, 'media 7', ok(0.02));
    expect(missing).toBeTypeOf('function');
    expect(withReservation.length).toBe(5);
  });

  // A scanned PDF reserves a ceiling of about $4.2 (amendment 9g). One timed-out media call must not pause the day.
  it('keeps room for the reconciler after a timed-out scanned PDF at the ceiling', async () => {
    const { spend } = setup(15);
    await withReservation(spend, 3, 'batch 1', ok(3), MEDIA_ATTEMPTS);
    const ceiling = 4.16;
    expect(spend.canSpend(ceiling)).toBe(true);
    await expect(withReservation(spend, ceiling, 'media 12', async () => { throw new Anthropic.APIConnectionTimeoutError(); }, MEDIA_ATTEMPTS))
      .rejects.toBeInstanceOf(Anthropic.APIConnectionTimeoutError);
    expect(spend.spentToday()).toBeCloseTo(3 + ceiling, 9);
    expect(spend.isPaused()).toBe(false);
    expect(spend.canSpend(0.4)).toBe(true);
  });
});
