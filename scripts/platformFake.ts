// The platform screens (SaaS S5) on the fake dashboard (scripts/dashboardFake.ts), for the preview and the smoke test.
// Nothing here edits another lane's file: the hookups the owning lanes will apply (docs/superpowers/plans/
// 2026-10-29-saas-invites-hookups.md) are applied here only to the copies this server sends, app.js (one import) and
// router.js (the nav entries). The platform routes run on an in-memory database with made-up invites and a fake mailer:
// nothing reaches Gmail, Google, the agent or any data folder.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInvite, markSending, recordSend, redeemInvite } from '../src/platform/invites.ts';
import type { InviteEmail, InviteMailer, MailOutcome } from '../src/platform/mailer.ts';
import { ensurePlatformSchema } from '../src/platform/schema.ts';
import { ensureFounderTenant } from '../src/platform/store.ts';
import { SqliteDb } from '../src/store/engine/sqlite.ts';
import { manualClock, systemClock, type Clock } from '../src/util/clock.ts';
import { silentLogger } from '../src/util/logger.ts';
import { HttpError, readJson, sendError, sendJson } from '../src/web/http.ts';
import type { ApiResult, OwnerContext } from '../src/web/routes/context.ts';
import { mountPlatformRoutes, mountSignupRoutes, type PlatformMount } from '../src/web/routes/platform.ts';
import { PUBLIC_DIR, type WebServer } from '../src/web/server.ts';

const FOUNDER = 'owner@example.com';

/** The hookups, as the owning lanes will apply them: the platform screens' import and their nav entries. */
export function patchedShell(): { app: string; router: string } {
  const app = readFileSync(join(PUBLIC_DIR, 'app.js'), 'utf8');
  const router = readFileSync(join(PUBLIC_DIR, 'router.js'), 'utf8');
  const appAnchor = "import './views/screens.js';";
  const navAnchor = "['System', [['connections', 'Connections', 'plug'],";
  if (!app.includes(appAnchor) || !router.includes(navAnchor)) throw new Error('the shell changed: update the hookups doc and this patch');
  return {
    app: app.replace(appAnchor, `${appAnchor}\nimport './views/platform.js';`),
    router: router.replace(navAnchor, "['System', [['customers', 'Customers', 'store'], ['invite', 'Invite a customer', 'mail'], ['connections', 'Connections', 'plug'],"),
  };
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

/** Made-up invites like the approved demo's: one sent, one accepted, one expired, one unknown. */
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
  await sent('Gupta Events Co.', 'gupta.events@example.com', 0.2, { state: 'unknown', code: 'timeout' });
  await sent('Kapoor Design Studio', 'kapoor.studio@example.com', 0.1, { state: 'sent' });
}

/**
 * Adds the platform screens to a fake dashboard: the patched shell, the platform routes behind the fake's owner check
 * and CSRF token, and a seeded in-memory platform database. Returns the mailer, so a test can change its answer.
 */
export async function addPlatform(web: WebServer, o: { signedIn: () => boolean; csrf: string; gmail?: boolean }): Promise<{ mailer: PreviewMailer; db: SqliteDb }> {
  const shell = patchedShell();
  for (const [path, body] of [['/dashboard/static/app.js', shell.app], ['/dashboard/static/router.js', shell.router]] as const) {
    web.router.get(path, ({ res }) => {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' }).end(body);
    });
  }
  const db = SqliteDb.open(':memory:');
  await ensurePlatformSchema(db);
  await seed(db);
  const mailer = new PreviewMailer();
  const owner = (): OwnerContext => {
    if (!o.signedIn()) throw new HttpError(401, 'unauthenticated', 'Sign in first.');
    return { actor: FOUNDER, sessionId: 'fake', requestId: 'fake00000000' };
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
    isFounder: (x) => x.actor === FOUNDER, mailer: () => (o.gmail === false ? null : mailer),
  });
  return { mailer, db };
}

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
    startSession: async () => o.signIn(),
    secure: () => false,
    // One address (127.0.0.1) runs every round of the smoke test.
    limits: { perIp: { capacity: 500, refillPerSec: 50 } },
  });
}
