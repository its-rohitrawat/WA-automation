import { describe, expect, it } from 'vitest';
import { Health, readHealthSnapshot, type MediaHealth } from '../../src/health/health.ts';
import { SpendGuard } from '../../src/spend/spendGuard.ts';
import { setKv } from '../../src/store/kv.ts';
import { manualClock } from '../../src/util/clock.ts';
import { seededDb } from '../helpers/db.ts';

function setup(freeBytes: () => number | null = () => 200e9) {
  const db = seededDb();
  const clock = manualClock('2026-10-19T08:00:00Z');
  const spend = new SpendGuard({ db, clock, capUsd: 1 });
  const h = new Health({ db, clock, spend, freeBytes });
  h.setWhatsApp({ state: 'open', since: '2026-10-19T08:00:00.000Z', lastErrorCode: null, credsSaveFailures: 0 });
  return { db, h, spend };
}
const counts = (o: Partial<MediaHealth> = {}): MediaHealth => ({ pending: 0, stale: 0, spendCap: 0, failedRecent: 0, uploadFailed: 0, sttRefused: 0, ...o });
const SPEND_LINE = '⚠️ Daily spend cap reached. Paused until midnight IST';
const budgetLine = (n: number) => `⚠️ ${n} shared file${n === 1 ? '' : 's'} waiting for today's AI budget (read after midnight IST)`;

describe('Health and shared files', () => {
  it('warns when shared files wait more than 30 minutes', () => {
    const { h } = setup();
    h.setMedia(counts({ pending: 3, stale: 2 }));
    expect(h.line()).toEqual({ ok: false, text: '⚠️ 2 shared files waiting over 30 minutes to be read. See docs/SETUP.md.' });
    h.setMedia(counts({ pending: 3 }));
    expect(h.line().ok).toBe(true);
  });

  it('warns about files that could not be uploaded', () => {
    const { h } = setup();
    h.setMedia(counts({ uploadFailed: 1 }));
    expect(h.line()).toEqual({ ok: false, text: '⚠️ 1 file could not be uploaded to Drive. See docs/SETUP.md.' });
    h.setMedia(counts({ uploadFailed: 2 }));
    expect(h.line().text).toBe('⚠️ 2 files could not be uploaded to Drive. See docs/SETUP.md.');
  });

  it('a long wait outranks uploads that gave up', () => {
    const { h } = setup();
    h.setMedia(counts({ stale: 1, uploadFailed: 1 }));
    expect(h.line().text).toBe('⚠️ 1 shared file waiting over 30 minutes to be read. See docs/SETUP.md.');
  });

  it('lost messages outrank files waiting over 30 minutes and uploads that gave up (15h)', () => {
    const { h } = setup();
    h.setMedia(counts({ stale: 1, uploadFailed: 1 }));
    h.setIngestFailures(1);
    expect(h.line().text).toBe('⚠️ 1 incoming message could not be saved. See docs/SETUP.md.');
  });

  it('an AI error outranks the media warnings, which outrank low disk', () => {
    const { h } = setup(() => 5e9);
    h.setMedia(counts({ stale: 1 }));
    expect(h.line().text).toBe('⚠️ 1 shared file waiting over 30 minutes to be read. See docs/SETUP.md.');
    h.recordOutcome(1, { status: 'failed', errorCode: 'refusal' });
    expect(h.line().text).toBe('⚠️ 1 group waiting (AI error)');
  });

  it('files waiting for the daily budget get their own line while the cap is not reached (15b, review round 1)', () => {
    const { h } = setup(() => 5e9);
    // A scan holds about $4 while it is read, so it can wait for the budget long before the cap is reached.
    h.setMedia(counts({ pending: 1, spendCap: 1 }));
    expect(h.line()).toEqual({ ok: false, text: budgetLine(1) });
    expect(h.workbookLine()).toEqual({ ok: false, text: budgetLine(1) });
    h.setMedia(counts({ pending: 2, spendCap: 2 }));
    expect(h.line().text).toBe(budgetLine(2));
    // Nothing is paused, so the problems that need the owner come first: upload failures, long waits,
    // lost messages and AI errors. Low disk comes after the media warnings, as for the others.
    h.setMedia(counts({ pending: 2, spendCap: 1, uploadFailed: 1 }));
    expect(h.line().text).toBe('⚠️ 1 file could not be uploaded to Drive. See docs/SETUP.md.');
    h.setMedia(counts({ pending: 2, stale: 1, spendCap: 1 }));
    expect(h.line().text).toBe('⚠️ 1 shared file waiting over 30 minutes to be read. See docs/SETUP.md.');
    h.setMedia(counts({ pending: 1, spendCap: 1 }));
    h.setIngestFailures(1);
    expect(h.line().text).toBe('⚠️ 1 incoming message could not be saved. See docs/SETUP.md.');
    h.recordOutcome(1, { status: 'failed', errorCode: 'refusal' });
    expect(h.line().text).toBe('⚠️ 1 group waiting (AI error)');
  });

  it('files waiting for the budget show the spend-cap line only when the cap is really reached (15b)', () => {
    const { h, spend } = setup();
    h.recordOutcome(1, { status: 'failed', errorCode: 'refusal' });
    h.setMedia(counts({ pending: 1, spendCap: 1 }));
    expect(h.line().text).toBe('⚠️ 1 group waiting (AI error)');
    spend.record('ai', 1, 'batch 1');
    expect(h.line()).toEqual({ ok: false, text: SPEND_LINE });
    expect(h.workbookLine()).toEqual({ ok: false, text: SPEND_LINE });
  });

  it('a waiting run changes nothing in the media warnings (15c)', () => {
    const { db, h } = setup();
    h.setMedia(counts({ pending: 1, stale: 1 }));
    // A group with an AI error stays failed: waiting for a file is not a success that clears it.
    h.recordOutcome(1, { status: 'failed', errorCode: 'refusal' });
    const failed = readHealthSnapshot(db)!;
    expect(failed.line.text).toBe('⚠️ 1 group waiting (AI error)');
    h.recordOutcome(1, { status: 'waiting' });
    expect(h.line().text).toBe('⚠️ 1 group waiting (AI error)');
    expect(h.snapshot().media).toEqual(counts({ pending: 1, stale: 1 }));
    expect(readHealthSnapshot(db)).toEqual(failed);
    // A paused group stays paused too.
    h.recordOutcome(2, { status: 'paused' });
    h.recordOutcome(2, { status: 'waiting' });
    expect(h.line().text).toBe(SPEND_LINE);
    // Once the groups recover, the media warning shows again, with the same counts.
    h.recordOutcome(1, { status: 'noop' });
    h.recordOutcome(2, { status: 'noop' });
    expect(h.line().text).toBe('⚠️ 1 shared file waiting over 30 minutes to be read. See docs/SETUP.md.');
    expect(readHealthSnapshot(db)!.media).toEqual(counts({ pending: 1, stale: 1 }));
  });

  it('a run kept out only by another paid call’s hold is ignored, like waiting: no spend-cap line (Task 15 review round 3)', () => {
    const { h } = setup();
    h.recordOutcome(1, { status: 'busy' });
    expect(h.line()).toEqual({ ok: true, text: '✅ Connected · waiting for new messages' });
    // It clears nothing either: a failed group stays failed, a paused one stays paused.
    h.recordOutcome(1, { status: 'failed', errorCode: 'refusal' });
    h.recordOutcome(1, { status: 'busy' });
    expect(h.line().text).toBe('⚠️ 1 group waiting (AI error)');
    h.recordOutcome(2, { status: 'paused' });
    h.recordOutcome(2, { status: 'busy' });
    expect(h.line().text).toBe(SPEND_LINE);
  });

  it('keeps the counts in the snapshot and still reads older snapshots without them', () => {
    const { db, h } = setup();
    h.setMedia(counts({ pending: 2, failedRecent: 1 }));
    h.persist();
    expect(readHealthSnapshot(db)!.media).toEqual(counts({ pending: 2, failedRecent: 1 }));
    const old = JSON.parse(JSON.stringify(h.snapshot())) as Record<string, unknown>;
    delete old.media;
    setKv(db, 'health', JSON.stringify(old));
    expect(readHealthSnapshot(db)).toBeDefined();
    expect(readHealthSnapshot(db)!.media).toBeUndefined();
    setKv(db, 'health', JSON.stringify({ ...old, media: { pending: 'x' } }));
    expect(readHealthSnapshot(db)).toBeUndefined();
    setKv(db, 'health', JSON.stringify({ ...old, media: null }));
    expect(readHealthSnapshot(db)).toBeUndefined();
    const { spendCap: _left, ...noSpendCap } = counts({ pending: 2 });
    setKv(db, 'health', JSON.stringify({ ...old, media: noSpendCap }));
    expect(readHealthSnapshot(db)).toBeUndefined();
  });
});
