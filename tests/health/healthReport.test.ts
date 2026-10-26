import { describe, expect, it } from 'vitest';
import { Health, readHealthSnapshot } from '../../src/health/health.ts';
import { SpendGuard } from '../../src/spend/spendGuard.ts';
import { getKv, setKv } from '../../src/store/kv.ts';
import { manualClock } from '../../src/util/clock.ts';
import { seededDb } from '../helpers/db.ts';

const SENT = { text: 'Morning report: sent at 06:00 IST', warning: null };
const UNKNOWN = { text: 'Morning report: unknown, check WhatsApp', warning: '⚠️ Morning report: unknown, check WhatsApp. See docs/SETUP.md → "Morning report".' };

function setup(freeBytes: () => number | null = () => 200e9) {
  const db = seededDb();
  const clock = manualClock('2026-10-23T02:00:00Z');
  const spend = new SpendGuard({ db, clock, capUsd: 1 });
  const h = new Health({ db, clock, spend, freeBytes });
  h.setWhatsApp({ state: 'open', since: '2026-10-23T02:00:00.000Z', lastErrorCode: null, credsSaveFailures: 0 });
  return { db, h };
}

describe('Health and the morning report', () => {
  it('warns only when the owner has to act', () => {
    const { h } = setup();
    h.setReport(SENT);
    expect(h.line().ok).toBe(true);
    h.setReport(UNKNOWN);
    expect(h.line()).toEqual({ ok: false, text: UNKNOWN.warning });
    expect(h.workbookLine().text).toBe(UNKNOWN.warning);
    h.setReport(null);
    expect(h.line().ok).toBe(true);
  });

  it('shared-file warnings outrank it, and it outranks low disk', () => {
    const { h } = setup(() => 5e9);
    h.setReport(UNKNOWN);
    expect(h.line().text).toBe(UNKNOWN.warning);
    h.setMedia({ pending: 1, stale: 1, spendCap: 0, failedRecent: 0, uploadFailed: 0 });
    expect(h.line().text).toBe('⚠️ 1 shared file waiting over 30 minutes to be read. See docs/SETUP.md.');
  });

  it('records the report line in the snapshot; snapshots without one still parse, bad ones do not', () => {
    const { db, h } = setup();
    h.persist();
    expect(readHealthSnapshot(db)!.report).toBeUndefined();
    h.setReport(SENT);
    h.persist();
    expect(readHealthSnapshot(db)!.report).toEqual(SENT);
    const stored = JSON.parse(getKv(db, 'health')!) as Record<string, unknown>;
    setKv(db, 'health', JSON.stringify({ ...stored, report: { text: 5, warning: null } }));
    expect(readHealthSnapshot(db)).toBeUndefined();
    setKv(db, 'health', JSON.stringify({ ...stored, report: { text: 'ok', warning: 5 } }));
    expect(readHealthSnapshot(db)).toBeUndefined();
    setKv(db, 'health', JSON.stringify({ ...stored, report: { text: 'ok' } })); // warning missing
    expect(readHealthSnapshot(db)).toBeUndefined();
  });
});
