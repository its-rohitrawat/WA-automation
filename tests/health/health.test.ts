import { describe, expect, it } from 'vitest';
import { setKv } from '../../src/store/kv.ts';
import { Health, readHealthSnapshot } from '../../src/health/health.ts';
import { SpendGuard } from '../../src/spend/spendGuard.ts';
import { manualClock } from '../../src/util/clock.ts';
import type { GatewayStatus } from '../../src/wa/gateway.ts';
import { seededDb } from '../helpers/db.ts';

async function setup(freeBytes: () => number | null = () => 200e9) {
  const db = await seededDb();
  const clock = manualClock('2026-10-19T08:00:00Z');
  const spend = new SpendGuard({ db, clock, capUsd: 1 });
  return { db, clock, spend, h: new Health({ db, clock, spend, freeBytes }) };
}

const status = (state: GatewayStatus['state'], since = '2026-10-19T08:00:00.000Z'): GatewayStatus => ({ state, since, lastErrorCode: null, credsSaveFailures: 0 });

describe('Health', () => {
  it('is green when connected', async () => {
    const { h } = await setup();
    h.setWhatsApp(status('open'));
    expect(h.line()).toEqual({ ok: true, text: '✅ Connected · waiting for new messages' });
    h.recordOutcome(1, { status: 'ok', accepted: 1, rejected: 0 });
    expect(h.line().text).toBe('✅ Connected · last update 19 Oct 13:30');
  });

  it('waits 30 minutes before calling a drop a disconnection', async () => {
    const { h, clock } = await setup();
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

  it('reports an unlinked device straight away', async () => {
    const { h } = await setup();
    h.setWhatsApp(status('logged_out'));
    expect(h.line()).toEqual({ ok: false, text: '❌ WhatsApp unlinked since 19 Oct 13:30. Follow docs/SETUP.md → "Status logged_out".' });
  });

  it('reports the spend cap before failed groups', async () => {
    const { h, spend } = await setup();
    h.setWhatsApp(status('open'));
    h.recordOutcome(1, { status: 'failed', errorCode: 'refusal' });
    expect(h.line().text).toBe('⚠️ 1 group waiting (AI error)');
    spend.record('ai', 2, 'test');
    expect(h.line().text).toBe('⚠️ Daily spend cap reached. Paused until midnight IST');
    h.recordOutcome(1, { status: 'ok', accepted: 0, rejected: 0 });
  });

  it('warns about low disk', async () => {
    const { h } = await setup(() => 5e9);
    h.setWhatsApp(status('open'));
    expect(h.line().text).toBe('⚠️ Low disk: 5.0 GB free');
  });

  it('persists a snapshot for cli status', async () => {
    const { db, h } = await setup();
    h.setWhatsApp(status('open'));
    expect(readHealthSnapshot(db)).toMatchObject({ whatsapp: { state: 'open' }, line: { ok: true }, capUsd: 1 });
  });

  it('shows the cap message while the reconciler is paused below the cap', async () => {
    const { h, spend } = await setup();
    h.setWhatsApp(status('open'));
    h.recordOutcome(1, { status: 'paused' });
    expect(spend.spentToday()).toBeLessThan(spend.capUsd);
    expect(h.line().text).toBe('⚠️ Daily spend cap reached. Paused until midnight IST');
    h.recordOutcome(1, { status: 'ok', accepted: 0, rejected: 0 });
    expect(h.line().ok).toBe(true);
  });

  it('ignores a waiting run: it is not an update, and failed or paused groups stay (12d)', async () => {
    const { db, h } = await setup();
    h.setWhatsApp(status('open'));
    h.recordOutcome(1, { status: 'waiting' });
    expect(h.line()).toEqual({ ok: true, text: '✅ Connected · waiting for new messages' });
    h.recordOutcome(1, { status: 'failed', errorCode: 'refusal' });
    h.recordOutcome(1, { status: 'waiting' });
    expect(h.line().text).toBe('⚠️ 1 group waiting (AI error)');
    expect(readHealthSnapshot(db)!.failed).toEqual([{ clientId: 1, errorCode: 'refusal' }]);
    h.recordOutcome(2, { status: 'paused' });
    h.recordOutcome(2, { status: 'waiting' });
    expect(h.line().text).toBe('⚠️ Daily spend cap reached. Paused until midnight IST');
    h.recordOutcome(2, { status: 'noop' });
    h.recordOutcome(1, { status: 'noop' });
    expect(h.line()).toEqual({ ok: true, text: '✅ Connected · waiting for new messages' });
  });

  it('shows an expired Google sign-in straight away', async () => {
    const { h } = await setup();
    h.setWhatsApp(status('open'));
    h.markPublishFailed({ step: 'drive', auth: true });
    expect(h.line()).toEqual({ ok: false, text: '❌ Google sign-in expired. Run: npm run cli -- google-auth, then restart the service' });
    h.markPublished();
    expect(h.line().ok).toBe(true);
  });

  it('reports a failing tracker update only after 60 minutes, and clears on success', async () => {
    const { h, clock } = await setup();
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

  it('workbookLine ignores publish failures', async () => {
    const { h, clock } = await setup();
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

  it('forget clears failed and paused clients', async () => {
    const { h } = await setup();
    h.setWhatsApp(status('open'));
    h.recordOutcome(1, { status: 'failed', errorCode: 'timeout' });
    h.forget(1);
    expect(h.line().ok).toBe(true);
    h.recordOutcome(1, { status: 'paused' });
    h.forget(1);
    expect(h.line().ok).toBe(true);
  });

  it('puts the sign-in error before the creds-save warning', async () => {
    const { h } = await setup();
    h.setWhatsApp({ ...status('open'), credsSaveFailures: 2 });
    expect(h.line().text).toContain('could not be saved');
    h.markPublishFailed({ step: 'drive', auth: true });
    expect(h.line().text).toBe('❌ Google sign-in expired. Run: npm run cli -- google-auth, then restart the service');
  });

  it('warns about incoming messages that could not be saved, after the failed-groups line and before low disk', async () => {
    const { h, clock } = await setup();
    h.setWhatsApp({ ...status('open'), credsSaveFailures: 1 });
    h.setIngestFailures(3);
    h.markPublishFailed({ step: 'drive', auth: false });
    clock.advance(61 * 60_000);
    expect(h.line().text).toBe('⚠️ The WhatsApp session could not be saved. Check disk space and the data folder permissions.');
    h.setWhatsApp(status('open', clock.now().toISOString()));
    expect(h.line().text).toBe('⚠️ Tracker update failing since 19 Oct 13:30');
    h.markPublished();
    h.recordOutcome(1, { status: 'failed', errorCode: 'refusal' });
    expect(h.line().text).toContain('waiting (AI error)');
    h.forget(1);
    expect(h.line()).toEqual({ ok: false, text: '⚠️ 3 incoming messages could not be saved. See docs/SETUP.md.' });
    h.setIngestFailures(0);
    expect(h.line().ok).toBe(true);
  });

  it('words a single lost message in the singular, and shows it in the workbook too', async () => {
    const { h } = await setup();
    h.setWhatsApp(status('open'));
    h.setIngestFailures(1);
    expect(h.line()).toEqual({ ok: false, text: '⚠️ 1 incoming message could not be saved. See docs/SETUP.md.' });
    expect(h.workbookLine()).toEqual(h.line());
  });

  it('stores the ingest failure count and persists it with the snapshot', async () => {
    const { db, h } = await setup();
    h.setWhatsApp(status('open'));
    expect(h.snapshot().ingestFailures).toBe(0);
    h.setIngestFailures(2);
    expect(h.snapshot().ingestFailures).toBe(2);
    h.persist();
    expect(readHealthSnapshot(db)!.ingestFailures).toBe(2);
  });

  it('the latest publish failure decides whether it is an auth problem', async () => {
    const { h } = await setup();
    h.setWhatsApp(status('open'));
    h.markPublishFailed({ step: 'drive', auth: true });
    h.markPublishFailed({ step: 'drive', auth: false });
    expect(h.line().ok).toBe(true);
  });

  it('paused entries expire at midnight IST', async () => {
    const db = await seededDb();
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

  it('keeps failed groups after paused entries expire', async () => {
    const db = await seededDb();
    const clock = manualClock('2026-10-19T18:20:00Z');
    const spend = new SpendGuard({ db, clock, capUsd: 1 });
    const h = new Health({ db, clock, spend, freeBytes: () => 200e9 });
    h.setWhatsApp(status('open', clock.now().toISOString()));
    h.recordOutcome(1, { status: 'failed', errorCode: 'timeout' });
    h.recordOutcome(1, { status: 'paused' });
    clock.advance(11 * 60_000);
    expect(h.line().text).toBe('⚠️ 1 group waiting (AI error)');
  });

  it('readHealthSnapshot never throws and round-trips', async () => {
    const { db, h } = await setup();
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

describe('readHealthSnapshot shape checks', () => {
  const full = {
    at: '2026-10-19T07:58:00.000Z', line: { ok: true, text: 'x' }, whatsapp: { state: 'open', since: '2026-10-19T03:30:00.000Z', lastErrorCode: null, credsSaveFailures: 0 },
    downSince: null, failed: [], lastSuccessAt: null, lastPublishedAt: null, spentToday: 1, capUsd: 15, freeGb: 1, publishFailingSince: null,
  };
  const read = async (v: unknown) => {
    const db = await seededDb();
    setKv(db, 'health', JSON.stringify(v));
    return readHealthSnapshot(db);
  };

  it('accepts a full snapshot, including freeGb null', async () => {
    expect(await read(full)).toBeDefined();
    expect(await read({ ...full, freeGb: null })).toBeDefined();
  });

  it('reads an older snapshot without ingestFailures as 0', async () => {
    expect((await read(full))!.ingestFailures).toBe(0);
    expect((await read({ ...full, ingestFailures: 4 }))!.ingestFailures).toBe(4);
  });

  it.each([
    ['whatsapp.state', { ...full, whatsapp: {} }],
    ['spentToday', { ...full, spentToday: 'a' }],
    ['capUsd', { ...full, capUsd: undefined }],
    ['failed', { ...full, failed: null }],
    ['at (invalid date)', { ...full, at: 'not a date' }],
    ['whatsapp.since (missing)', { ...full, whatsapp: { state: 'open' } }],
    ['whatsapp.since (invalid date)', { ...full, whatsapp: { state: 'open', since: 'x' } }],
    ['freeGb (string)', { ...full, freeGb: '10' }],
    ['freeGb (missing)', { ...full, freeGb: undefined }],
    ['ingestFailures (string)', { ...full, ingestFailures: '2' }],
  ])('returns undefined when %s is missing or wrong', async (_n, v) => {
    expect(await read(v)).toBeUndefined();
  });
});
