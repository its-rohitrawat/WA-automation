import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiInvalidOutputError, AiRefusalError, ClaudeClient, SDK_MAX_RETRIES } from '../../src/brain/claudeClient.ts';
import { ClaudeMediaClient, MEDIA_SDK_MAX_RETRIES } from '../../src/brain/mediaClient.ts';
import { SpendCapReachedError, withReservation } from '../../src/brain/paidCall.ts';
import { scannedPdfCeilingUsd } from '../../src/media/extract.ts';
import type { Prices } from '../../src/spend/pricing.ts';
import { SpendGuard } from '../../src/spend/spendGuard.ts';
import { manualClock } from '../../src/util/clock.ts';
import { FAKE_USAGE } from '../helpers/ai.ts';
import { seededDb } from '../helpers/db.ts';

async function setup(capUsd = 1) {
  const db = await seededDb();
  const spend = new SpendGuard({ db, clock: manualClock('2026-10-19T08:00:00Z'), capUsd });
  const rows = () => db.raw.prepare('SELECT usd, detail FROM spend ORDER BY id').all() as { usd: number; detail: string }[];
  return { spend, rows };
}
const ok = (costUsd: number, fallbackUsed = false) => async () => ({ costUsd, fallbackUsed, text: 'x' });
const expectNoReservation = (spend: SpendGuard) => expect(spend.reserve(spend.capUsd - spend.spentToday() - 1e-9)).not.toBeNull();
/** SDK attempts per call of the media client, which media callers pass to withReservation (amendment 9h). */
const MEDIA_ATTEMPTS = MEDIA_SDK_MAX_RETRIES + 1;
const lostConnection = (cause: Error) => new Anthropic.APIConnectionError({ message: 'Connection error.', cause });

describe('withReservation', () => {
  it('books the actual cost of a successful call and marks a fallback', async () => {
    const { spend, rows } = await setup();
    expect((await withReservation(spend, 0.1, 'media 7', ok(0.02), MEDIA_ATTEMPTS)).text).toBe('x');
    await withReservation(spend, 0.1, 'media 8', ok(0.03, true), MEDIA_ATTEMPTS);
    await spend.flushed();
    expect(rows()).toEqual([{ usd: 0.02, detail: 'media 7' }, { usd: 0.03, detail: 'media 8 (fallback)' }]);
    expectNoReservation(spend);
  });

  it('does not make the call when the estimate does not fit under the cap', async () => {
    const { spend } = await setup(0.05);
    const call = vi.fn(ok(0.01));
    await expect(withReservation(spend, 0.1, 'media 7', call, MEDIA_ATTEMPTS)).rejects.toBeInstanceOf(SpendCapReachedError);
    expect(call).not.toHaveBeenCalled();
  });

  // Final review FR3c: the media processor defers such a file as spend_busy, not spend_cap.
  it('says whether only holds of calls in flight, not the cap itself, kept the call from its budget', async () => {
    const { spend } = await setup(1);
    const call = vi.fn(ok(0.01));
    const hold = spend.reserve(0.5)!;
    const busy = (await withReservation(spend, 0.6, 'media 7', call, MEDIA_ATTEMPTS).catch((e: unknown) => e)) as SpendCapReachedError;
    expect(busy).toBeInstanceOf(SpendCapReachedError);
    expect(busy.busy).toBe(true);
    spend.settle(hold, 'ai', 0.5, 'media 6');
    const capped = (await withReservation(spend, 0.6, 'media 7', call, MEDIA_ATTEMPTS).catch((e: unknown) => e)) as SpendCapReachedError;
    expect(capped).toBeInstanceOf(SpendCapReachedError);
    expect(capped.busy).toBe(false);
    expect(call).not.toHaveBeenCalled();
    expect(new SpendCapReachedError().busy).toBe(false);
  });

  it('books what a refusal or an invalid output cost', async () => {
    const { spend, rows } = await setup();
    await expect(withReservation(spend, 0.1, 'media 7', async () => { throw new AiRefusalError('cyber', FAKE_USAGE, 0.004); }, MEDIA_ATTEMPTS)).rejects.toBeInstanceOf(AiRefusalError);
    await expect(withReservation(spend, 0.1, 'media 8', async () => { throw new AiInvalidOutputError('no text', FAKE_USAGE, null); }, MEDIA_ATTEMPTS)).rejects.toBeInstanceOf(AiInvalidOutputError);
    expect(rows()).toEqual([{ usd: 0.004, detail: 'media 7 (failed)' }, { usd: 0.1, detail: 'media 8 (failed)' }]);
    expectNoReservation(spend);
  });

  it('books nothing for a server error or a request that never left; the estimate for a lost connection', async () => {
    const { spend, rows } = await setup();
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

  it.each(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT'])('books nothing when the request never left (%s)', async (code) => {
    const { spend, rows } = await setup();
    const e = lostConnection(new TypeError('fetch failed', { cause: { code } }));
    await expect(withReservation(spend, 0.1, 'media 8', async () => { throw e; }, MEDIA_ATTEMPTS)).rejects.toBe(e);
    expect(rows()).toEqual([]);
    expectNoReservation(spend);
  });

  // The socket error may be wrapped more deeply. Booking a scanned PDF that never left would cost about $4.
  it('finds a never-sent socket code four causes down', async () => {
    const { spend, rows } = await setup();
    const e = lostConnection(new TypeError('fetch failed', { cause: new Error('connect', { cause: new Error('socket', { cause: { code: 'ECONNREFUSED' } }) }) }));
    await expect(withReservation(spend, 0.1, 'media 8', async () => { throw e; }, MEDIA_ATTEMPTS)).rejects.toBe(e);
    expect(rows()).toEqual([]);
    expectNoReservation(spend);
  });

  it('books a reset as a lost connection, since the request may have been billed', async () => {
    const { spend, rows } = await setup();
    const e = lostConnection(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }));
    await expect(withReservation(spend, 0.1, 'media 13', async () => { throw e; }, MEDIA_ATTEMPTS)).rejects.toBe(e);
    expect(rows()).toEqual([{ usd: 0.1, detail: 'media 13 (connection lost, estimated)' }]);
    expectNoReservation(spend);
  });

  it('books a lost connection once per SDK attempt the caller says its client makes', async () => {
    const { spend, rows } = await setup();
    const timeout = new Anthropic.APIConnectionTimeoutError();
    await expect(withReservation(spend, 0.1, 'call 11', async () => { throw timeout; }, SDK_MAX_RETRIES + 1)).rejects.toBe(timeout);
    expect(rows()).toEqual([{ usd: 0.1 * (SDK_MAX_RETRIES + 1), detail: 'call 11 (connection lost, estimated)' }]);
    expectNoReservation(spend);
  });

  // A default would book a one-attempt media call as several attempts (amendment 9h), so a missing count fails tsc.
  it('needs the caller to say how many SDK attempts its client makes', async () => {
    const { spend } = await setup();
    // @ts-expect-error `attempts` has no default
    const missing = () => withReservation(spend, 0.1, 'media 7', ok(0.02));
    // That check runs under `npm run typecheck`. At run time a default would stop Function.length counting at it.
    void missing;
    expect(withReservation.length).toBe(5);
  });

  // A scanned PDF reserves a ceiling of about $4.2 (amendment 9g). One timed-out media call must not pause the day.
  it('keeps room for the reconciler after a timed-out scanned PDF at the ceiling', async () => {
    const { spend } = await setup(15);
    await withReservation(spend, 3, 'batch 1', ok(3), MEDIA_ATTEMPTS);
    const ceiling = scannedPdfCeilingUsd(prices);
    expect(ceiling).toBeCloseTo(4.16, 1);
    expect(spend.canSpend(ceiling)).toBe(true);
    await expect(withReservation(spend, ceiling, 'media 12', async () => { throw new Anthropic.APIConnectionTimeoutError(); }, MEDIA_ATTEMPTS))
      .rejects.toBeInstanceOf(Anthropic.APIConnectionTimeoutError);
    expect(spend.spentToday()).toBeCloseTo(3 + ceiling, 9);
    expect(spend.isPaused()).toBe(false);
    expect(spend.canSpend(0.4)).toBe(true);
  });

  it('tells the caller what a failed call booked, and nothing on success', async () => {
    const { spend, rows } = await setup(5);
    const booked: number[] = [];
    const fail = (e: Error) => withReservation(spend, 0.1, 'meeting 1', async () => { throw e; }, 1, (usd) => booked.push(usd)).catch(() => null);
    await fail(new AiRefusalError('cyber', FAKE_USAGE, 0.004));
    await fail(new AiInvalidOutputError('no text', FAKE_USAGE, null));
    await fail(new Anthropic.APIError(500, undefined, 'server error', new Headers()));
    await fail(lostConnection(new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })));
    await fail(new Anthropic.APIConnectionTimeoutError());
    await withReservation(spend, 0.1, 'meeting 2', ok(0.02), 1, (usd) => booked.push(usd));
    expect(booked).toEqual([0.004, 0.1, 0, 0, 0.1]);
    await spend.flushed();
    expect(rows().map((r) => r.usd)).toEqual([0.004, 0.1, 0.1, 0.02]);
  });
});

/** What Node's fetch throws when undici's connect timer fires: the request never left this machine. */
const connectTimeout = () => new TypeError('fetch failed', {
  cause: Object.assign(new Error('Connect Timeout Error (attempted address: api.anthropic.com:443, timeout: 10000ms)'), {
    name: 'ConnectTimeoutError', code: 'UND_ERR_CONNECT_TIMEOUT',
  }),
});
const prices: Prices = { inputPerMTok: 4, outputPerMTok: 20, cacheWritePerMTok: 5, cacheReadPerMTok: 0.2 };

// The SDK reports undici's connect timeout as a timeout with no cause, which would be booked at the estimate. The
// clients' own fetch keeps the code, so a scanned PDF that never left is not booked at its ceiling of about $4.2.
// These tests run the real SDK against a stubbed global fetch; nothing reaches the network.
describe('a connection that timed out before the request was sent', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('books nothing for the media client', async () => {
    const { spend, rows } = await setup(15);
    const fetch = vi.fn(async () => { throw connectTimeout(); });
    vi.stubGlobal('fetch', fetch);
    const media = new ClaudeMediaClient({ apiKey: 'test-only', model: 'claude-opus-5-5', prices });
    const err = await withReservation(spend, 4.2, 'media 12', () => media.readScannedPdf(Buffer.from('%PDF')), MEDIA_ATTEMPTS)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Anthropic.APIConnectionError);
    expect(err).not.toBeInstanceOf(Anthropic.APIConnectionTimeoutError);
    expect(fetch).toHaveBeenCalledTimes(MEDIA_ATTEMPTS);
    expect(rows()).toEqual([]);
    expectNoReservation(spend);
  });

  it('books nothing for the reconciler client, after its SDK retries', async () => {
    const { spend, rows } = await setup();
    const fetch = vi.fn(async () => { throw connectTimeout(); });
    vi.stubGlobal('fetch', fetch);
    const ai = new ClaudeClient({ apiKey: 'test-only', model: 'claude-opus-5-5', prices });
    const err = await withReservation(spend, 0.1, 'batch 1', () => ai.reconcile('system', 'user'), SDK_MAX_RETRIES + 1)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Anthropic.APIConnectionError);
    expect(err).not.toBeInstanceOf(Anthropic.APIConnectionTimeoutError);
    expect(fetch).toHaveBeenCalledTimes(SDK_MAX_RETRIES + 1);
    expect(rows()).toEqual([]);
    expectNoReservation(spend);
  });

  // A timeout after the request was sent (the SDK aborts it) may have been billed, so it still books the estimate.
  it('still books the estimate for a request that timed out after it was sent', async () => {
    const { spend, rows } = await setup(15);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('This operation was aborted', 'AbortError'); }));
    const media = new ClaudeMediaClient({ apiKey: 'test-only', model: 'claude-opus-5-5', prices });
    const err = await withReservation(spend, 4.2, 'media 13', () => media.readScannedPdf(Buffer.from('%PDF')), MEDIA_ATTEMPTS)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Anthropic.APIConnectionTimeoutError);
    expect(rows()).toEqual([{ usd: 4.2, detail: 'media 13 (connection lost, estimated)' }]);
    expectNoReservation(spend);
  });
});
