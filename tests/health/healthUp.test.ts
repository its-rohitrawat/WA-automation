import { describe, expect, it } from 'vitest';
import { Health } from '../../src/health/health.ts';
import { SpendGuard } from '../../src/spend/spendGuard.ts';
import { manualClock } from '../../src/util/clock.ts';
import type { GatewayStatus } from '../../src/wa/gateway.ts';
import { seededDb } from '../helpers/db.ts';

function setup(freeBytes: () => number | null = () => 200e9) {
  const db = seededDb();
  const clock = manualClock('2026-10-19T08:00:00Z');
  const spend = new SpendGuard({ db, clock, capUsd: 1 });
  return { clock, spend, h: new Health({ db, clock, spend, freeBytes }) };
}

const status = (state: GatewayStatus['state'], since = '2026-10-19T08:00:00.000Z'): GatewayStatus => ({ state, since, lastErrorCode: null, credsSaveFailures: 0 });

describe('Health.isUp (the uptime heartbeat)', () => {
  it('is up while connected, and during the first 30 minutes of connecting', () => {
    const { h, clock } = setup();
    expect(h.isUp()).toBe(true); // just started, within the grace period
    h.setWhatsApp(status('open'));
    expect(h.isUp()).toBe(true);
    h.setWhatsApp(status('closed', clock.now().toISOString()));
    clock.advance(29 * 60_000);
    expect(h.isUp()).toBe(true);
    clock.advance(2 * 60_000);
    expect(h.isUp()).toBe(false); // disconnected for over 30 minutes
    h.setWhatsApp(status('open', clock.now().toISOString()));
    expect(h.isUp()).toBe(true);
  });

  it('is down at once when WhatsApp is unlinked, replaced or refused', () => {
    for (const state of ['logged_out', 'replaced', 'forbidden'] as const) {
      const { h } = setup();
      h.setWhatsApp(status(state));
      expect(h.isUp(), state).toBe(false);
    }
  });

  it('is down when the Google sign-in expired, or tracker updates fail for over an hour', () => {
    const auth = setup();
    auth.h.setWhatsApp(status('open'));
    auth.h.markPublishFailed({ step: 'drive', auth: true });
    expect(auth.h.isUp()).toBe(false);
    auth.h.markPublished();
    expect(auth.h.isUp()).toBe(true);

    const slow = setup();
    slow.h.setWhatsApp(status('open'));
    slow.h.markPublishFailed({ step: 'drive', auth: false });
    slow.clock.advance(59 * 60_000);
    expect(slow.h.isUp()).toBe(true);
    slow.clock.advance(2 * 60_000);
    expect(slow.h.isUp()).toBe(false);
  });

  it('stays up for warnings that are not an outage', () => {
    const { h, spend } = setup(() => 5e9); // low disk
    h.setWhatsApp(status('open'));
    h.recordOutcome(1, { status: 'failed', errorCode: 'refusal' });
    spend.record('ai', 2, 'test'); // daily cap reached
    expect(h.line().ok).toBe(false);
    expect(h.isUp()).toBe(true);
  });
});
