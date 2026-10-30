// The platform screens (SaaS S5) on the fake dashboard (scripts/dashboardFake.ts), for the preview and the smoke test.
// Nothing here edits another lane's file: the hookups the owning lanes will apply (docs/superpowers/plans/
// 2026-10-29-saas-invites-hookups.md) are applied here only to the copies this server sends, app.js (one import) and
// router.js (the nav entries). The platform routes run on an in-memory database with made-up invites and a fake mailer:
// nothing reaches Gmail, Google, the agent or any data folder.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AiKeys } from '../src/platform/aiKey.ts';
import { createInvite, markSending, recordSend, redeemInvite } from '../src/platform/invites.ts';
import type { InviteEmail, InviteMailer, MailOutcome } from '../src/platform/mailer.ts';
import type { CustomerHealth } from '../src/platform/customers.ts';
import type { OnboardingProbes, ProbeState, StepId } from '../src/platform/onboarding.ts';
import { ensurePlatformSchema } from '../src/platform/schema.ts';
import { ensureFounderTenant, membershipsFor } from '../src/platform/store.ts';
import { SqliteDb } from '../src/store/engine/sqlite.ts';
import { manualClock, systemClock, type Clock } from '../src/util/clock.ts';
import { silentLogger } from '../src/util/logger.ts';
import { HttpError, readJson, sendError, sendJson } from '../src/web/http.ts';
import type { ApiResult, OwnerContext } from '../src/web/routes/context.ts';
import { mountPlatformRoutes, mountSignupRoutes, type PlatformMount } from '../src/web/routes/platform.ts';
import { PUBLIC_DIR, type WebServer } from '../src/web/server.ts';

const FOUNDER = 'owner@example.com';

/**
 * The one hookup the shell does not have yet: the Getting started entry (5.1). The real shell already imports the
 * platform screens (2.3, app.js) and adds Customers and Invite a customer when /me says `platform: true` (2.4, router.js's
 * navFor and showPlatform); the smoke makes the preview's /me say so (scripts/platform-smoke.ts). Getting started is for
 * customer sessions only (5.1, with S4.8); the preview shows it to everyone because its one signed-in person is both the
 * founder and a customer's member.
 */
export function patchedShell(): { router: string } {
  const router = readFileSync(join(PUBLIC_DIR, 'router.js'), 'utf8');
  const workAnchor = "['Workspace', [['overview', 'Overview', 'dash'],";
  if (!router.includes(workAnchor)) throw new Error('the shell changed: update the hookups doc and this patch');
  return { router: router.replace(workAnchor, "['Workspace', [['onboarding', 'Getting started', 'flash'], ['overview', 'Overview', 'dash'],") };
}

/** A mailer that sends nothing: it says sent (or what the preview sets). */
export class PreviewMailer implements InviteMailer {
  readonly from = 'founder@example.com';
  outcome: MailOutcome = { state: 'sent' };
  sent: InviteEmail[] = [];
  async send(m: InviteEmail): Promise<MailOutcome> {
    this.sent.push(m);
    return this.outcome;
  }
}

/** The preview's made-up customers whose steps are all done (and so active), and the ones that are paused. */
const doneTenants = new Set<string>();

/**
 * Made-up invites and customers like the approved demo's: invites sent, accepted, expired and unknown; customers active,
 * onboarding, invited and paused.
 */
async function seed(db: SqliteDb): Promise<void> {
  const at = (daysAgo: number, hour = 10): Clock => manualClock(new Date(Date.now() - daysAgo * 86_400_000 + (hour - 12) * 3_600_000).toISOString());
  await ensureFounderTenant(db, { name: 'Your studio', at: at(60).now().toISOString() });
  const sent = async (business: string, email: string, daysAgo: number, outcome: MailOutcome) => {
    const d = { db, clock: at(daysAgo) };
    const made = await createInvite(d, FOUNDER, { business, email });
    await markSending(d, FOUNDER, made.invite.id);
    await recordSend(d, FOUNDER, made.invite.id, outcome.state === 'sent' ? { state: 'sent' } : { state: outcome.state, code: outcome.code });
    return made;
  };
  await sent('Patel Print House', 'patel.print@example.com', 10, { state: 'sent' });
  const nair = await sent('Nair Digital Works', 'nair.digital@example.com', 2, { state: 'sent' });
  await redeemInvite({ db, clock: at(2, 16) }, { token: nair.token, email: 'nair.digital@example.com', name: 'Nair' });
  doneTenants.add(nair.invite.tenantId);
  await db.run("UPDATE tenants SET status = 'active', last_activity_at = ? WHERE id = ?", [at(0.004).now().toISOString(), nair.invite.tenantId]);
  const desai = await sent('Desai Tours & Travels', 'desai.tours@example.com', 6, { state: 'sent' });
  await redeemInvite({ db, clock: at(6, 14) }, { token: desai.token, email: 'desai.tours@example.com', name: 'Desai' });
  doneTenants.add(desai.invite.tenantId);
  await db.run("UPDATE tenants SET status = 'paused', updated_at = ?, last_activity_at = ? WHERE id = ?", [at(4).now().toISOString(), at(4).now().toISOString(), desai.invite.tenantId]);
  await sent('Gupta Events Co.', 'gupta.events@example.com', 0.2, { state: 'unknown', code: 'timeout' });
  await sent('Kapoor Design Studio', 'kapoor.studio@example.com', 0.1, { state: 'sent' });
  const joshi = await sent('Joshi Interiors', FOUNDER, 1, { state: 'sent' });
  await redeemInvite({ db, clock: at(1, 15) }, { token: joshi.token, email: FOUNDER, name: 'Test Owner' });
}

/** What each onboarding step reports in the preview for the signed-in owner's customer: coming until a test says otherwise. */
export const fakeSteps: Partial<Record<StepId, ProbeState>> = {};
const previewProbes: OnboardingProbes = { state: async (tenantId, step) => (doneTenants.has(tenantId) ? 'done' : fakeSteps[step] ?? 'coming') };
/** Memory as a runtime would report it, for the preview's active customers. */
/** The Supervisor's runtime state per customer id, as a test sets it (none by default). */
export const fakeRuntimes: Record<string, string> = {};
const previewHealth: CustomerHealth = { memoryMb: (tenantId) => (doneTenants.has(tenantId) ? 96 : 118), runtime: (tenantId) => fakeRuntimes[tenantId] ?? null };

/**
 * Adds the platform screens to a fake dashboard: the patched shell, the platform routes behind the fake's owner check
 * and CSRF token, and a seeded in-memory platform database. Returns the mailer, so a test can change its answer.
 */
/**
 * The preview's one signed-in person is both the founder and a customer's member (Joshi). The founder's own key lives in
 * .env, so the key route refuses the founder; a test sets founder to false to act as the customer for that step.
 */
export const previewAs = { founder: true };

export async function addPlatform(web: WebServer, o: { signedIn: () => boolean; csrf: string; gmail?: boolean }): Promise<{ mailer: PreviewMailer; db: SqliteDb }> {
  const shell = patchedShell();
  web.router.get('/dashboard/static/router.js', ({ res }) => {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' }).end(shell.router);
  });
  const db = SqliteDb.open(':memory:');
  await ensurePlatformSchema(db);
  await seed(db);
  await db.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)'); // a customer's own table, for the key
  const mailer = new PreviewMailer();
  const previewDataKey = Buffer.alloc(32, 1);
  // The session's customer, as S4.8's sessions carry it: the preview's one person is a member of Joshi Interiors.
  const workspace = (await membershipsFor(db, FOUNDER))[0]?.tenantId;
  const owner = (): OwnerContext => {
    if (!o.signedIn()) throw new HttpError(401, 'unauthenticated', 'Sign in first.');
    return { actor: FOUNDER, sessionId: 'fake', requestId: 'fake00000000', tenantId: workspace, role: previewAs.founder ? 'founder' : 'owner' } as OwnerContext;
  };
  const send = (res: Parameters<typeof sendJson>[0], r: ApiResult) => {
    if (r.status >= 400) {
      const e = (r.body as { error: { code: string; message: string } }).error;
      return sendError(res, r.status, e.code, e.message);
    }
    sendJson(res, r.status, r.body);
  };
  const m: PlatformMount = {
    read: (path, fn) => web.router.get(path, async (ctx) => send(ctx.res, await fn(ctx, owner()))),
    change: (path, fn) =>
      web.router.post(path, async (ctx) => {
        const who = owner();
        if (ctx.req.headers['x-csrf-token'] !== o.csrf) throw new HttpError(403, 'csrf', 'Refused.');
        send(ctx.res, await fn(ctx, who, await readJson(ctx.req, 16_384)));
      }),
  };
  mountPlatformRoutes(m, {
    db, clock: systemClock, log: silentLogger(), publicUrl: 'https://agent.example.com', founderName: 'Rohit',
    isFounder: (x) => x.actor === FOUNDER && previewAs.founder, mailer: () => (o.gmail === false ? null : mailer), probes: previewProbes, health: previewHealth,
    // A fake tester: the preview never calls Anthropic, and says yes to any key that looks like one.
    aiKeys: (tenantId) => new AiKeys({ db, platform: db, tenantId, dataKey: async () => previewDataKey, tester: async () => 'ok', clock: systemClock }),
  });
  return { mailer, db };
}

/** Whether the preview starts a customer session at sign-up (true), or sends them to the waiting page as on SQLite. */
export const previewSessions = { on: true };

/** Who the fake Google says signed in, for the next sign-up callback. */
export const fakeGoogle = { email: 'kapoor.studio@example.com', verified: true, nonce: '' };
const FAKE_CLIENT_ID = 'preview-client.apps.googleusercontent.com';

/**
 * The public sign-up on the fake dashboard, with a fake Google: Continue with Google goes to Google's real address (the
 * smoke test answers it with a redirect back, as Google would), and the code exchange and ID-token check answer with
 * fakeGoogle's account. A successful sign-up signs the fake session in.
 */
export function addSignup(web: WebServer, o: { db: SqliteDb; signIn: () => void; publicUrl: string }): void {
  mountSignupRoutes(web.router, {
    db: o.db, clock: systemClock, log: silentLogger(), publicUrl: o.publicUrl, founderName: 'Rohit',
    google: {
      clientId: FAKE_CLIENT_ID,
      exchange: async ({ code }) => `fake-id-token-${code}`,
      verify: async () => ({
        iss: 'https://accounts.google.com', aud: FAKE_CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 600, nonce: fakeGoogle.nonce,
        email: fakeGoogle.email, email_verified: fakeGoogle.verified, name: 'Asha Kapoor',
      }),
    },
    startSession: async () => {
      await o.signIn();
      return previewSessions.on; // false: as on SQLite, before the Postgres switch
    },
    secure: () => false,
    // One address (127.0.0.1) runs every round of the smoke test.
    limits: { perIp: { capacity: 500, refillPerSec: 50 } },
  });
}
