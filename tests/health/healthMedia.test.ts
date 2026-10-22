import { describe, expect, it } from 'vitest';
import { Health, readHealthSnapshot, type MediaHealth } from '../../src/health/health.ts';
import { SpendGuard } from '../../src/spend/spendGuard.ts';
import { setKv } from '../../src/store/kv.ts';
import { manualClock } from '../../src/util/clock.ts';
import { seededDb } from '../helpers/db.ts';

function setup(freeBytes: () => number | null = () => 200e9) {
  const db = seededDb();
  const clock = manualClock('2026-10-19T08:00:00Z');
  const h = new Health({ db, clock, spend: new SpendGuard({ db, clock, capUsd: 1 }), freeBytes });
  h.setWhatsApp({ state: 'open', since: '2026-10-19T08:00:00.000Z', lastErrorCode: null, credsSaveFailures: 0 });
  return { db, h };
}
const counts = (o: Partial<MediaHealth> = {}): MediaHealth => ({ pending: 0, stale: 0, spendCap: 0, failedRecent: 0, uploadFailed: 0, ...o });
const SPEND_LINE = '⚠️ Daily spend cap reached. Paused until midnight IST';

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

  it('an AI error outranks the media warnings, which outrank low disk', () => {
    const { h } = setup(() => 5e9);
    h.setMedia(counts({ stale: 1 }));
    expect(h.line().text).toBe('⚠️ 1 shared file waiting over 30 minutes to be read. See docs/SETUP.md.');
    h.recordOutcome(1, { status: 'failed', errorCode: 'refusal' });
    expect(h.line().text).toBe('⚠️ 1 group waiting (AI error)');
  });

  it('files waiting for the daily budget show the spend-cap line (15b)', () => {
    const { h } = setup();
    h.setMedia(counts({ pending: 1, spendCap: 1 }));
    expect(h.line()).toEqual({ ok: false, text: SPEND_LINE });
    expect(h.workbookLine()).toEqual({ ok: false, text: SPEND_LINE });
    // Like a paused group, it outranks AI errors and the other media warnings.
    h.recordOutcome(1, { status: 'failed', errorCode: 'refusal' });
    h.setMedia(counts({ pending: 2, stale: 1, spendCap: 1, uploadFailed: 1 }));
    expect(h.line().text).toBe(SPEND_LINE);
    h.setMedia(counts({ pending: 1, stale: 1 }));
    expect(h.line().text).toBe('⚠️ 1 group waiting (AI error)');
  });

  it('a waiting run changes nothing in the media warnings (15c)', () => {
    const { h } = setup();
    h.setMedia(counts({ stale: 1 }));
    h.recordOutcome(1, { status: 'waiting' });
    expect(h.line().text).toBe('⚠️ 1 shared file waiting over 30 minutes to be read. See docs/SETUP.md.');
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
