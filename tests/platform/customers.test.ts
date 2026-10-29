import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listCustomers, pauseCustomer, resumeCustomer, type CustomersDeps } from '../../src/platform/customers.ts';
import { PlatformError } from '../../src/platform/errors.ts';
import { createInvite, redeemInvite } from '../../src/platform/invites.ts';
import type { OnboardingProbes, ProbeState, StepId } from '../../src/platform/onboarding.ts';
import { ensurePlatformSchema } from '../../src/platform/schema.ts';
import { ensureFounderTenant, getTenant } from '../../src/platform/store.ts';
import { SqliteDb } from '../../src/store/engine/sqlite.ts';
import { manualClock, type ManualClock } from '../../src/util/clock.ts';

let db: SqliteDb;
let clock: ManualClock;
let steps: Record<string, Partial<Record<StepId, ProbeState>>>;
let d: CustomersDeps;

const probes: OnboardingProbes = { state: async (tenantId, step) => steps[tenantId]?.[step] ?? 'coming' };

beforeEach(async () => {
  db = SqliteDb.open(':memory:');
  await ensurePlatformSchema(db);
  clock = manualClock('2026-10-29T06:00:00.000Z');
  steps = {};
  d = { db, clock, probes };
  await ensureFounderTenant(db, { name: 'Your studio', at: '2026-09-01T00:00:00.000Z' });
});
afterEach(async () => {
  await db.close();
});

/** A customer that signed up (onboarding), or only invited. */
async function customer(name: string, signedUp = true): Promise<string> {
  clock.advance(60_000); // listed in the order they were invited
  const { token, invite } = await createInvite({ db, clock }, 'founder@example.com', { business: name, email: `${name.split(' ')[0]!.toLowerCase()}@example.com` });
  if (signedUp) await redeemInvite({ db, clock }, { token, email: invite.email });
  return invite.tenantId;
}

const refusal = async (p: Promise<unknown>): Promise<PlatformError> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof PlatformError) return e;
    throw e;
  }
  throw new Error('expected a refusal');
};

describe('the Customers list', () => {
  it('the founder first, then each customer: status, onboarding progress and the next step; setup and health only', async () => {
    const kapoor = await customer('Kapoor Design Studio');
    await customer('Gupta Events', false);
    steps[kapoor] = { whatsapp: 'done', key: 'todo' };
    const v = await listCustomers(d);
    expect(v.customers.map((c) => [c.name, c.status, c.founder])).toEqual([
      ['Your studio', 'active', true], ['Kapoor Design Studio', 'onboarding', false], ['Gupta Events', 'invited', false],
    ]);
    expect(v.customers[1]).toMatchObject({ onboarding: { done: 1, total: 6, next: 'Add your Anthropic API key' }, aiKey: 'missing', memoryMb: null });
    expect(v.customers[2]).toMatchObject({ onboarding: null, aiKey: null });
    expect(v.counts).toEqual({ active: 1, onboarding: 1, invited: 1, paused: 0 });
    expect(v).toMatchObject({ maxActive: 20, memoryMb: null });
    // Exactly these fields: nothing from a customer's own data.
    expect(Object.keys(v.customers[1]!).sort()).toEqual(['aiKey', 'createdAt', 'founder', 'id', 'lastActivityAt', 'memoryMb', 'name', 'onboarding', 'signedUpAt', 'status', 'updatedAt']);
  });

  it('the AI key: configured when that step is done, missing when it is to do, unknown (—) until it exists', async () => {
    const a = await customer('Alpha One');
    await customer('Beta Two');
    steps[a] = { key: 'done' };
    const v = await listCustomers(d);
    expect(v.customers.map((c) => c.aiKey)).toEqual(['configured', 'configured', null]);
  });

  it('memory comes from the runtimes, for active customers only, and adds up', async () => {
    const a = await customer('Alpha One');
    await db.run("UPDATE tenants SET status = 'active' WHERE id = ?", [a]);
    const v = await listCustomers({ ...d, health: { memoryMb: (id) => (id === a ? 96 : 118) } });
    expect(v.customers.map((c) => c.memoryMb)).toEqual([118, 96]);
    expect(v.memoryMb).toBe(214);
  });
});

describe('pausing and resuming', () => {
  it('pauses an active or onboarding customer (audited); never the founder, an invited one or an unknown one', async () => {
    const a = await customer('Alpha One');
    await pauseCustomer(d, 'founder@example.com', a);
    expect((await getTenant(db, a))!.status).toBe('paused');
    expect(await db.all('SELECT actor, event, detail FROM platform_audit WHERE event = ?', ['tenant.paused'])).toEqual([{ actor: 'founder@example.com', event: 'tenant.paused', detail: 'Alpha One' }]);
    const founder = (await listCustomers(d)).customers[0]!.id;
    expect(await refusal(pauseCustomer(d, 'founder@example.com', founder))).toMatchObject({ status: 409, code: 'founder' });
    expect(await refusal(pauseCustomer(d, 'founder@example.com', await customer('Gupta Events', false)))).toMatchObject({ status: 409 });
    expect(await refusal(pauseCustomer(d, 'founder@example.com', a))).toMatchObject({ status: 409 });
    expect(await refusal(pauseCustomer(d, 'founder@example.com', '00000000-0000-4000-8000-000000000000'))).toMatchObject({ status: 404 });
  });

  it('resumes to active when WhatsApp and the key are done, else to onboarding; only a paused one', async () => {
    const a = await customer('Alpha One');
    const b = await customer('Beta Two');
    steps[a] = { whatsapp: 'done', key: 'done' };
    await pauseCustomer(d, 'founder@example.com', a);
    await pauseCustomer(d, 'founder@example.com', b);
    expect(await resumeCustomer(d, 'founder@example.com', a)).toBe('active');
    expect(await resumeCustomer(d, 'founder@example.com', b)).toBe('onboarding');
    expect(await refusal(resumeCustomer(d, 'founder@example.com', a))).toMatchObject({ status: 409, code: 'not_paused' });
  });

  it('never passes the limit of active customers', async () => {
    const a = await customer('Alpha One');
    steps[a] = { whatsapp: 'done', key: 'done' };
    await pauseCustomer(d, 'founder@example.com', a);
    // The founder's business is one active customer; with a limit of 1, nobody else can be resumed to active.
    expect(await refusal(resumeCustomer({ ...d, maxActive: 1 }, 'founder@example.com', a))).toMatchObject({ status: 409, code: 'limit' });
    expect((await getTenant(db, a))!.status).toBe('paused');
  });
});
