import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createInvite, redeemInvite } from '../../src/platform/invites.ts';
import { COMING_PROBES, onboardingFor, STEPS, type OnboardingProbes, type ProbeState, type StepId } from '../../src/platform/onboarding.ts';
import { ensurePlatformSchema } from '../../src/platform/schema.ts';
import { getTenant } from '../../src/platform/store.ts';
import { SqliteDb } from '../../src/store/engine/sqlite.ts';
import { manualClock, type ManualClock } from '../../src/util/clock.ts';

let db: SqliteDb;
let clock: ManualClock;
let tenantId: string;

/** Probes that say what the test sets; anything not set is still to do. */
const probes = (states: Partial<Record<StepId, ProbeState>>): OnboardingProbes => ({ state: async (_t, step) => states[step] ?? 'todo' });

beforeEach(async () => {
  db = SqliteDb.open(':memory:');
  await ensurePlatformSchema(db);
  clock = manualClock('2026-10-29T06:00:00.000Z');
  const { token, invite } = await createInvite({ db, clock }, 'founder@example.com', { business: 'Kapoor Design Studio', email: 'kapoor@example.com' });
  await redeemInvite({ db, clock }, { token, email: 'kapoor@example.com' });
  tenantId = invite.tenantId;
});
afterEach(async () => {
  await db.close();
});

describe('the onboarding checklist', () => {
  it('has the design\'s six steps: WhatsApp and the key needed, the spare number optional', () => {
    expect(STEPS.map((s) => [s.id, s.need, s.optional])).toEqual([
      ['whatsapp', true, false], ['key', true, false], ['spare', false, true], ['drive', false, false], ['groups', false, false], ['report', false, false],
    ]);
  });

  it('before the customer workspace exists: the needed steps are coming, the rest locked, nothing works yet', async () => {
    const v = (await onboardingFor({ db, clock }, tenantId, COMING_PROBES))!;
    expect(v).toMatchObject({ business: 'Kapoor Design Studio', status: 'onboarding', done: 0, total: 6, live: false });
    expect(v.steps.map((s) => s.state)).toEqual(['coming', 'coming', 'locked', 'locked', 'locked', 'locked']);
    expect(Object.values(v.works).every((x) => x === false)).toBe(true);
  });

  it('WhatsApp alone saves messages but starts nothing; with the key too the customer becomes active, once, and the rest unlock', async () => {
    let v = (await onboardingFor({ db, clock }, tenantId, probes({ whatsapp: 'done' })))!;
    expect(v).toMatchObject({ status: 'onboarding', live: false, done: 1, activated: false, works: { saving: true, ai: false } });
    expect(v.steps.slice(2).every((s) => s.state === 'locked')).toBe(true);
    v = (await onboardingFor({ db, clock }, tenantId, probes({ whatsapp: 'done', key: 'done' })))!;
    // activated: this call made the customer active, so the caller tells the Supervisor (a full runtime replaces setup).
    expect(v).toMatchObject({ status: 'active', live: true, done: 2, activated: true, works: { saving: true, ai: true, screens: true, tracker: false, report: false } });
    expect(v.steps.map((s) => s.state)).toEqual(['done', 'done', 'todo', 'todo', 'todo', 'todo']);
    expect((await getTenant(db, tenantId))!.status).toBe('active');
    expect((await onboardingFor({ db, clock }, tenantId, probes({ whatsapp: 'done', key: 'done' })))!.activated).toBe(false);
    expect(await db.all('SELECT event FROM platform_audit WHERE event = ?', ['tenant.active'])).toHaveLength(1);
  });

  it('the tracker and the report work once their steps are done too', async () => {
    const v = (await onboardingFor({ db, clock }, tenantId, probes({ whatsapp: 'done', key: 'done', drive: 'done', spare: 'done', report: 'done' })))!;
    expect(v.works).toEqual({ saving: true, ai: true, screens: true, tracker: true, report: true });
    expect(v.done).toBe(5);
  });

  it('a paused customer stays paused; an unknown customer has no checklist', async () => {
    await db.run("UPDATE tenants SET status = 'paused' WHERE id = ?", [tenantId]);
    expect((await onboardingFor({ db, clock }, tenantId, probes({ whatsapp: 'done', key: 'done' })))!.status).toBe('paused');
    expect(await onboardingFor({ db, clock }, '00000000-0000-4000-8000-000000000000')).toBeNull();
  });
});
