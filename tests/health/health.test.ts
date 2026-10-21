import { describe, expect, it } from 'vitest';
import { setKv } from '../../src/store/kv.ts';
import { Health, readHealthSnapshot } from '../../src/health/health.ts';
import { SpendGuard } from '../../src/spend/spendGuard.ts';
import { manualClock } from '../../src/util/clock.ts';
import type { GatewayStatus } from '../../src/wa/gateway.ts';
import { seededDb } from '../helpers/db.ts';

function setup(freeBytes: () => number | null = () => 200e9) {
  const db = seededDb();
  const clock = manualClock('2026-10-19T08:00:00Z');
  const spend = new SpendGuard({ db, clock, capUsd: 1 });
  return { db, clock, spend, h: new Health({ db, clock, spend, freeBytes }) };
}

const status = (state: GatewayStatus['state'], since = '2026-10-19T08:00:00.000Z'): GatewayStatus => ({ state, since, lastErrorCode: null, credsSaveFailures: 0 });

describe('Health', () => {
  it('is green when connected', () => {
    const { h } = setup();
    h.setWhatsApp(status('open'));
    expect(h.line()).toEqual({ ok: true, text: '✅ Connected · waiting for new messages' });
    h.recordOutcome(1, { status: 'ok', accepted: 1, rejected: 0 });
    expect(h.line().text).toBe('✅ Connected · last update 19 Oct 13:30');
  });

  it('waits 30 minutes before calling a drop a disconnection', () => {
    const { h, clock } = setup();
    h.setWhatsApp(status('open'));
    h.setWhatsApp(status('closed'));
    clock.advance(29 * 60_000);
    h.setWhatsApp(status('connecting', clock.now().toISOString()));
    expect(h.line().ok).toBe(true);
    clock.advance(2 * 60_000);
    expect(h.line()).toEqual({ ok: false, text: '❌ Disconnected since 19 Oct 13:30' });
    h.setWhatsApp(status('open'));
    expect(h.line().ok).toBe(true);
  });

  it('reports an unlinked device straight away', () => {
    const { h } = setup();
    h.setWhatsApp(status('logged_out'));
    expect(h.line()).toEqual({ ok: false, text: '❌ WhatsApp unlinked since 19 Oct 13:30. Run: npm run cli -- link --reset' });
  });

  it('reports the spend cap before failed groups', () => {
    const { h, spend } = setup();
    h.setWhatsApp(status('open'));
    h.recordOutcome(1, { status: 'failed', errorCode: 'refusal' });
    expect(h.line().text).toBe('⚠️ 1 group waiting (AI error)');
    spend.record('ai', 2, 'test');
    expect(h.line().text).toBe('⚠️ Daily spend cap reached. Paused until midnight IST');
    h.recordOutcome(1, { status: 'ok', accepted: 0, rejected: 0 });
  });

  it('warns about low disk', () => {
    const { h } = setup(() => 5e9);
    h.setWhatsApp(status('open'));
    expect(h.line().text).toBe('⚠️ Low disk: 5.0 GB free');
  });

  it('persists a snapshot for cli status', () => {
    const { db, h } = setup();
    h.setWhatsApp(status('open'));
    expect(readHealthSnapshot(db)).toMatchObject({ whatsapp: { state: 'open' }, line: { ok: true }, capUsd: 1 });
  });

  it('shows the cap message while the reconciler is paused below the cap', () => {
    const { h, spend } = setup();
    h.setWhatsApp(status('open'));
    h.recordOutcome(1, { status: 'paused' });
    expect(spend.spentToday()).toBeLessThan(spend.capUsd);
    expect(h.line().text).toBe('⚠️ Daily spend cap reached. Paused until midnight IST');
    h.recordOutcome(1, { status: 'ok', accepted: 0, rejected: 0 });
    expect(h.line().ok).toBe(true);
  });

  it('shows an expired Google sign-in straight away', () => {
    const { h } = setup();
    h.setWhatsApp(status('open'));
    h.markPublishFailed({ step: 'drive', auth: true });
    expect(h.line()).toEqual({ ok: false, text: '❌ Google sign-in expired. Run: npm run cli -- google-auth' });
    h.markPublished();
    expect(h.line().ok).toBe(true);
  });

  it('reports a failing tracker update only after 60 minutes, and clears on success', () => {
    const { h, clock } = setup();
    h.setWhatsApp(status('open'));
    h.markPublishFailed({ step: 'drive', auth: false });
    clock.advance(59 * 60_000);
    h.markPublishFailed({ step: 'drive', auth: false });
    expect(h.line().ok).toBe(true);
    clock.advance(2 * 60_000);
    expect(h.line()).toEqual({ ok: false, text: '⚠️ Tracker update failing since 19 Oct 13:30' });
    h.markPublished();
    expect(h.line().ok).toBe(true);
  });

  it('workbookLine ignores publish failures', () => {
    const { h, clock } = setup();
    h.setWhatsApp(status('open'));
    h.markPublishFailed({ step: 'drive', auth: true });
    expect(h.line().text).toContain('Google sign-in expired');
    expect(h.workbookLine().ok).toBe(true);
    h.markPublished();
    h.markPublishFailed({ step: 'drive', auth: false });
    clock.advance(61 * 60_000);
    expect(h.line().text).toContain('Tracker update failing');
    expect(h.workbookLine().ok).toBe(true);
  });

  it('forget clears failed and paused clients', () => {
    const { h } = setup();
    h.setWhatsApp(status('open'));
    h.recordOutcome(1, { status: 'failed', errorCode: 'timeout' });
    h.forget(1);
    expect(h.line().ok).toBe(true);
    h.recordOutcome(1, { status: 'paused' });
    h.forget(1);
    expect(h.line().ok).toBe(true);
  });

  it('puts the sign-in error before the creds-save warning', () => {
    const { h } = setup();
    h.setWhatsApp({ ...status('open'), credsSaveFailures: 2 });
    expect(h.line().text).toContain('could not be saved');
    h.markPublishFailed({ step: 'drive', auth: true });
    expect(h.line().text).toBe('❌ Google sign-in expired. Run: npm run cli -- google-auth');
  });

  it('the latest publish failure decides whether it is an auth problem', () => {
    const { h } = setup();
    h.setWhatsApp(status('open'));
    h.markPublishFailed({ step: 'drive', auth: true });
    h.markPublishFailed({ step: 'drive', auth: false });
    expect(h.line().ok).toBe(true);
  });

  it('paused entries expire at midnight IST', () => {
    const db = seededDb();
    const clock = manualClock('2026-10-19T18:20:00Z'); // 23:50 IST
    const spend = new SpendGuard({ db, clock, capUsd: 1 });
    const h = new Health({ db, clock, spend, freeBytes: () => 200e9 });
    h.setWhatsApp(status('open', clock.now().toISOString()));
    h.recordOutcome(1, { status: 'paused' });
    expect(h.line().text).toBe('⚠️ Daily spend cap reached. Paused until midnight IST');
    clock.advance(11 * 60_000); // 00:01 IST
    expect(h.line().ok).toBe(true);
    expect(h.snapshot().line.ok).toBe(true);
  });

  it('keeps failed groups after paused entries expire', () => {
    const db = seededDb();
    const clock = manualClock('2026-10-19T18:20:00Z');
    const spend = new SpendGuard({ db, clock, capUsd: 1 });
    const h = new Health({ db, clock, spend, freeBytes: () => 200e9 });
    h.setWhatsApp(status('open', clock.now().toISOString()));
    h.recordOutcome(1, { status: 'failed', errorCode: 'timeout' });
    h.recordOutcome(1, { status: 'paused' });
    clock.advance(11 * 60_000);
    expect(h.line().text).toBe('⚠️ 1 group waiting (AI error)');
  });

  it('readHealthSnapshot never throws and round-trips', () => {
    const { db, h } = setup();
    setKv(db, 'health', '{not json');
    expect(readHealthSnapshot(db)).toBeUndefined();
    setKv(db, 'health', '{}');
    expect(readHealthSnapshot(db)).toBeUndefined();
    h.setWhatsApp(status('open'));
    h.markPublishFailed({ step: 'drive', auth: false });
    const snap = readHealthSnapshot(db);
    expect(snap?.publishFailingSince).toBe('2026-10-19T08:00:00.000Z');
    expect(snap).toEqual(JSON.parse(JSON.stringify(h.snapshot())));
  });
});
