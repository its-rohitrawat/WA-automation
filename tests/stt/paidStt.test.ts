import { describe, expect, it, vi } from 'vitest';
import { SpendCapReachedError } from '../../src/brain/paidCall.ts';
import { SpendGuard } from '../../src/spend/spendGuard.ts';
import { txSync } from '../../src/store/db.ts';
import { SttHttpError, SttJobError, SttJobLostError, SttNoAnswerError } from '../../src/stt/http.ts';
import { SttBookingError, withSttHold, type SttBooking } from '../../src/stt/paidStt.ts';
import { manualClock } from '../../src/util/clock.ts';
import { seededDb } from '../helpers/db.ts';

function setup(capUsd = 1) {
  const db = seededDb();
  const spend = new SpendGuard({ db, clock: manualClock('2026-10-19T08:00:00Z'), capUsd });
  const rows = () => db.raw.prepare('SELECT kind, usd, detail FROM spend ORDER BY id').all() as { kind: string; usd: number; detail: string }[];
  return { spend, rows };
}
/** No hold is left: the whole remaining budget can still be reserved. */
const expectNoHold = (spend: SpendGuard) => expect(spend.reserve(spend.capUsd - spend.spentToday() - 1e-9)).not.toBeNull();

describe('withSttHold', () => {
  it('books what the call reports as stt and returns the result', async () => {
    const { spend, rows } = setup();
    const booked: SttBooking[] = [];
    const out = await withSttHold(spend, 0.2, 'meeting 4 part 1', async () => ({ result: 'segments', costUsd: 0.05 }), { onBooked: (b) => booked.push(b) });
    expect(out).toEqual({ result: 'segments', costUsd: 0.05 });
    expect(rows()).toEqual([{ kind: 'stt', usd: 0.05, detail: 'meeting 4 part 1' }]);
    expect(booked).toEqual([{ outcome: 'actual', usd: 0.05 }]);
    expectNoHold(spend);
  });

  it('holds the ceiling as stt while the call runs', async () => {
    const { spend } = setup(1);
    let canSpendDuring: boolean | undefined;
    await withSttHold(spend, 0.7, 'meeting 4 part 1', async () => {
      canSpendDuring = spend.canSpend(0.31);
      return { result: null, costUsd: 0.1 };
    });
    expect(canSpendDuring).toBe(false);
  });

  it('does not call, and says whether only holds are in the way, when the ceiling does not fit', async () => {
    const { spend } = setup(0.5);
    const call = vi.fn(async () => ({ result: null, costUsd: 0 }));
    const capped = await withSttHold(spend, 0.6, 'meeting 4 part 1', call).catch((e: unknown) => e);
    expect(capped).toBeInstanceOf(SpendCapReachedError);
    expect((capped as SpendCapReachedError).busy).toBe(false);
    spend.reserve(0.3); // another call in flight
    const busy = await withSttHold(spend, 0.3, 'meeting 4 part 1', call).catch((e: unknown) => e);
    expect((busy as SpendCapReachedError).busy).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });

  it('releases the hold on a refusal or failure the provider answered (SttHttpError): not billed', async () => {
    const { spend, rows } = setup();
    const booked: SttBooking[] = [];
    const err = new SttHttpError(500);
    await expect(withSttHold(spend, 0.2, 'meeting 4 part 1', () => Promise.reject(err), { onBooked: (b) => booked.push(b) })).rejects.toBe(err);
    expect(rows()).toEqual([]);
    expect(booked).toEqual([{ outcome: 'none', usd: 0 }]);
    expectNoHold(spend);
  });

  it.each([
    ['no answer', new SttNoAnswerError('timeout'), 'meeting 4 part 1 (unknown, estimated)'],
    ['a lost job', new SttJobLostError('status_http_404'), 'meeting 4 part 1 (unknown, estimated)'],
    ['a failed job', new SttJobError('failed'), 'meeting 4 part 1 (job failed, estimated)'],
    ['anything else', new TypeError('boom'), 'meeting 4 part 1 (unknown, estimated)'],
  ])('books the ceiling as stt on %s, then throws it again', async (_name, err, detail) => {
    const { spend, rows } = setup();
    const booked: SttBooking[] = [];
    await expect(withSttHold(spend, 0.2, 'meeting 4 part 1', () => Promise.reject(err), { onBooked: (b) => booked.push(b) })).rejects.toBe(err);
    expect(rows()).toEqual([{ kind: 'stt', usd: 0.2, detail }]);
    expect(booked).toEqual([{ outcome: 'ceiling', usd: 0.2 }]);
    expectNoHold(spend);
  });

  // Callers without hooks (Phase 2b's voice notes) must get the same booking as callers with them.
  it('releases the hold on an SttHttpError when no hooks are given', async () => {
    const { spend, rows } = setup();
    const err = new SttHttpError(401);
    await expect(withSttHold(spend, 0.2, 'media 7', () => Promise.reject(err))).rejects.toBe(err);
    expect(rows()).toEqual([]);
    expectNoHold(spend);
  });

  it.each([
    ['no answer', new SttNoAnswerError('timeout'), 'media 7 (unknown, estimated)'],
    ['a failed job', new SttJobError('failed'), 'media 7 (job failed, estimated)'],
    ['anything else', new TypeError('boom'), 'media 7 (unknown, estimated)'],
  ])('books the ceiling on %s when no hooks are given', async (_name, err, detail) => {
    const { spend, rows } = setup();
    await expect(withSttHold(spend, 0.2, 'media 7', () => Promise.reject(err))).rejects.toBe(err);
    expect(rows()).toEqual([{ kind: 'stt', usd: 0.2, detail }]);
    expectNoHold(spend);
  });

  it('a hold booked at shutdown is booked as stt, its owner is told, and the late answer is not booked again', async () => {
    const { spend, rows } = setup();
    let finish: (v: { result: string; costUsd: number }) => void = () => {};
    const shutdown = vi.fn();
    const p = withSttHold<string>(spend, 0.2, 'meeting 4 part 1', () => new Promise((resolve) => (finish = resolve)), { onBookedAtShutdown: shutdown });
    await Promise.resolve();
    expect(spend.settlePending('shutdown (estimated)')).toBe(1);
    expect(shutdown).toHaveBeenCalledOnce();
    finish({ result: 'late', costUsd: 0.05 });
    expect((await p).result).toBe('late');
    expect(rows()).toEqual([{ kind: 'stt', usd: 0.2, detail: 'shutdown (estimated)' }]);
  });

  it('writes the booking and the owner record in one step: a failing owner write takes the booking with it', async () => {
    const db = seededDb();
    const spend = new SpendGuard({ db, clock: manualClock('2026-10-19T08:00:00Z'), capUsd: 1 });
    const ownerFailed = new Error('part write refused');
    const err = await withSttHold(spend, 0.2, 'meeting 4 part 1', async () => ({ result: 'x', costUsd: 0.05 }), {
      atomically: (fn) => txSync(db, fn),
      onBooked: (_b, r) => {
        expect(r).toBe('x');
        throw ownerFailed;
      },
    }).catch((e: unknown) => e);
    expect(err).toBe(ownerFailed);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM spend').get()).toEqual({ n: 0 }); // the owner's record still says "sent, nothing booked"
    expectNoHold(spend);
  });

  it('a spend write that throws is thrown, and the owner is not told anything was booked', async () => {
    const { spend } = setup();
    const broken = new Error('disk I/O error');
    vi.spyOn(spend, 'record').mockImplementationOnce(() => {
      throw broken;
    });
    const onBooked = vi.fn();
    await expect(withSttHold(spend, 0.2, 'meeting 4 part 1', async () => ({ result: 'x', costUsd: 0.05 }), { onBooked })).rejects.toBe(broken);
    expect(onBooked).not.toHaveBeenCalled();
  });

  it.each([
    ['a refusal', new SttHttpError(401)],
    ['no answer', new SttNoAnswerError('timeout')],
  ])('after %s, a booking write that throws is an SttBookingError whose cause is the call error', async (_name, callErr) => {
    const { spend } = setup();
    const writeErr = new Error('part write refused');
    const err = await withSttHold(spend, 0.2, 'meeting 4 part 1', () => Promise.reject(callErr), {
      onBooked: () => {
        throw writeErr;
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SttBookingError);
    expect((err as SttBookingError).cause).toBe(callErr);
    expect((err as SttBookingError).writeError).toBe(writeErr);
  });
});
