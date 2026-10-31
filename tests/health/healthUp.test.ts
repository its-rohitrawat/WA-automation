import { describe, expect, it } from 'vitest';
import { Health } from '../../src/health/health.ts';
import { SpendGuard } from '../../src/spend/spendGuard.ts';
import { manualClock } from '../../src/util/clock.ts';
import type { GatewayStatus } from '../../src/wa/gateway.ts';
import { seededDb } from '../helpers/db.ts';

async function setup(freeBytes: () => number | null = () => 200e9) {
  const db = await seededDb();
  const clock = manualClock('2026-10-19T08:00:00Z');
  const spend = new SpendGuard({ db, clock, capUsd: 1 });
  return { clock, spend, h: new Health({ db, clock, spend, freeBytes }) };
}

const status = (state: GatewayStatus['state'], since = '2026-10-19T08:00:00.000Z'): GatewayStatus => ({ state, since, lastErrorCode: null, credsSaveFailures: 0 });

describe('Health.isUp (the uptime heartbeat)', () => {
  it('is up while connected, and during the first 30 minutes of connecting', async () => {
    const { h, clock } = await setup();
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

  it('is down at once when WhatsApp is unlinked, replaced or refused', async () => {
    for (const state of ['logged_out', 'replaced', 'forbidden'] as const) {
      const { h } = await setup();
      h.setWhatsApp(status(state));
      expect(h.isUp(), state).toBe(false);
    }
  });

  it('is down when the Google sign-in expired, or tracker updates fail for over an hour', async () => {
    const auth = await setup();
    auth.h.setWhatsApp(status('open'));
    auth.h.markPublishFailed({ step: 'drive', auth: true });
    expect(auth.h.isUp()).toBe(false);
    auth.h.markPublished();
    expect(auth.h.isUp()).toBe(true);

    const slow = await setup();
    slow.h.setWhatsApp(status('open'));
    slow.h.markPublishFailed({ step: 'drive', auth: false });
    slow.clock.advance(59 * 60_000);
    expect(slow.h.isUp()).toBe(true);
    slow.clock.advance(2 * 60_000);
    expect(slow.h.isUp()).toBe(false);
  });

  it('stays up for warnings that are not an outage', async () => {
    const { h, spend } = await setup(() => 5e9); // low disk
    h.setWhatsApp(status('open'));
    h.recordOutcome(1, { status: 'failed', errorCode: 'refusal' });
    spend.record('ai', 2, 'test'); // daily cap reached
    expect(h.line().ok).toBe(false);
    expect(h.isUp()).toBe(true);
  });
});

describe('Health.downReason (the uptime log, migration v10)', () => {
  it('names the cause isUp() sees, and nothing while up', async () => {
    const { h, clock } = await setup();
    expect(h.downReason()).toBeNull(); // just started: within the grace period
    for (const [state, reason] of [['logged_out', 'whatsapp_logged_out'], ['replaced', 'whatsapp_replaced'], ['forbidden', 'whatsapp_forbidden']] as const) {
      h.setWhatsApp(status(state));
      expect(h.downReason(), state).toBe(reason);
    }
    h.setWhatsApp(status('closed', clock.now().toISOString()));
    clock.advance(31 * 60_000);
    expect(h.downReason()).toBe('whatsapp_disconnected');
  });

  it('a Google sign-in failure while WhatsApp is still in its grace period is google_signin, not a disconnect', async () => {
    const { h } = await setup(); // just started: WhatsApp not connected yet
    h.markPublishFailed({ step: 'drive', auth: true });
    expect(h.isUp()).toBe(false);
    expect(h.downReason()).toBe('google_signin');
  });

  it('tracker updates failing for over an hour without a sign-in problem is tracker_failing', async () => {
    const { h, clock } = await setup();
    h.setWhatsApp(status('open'));
    h.markPublishFailed({ step: 'drive', auth: false });
    clock.advance(59 * 60_000);
    expect(h.downReason()).toBeNull();
    clock.advance(2 * 60_000);
    expect(h.downReason()).toBe('tracker_failing');
  });

  it('isUp() is exactly downReason() being null', async () => {
    const { h, clock } = await setup();
    const both = () => [h.isUp(), h.downReason() === null];
    expect(new Set(both()).size).toBe(1);
    h.setWhatsApp(status('closed', clock.now().toISOString()));
    clock.advance(31 * 60_000);
    expect(both()).toEqual([false, false]);
    h.setWhatsApp(status('open', clock.now().toISOString()));
    expect(both()).toEqual([true, true]);
  });
});

describe('Health.publishProblem (the tracker upload on its own)', () => {
  it('is null while uploads work, failing under an hour, then tracker_failing, and google_signin at once; whatever WhatsApp does', async () => {
    const { h, clock } = await setup();
    h.setWhatsApp(status('logged_out'));
    expect(h.publishProblem()).toBeNull();
    h.markPublishFailed({ step: 'drive', auth: false });
    expect(h.publishProblem()).toBe('failing');
    clock.advance(61 * 60_000);
    expect(h.publishProblem()).toBe('tracker_failing');
    expect(h.downReason()).toBe('whatsapp_logged_out'); // the outage's first cause is still WhatsApp
    h.markPublished();
    h.markPublishFailed({ step: 'drive', auth: true });
    expect(h.publishProblem()).toBe('google_signin');
  });
});

describe('Health.publishProblem edges (review round 2)', () => {
  it('a sign-in failure stays google_signin after an hour, and the hour is strict', async () => {
    const auth = await setup();
    auth.h.markPublishFailed({ step: 'drive', auth: true });
    auth.clock.advance(61 * 60_000);
    expect(auth.h.publishProblem()).toBe('google_signin');
    const plain = await setup();
    plain.h.markPublishFailed({ step: 'drive', auth: false });
    plain.clock.advance(60 * 60_000);
    expect(plain.h.publishProblem()).toBe('failing');
    plain.clock.advance(1);
    expect(plain.h.publishProblem()).toBe('tracker_failing');
  });
});
