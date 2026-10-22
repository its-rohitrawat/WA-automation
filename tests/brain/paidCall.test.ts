import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { AiInvalidOutputError, AiRefusalError, SDK_MAX_RETRIES } from '../../src/brain/claudeClient.ts';
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

describe('withReservation', () => {
  it('books the actual cost of a successful call and marks a fallback', async () => {
    const { spend, rows } = setup();
    expect((await withReservation(spend, 0.1, 'media 7', ok(0.02))).text).toBe('x');
    await withReservation(spend, 0.1, 'media 8', ok(0.03, true));
    expect(rows()).toEqual([{ usd: 0.02, detail: 'media 7' }, { usd: 0.03, detail: 'media 8 (fallback)' }]);
    expectNoReservation(spend);
  });

  it('does not make the call when the estimate does not fit under the cap', async () => {
    const { spend } = setup(0.05);
    const call = vi.fn(ok(0.01));
    await expect(withReservation(spend, 0.1, 'media 7', call)).rejects.toBeInstanceOf(SpendCapReachedError);
    expect(call).not.toHaveBeenCalled();
  });

  it('books what a refusal or an invalid output cost', async () => {
    const { spend, rows } = setup();
    await expect(withReservation(spend, 0.1, 'media 7', async () => { throw new AiRefusalError('cyber', FAKE_USAGE, 0.004); })).rejects.toBeInstanceOf(AiRefusalError);
    await expect(withReservation(spend, 0.1, 'media 8', async () => { throw new AiInvalidOutputError('no text', FAKE_USAGE, null); })).rejects.toBeInstanceOf(AiInvalidOutputError);
    expect(rows()).toEqual([{ usd: 0.004, detail: 'media 7 (failed)' }, { usd: 0.1, detail: 'media 8 (failed)' }]);
    expectNoReservation(spend);
  });

  it('books nothing for a server error or a request that never left; every attempt for a lost connection', async () => {
    const { spend, rows } = setup();
    const server = new Anthropic.APIError(500, undefined, 'server error', new Headers());
    await expect(withReservation(spend, 0.1, 'media 7', async () => { throw server; })).rejects.toBe(server);
    const dns = new Anthropic.APIConnectionError({ message: 'Connection error.', cause: new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }) });
    await expect(withReservation(spend, 0.1, 'media 8', async () => { throw dns; })).rejects.toBe(dns);
    expect(rows()).toEqual([]);
    await expect(withReservation(spend, 0.1, 'media 9', async () => { throw new Anthropic.APIConnectionTimeoutError(); })).rejects.toBeInstanceOf(Anthropic.APIConnectionTimeoutError);
    await expect(withReservation(spend, 0.05, 'media 10', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(rows()).toEqual([
      { usd: 0.1 * (SDK_MAX_RETRIES + 1), detail: 'media 9 (connection lost, estimated)' },
      { usd: 0.05, detail: 'media 10 (unknown, estimated)' },
    ]);
    expectNoReservation(spend);
  });
});
