import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { z } from 'zod';
import { PlatformError } from '../../platform/errors.ts';
import {
  cancelInvite, createInvite, inviteForSignup, INVITES_PER_DAY, linksLeftToday, listInvites, markSending, newLink, recordSend, redeemInvite, type InviteView,
} from '../../platform/invites.ts';
import type { InviteMailer, MailOutcome } from '../../platform/mailer.ts';
import { onboardingFor, type OnboardingProbes } from '../../platform/onboarding.ts';
import { membershipsFor, platformAudit } from '../../platform/store.ts';
import { inviteTokenHash } from '../../platform/tokens.ts';
import type { Sql } from '../../store/engine/types.ts';
import type { Clock } from '../../util/clock.ts';
import type { Logger } from '../../util/logger.ts';
import { clientAddress, RateLimiter, SIGNIN_LIMIT, type RateLimit } from '../guard.ts';
import { parseCookies, sendError, sendJson, serializeCookie } from '../http.ts';
import { authorizeUrl, checkClaims, PendingSignIns, SignInError, SignInRefused, type CodeExchanger, type IdTokenVerifier, type Pending } from '../oidc.ts';
import type { RequestContext, Router } from '../router.ts';
import { PUBLIC_DIR } from '../server.ts';
import { fail, ok, type ApiResult, type OwnerContext } from './context.ts';

// The platform API (SaaS S5): the founder's invites, the public sign-up (mountSignupRoutes), and later the Customers screen. Plain handlers, mounted through the
// dashboard's own read/change registrars (owner guard; for a change also Origin, CSRF and the action limit), so this file
// adds no route of its own until mountRoutes.ts calls mountPlatformRoutes (see the hookups doc). Founder only.
// The invite link (it holds the token) goes only to the founder, in the answer that made it; it is never logged.

export interface PlatformRouteDeps {
  db: Sql;
  clock: Clock;
  log: Logger;
  /** The site's public address, for the link: https://agent.example.com (no trailing slash). */
  publicUrl: string;
  /** The founder's name, for the email. */
  founderName: string;
  /** Whether this signed-in owner is the platform owner (the founder). */
  isFounder: (o: OwnerContext) => boolean;
  /**
   * The founder's Gmail, when connected with gmail.send; null: invites go by Copy link only. Read on every request, so a
   * reconnect with the permission applies at once.
   */
  mailer: () => InviteMailer | null;
  /** Each onboarding step's state for a customer (default: every step coming, until the customer workspace, S4). */
  probes?: OnboardingProbes;
}

/** How the dashboard's own registrars look (src/web/mountRoutes.ts). */
export interface PlatformMount {
  read: (path: string, answer: (ctx: RequestContext, o: OwnerContext) => ApiResult | Promise<ApiResult>) => void;
  change: (path: string, answer: (ctx: RequestContext, o: OwnerContext, body: unknown) => ApiResult | Promise<ApiResult>) => void;
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const notFounder = () => fail(403, 'forbidden', 'Only the platform owner can do this.');
const notFound = () => fail(404, 'not_found', 'There is no such invite.');

/** A PlatformError as its answer; anything else goes on to the server's 500. */
async function answer(fn: () => Promise<ApiResult>): Promise<ApiResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PlatformError) return fail(e.status, e.code, e.message);
    throw e;
  }
}

const NewInvite = z.strictObject({ business: z.string().max(200), email: z.string().max(300), send: z.boolean() });

export type EmailResult = MailOutcome['state'] | 'not_connected';

export interface InvitesView {
  invites: InviteView[];
  /** Links the founder can still make today, and the daily limit. */
  left: number;
  perDay: number;
  gmail: { connected: boolean; from: string | null };
}

export function mountPlatformRoutes(m: PlatformMount, d: PlatformRouteDeps): void {
  const link = (token: string) => `${d.publicUrl.replace(/\/+$/, '')}/signup?invite=${token}`;

  const view = async (o: OwnerContext): Promise<InvitesView> => ({
    invites: await listInvites(d), left: await linksLeftToday(d, o.actor), perDay: INVITES_PER_DAY,
    gmail: { connected: d.mailer() !== null, from: d.mailer()?.from ?? null },
  });

  /**
   * Emails a link through the founder's Gmail: 'sending' is written (and audited) first, then the call, then the
   * outcome. Never retried here: an unclear answer is 'unknown'.
   */
  const email = async (o: OwnerContext, invite: InviteView, token: string): Promise<EmailResult> => {
    const mailer = d.mailer();
    if (!mailer) return 'not_connected';
    await markSending(d, o.actor, invite.id, o.requestId);
    d.log.info({ invite: invite.id, requestId: o.requestId }, 'invite email: asking Gmail');
    let outcome: MailOutcome;
    try {
      outcome = await mailer.send({ to: invite.email, business: invite.business, founderName: d.founderName, link: link(token), expiresAt: invite.expiresAt });
    } catch {
      // A sender that throws gave no clear answer. No error text is kept: it can hold the address.
      outcome = { state: 'unknown', code: 'send_error' };
    }
    await recordSend(d, o.actor, invite.id, outcome.state === 'sent' ? { state: 'sent' } : { state: outcome.state, code: outcome.code }, o.requestId);
    d.log.info({ invite: invite.id, outcome: outcome.state, requestId: o.requestId }, 'invite email: done');
    return outcome.state;
  };

  m.read('/dashboard/api/platform/invites', async (_ctx, o) => (d.isFounder(o) ? ok(await view(o)) : notFounder()));

  // A new invite: { business, email, send }. send false is Copy link: the link comes back and nothing is emailed.
  m.change('/dashboard/api/platform/invites', (_ctx, o, body) => answer(async () => {
    if (!d.isFounder(o)) return notFounder();
    const parsed = NewInvite.safeParse(body);
    if (!parsed.success) return fail(400, 'invalid', 'Send the business name, their Gmail address and whether to email it.');
    const made = await createInvite(d, o.actor, parsed.data, o.requestId);
    const sent = parsed.data.send ? await email(o, made.invite, made.token) : 'not_sent';
    return ok({ invite: (await listInvites(d)).find((v) => v.id === made.invite.id), link: link(made.token), email: sent });
  }));

  // Copy link on a row: a new link (the old one stops working), nothing emailed.
  m.change('/dashboard/api/platform/invites/:id/link', ({ params }, o) => answer(async () => {
    if (!d.isFounder(o)) return notFounder();
    if (!ID.test(params.id ?? '')) return notFound();
    const made = await newLink(d, o.actor, params.id!, o.requestId);
    return ok({ invite: made.invite, link: link(made.token) });
  }));

  // Resend (or Send again after it expired): a new link, emailed. Without Gmail it is refused: use Copy link.
  m.change('/dashboard/api/platform/invites/:id/resend', ({ params }, o) => answer(async () => {
    if (!d.isFounder(o)) return notFounder();
    if (!ID.test(params.id ?? '')) return notFound();
    if (!d.mailer()) return fail(409, 'gmail_not_connected', 'Gmail is not connected. Use Copy link and send it yourself.');
    const made = await newLink(d, o.actor, params.id!, o.requestId);
    const sent = await email(o, made.invite, made.token);
    return ok({ invite: (await listInvites(d)).find((v) => v.id === made.invite.id), email: sent });
  }));

  // Getting started: the signed-in person's own workspace checklist (any member, not only the founder).
  m.read('/dashboard/api/platform/onboarding', async (_ctx, o) => {
    const tenantId = (await membershipsFor(d.db, o.actor.trim().toLowerCase()))[0]?.tenantId;
    const v = tenantId ? await onboardingFor(d, tenantId, d.probes) : null;
    if (!v) return fail(404, 'no_workspace', 'There is no workspace to set up for this account.');
    return ok({ ...v, founderName: d.founderName });
  });

  m.change('/dashboard/api/platform/invites/:id/cancel', ({ params }, o) => answer(async () => {
    if (!d.isFounder(o)) return notFounder();
    if (!ID.test(params.id ?? '')) return notFound();
    return ok({ invite: await cancelInvite(d, o.actor, params.id!, o.requestId) });
  }));
}

// ---------------------------------------------------------------- sign-up (design section 5, step 3)

/** The sign-up attempt in flight (the key into PendingSignIns), only on /signup paths. */
export const SIGNUP_COOKIE = 'wa_signup';
/** Sign-in attempts (Continue with Google) per invite link: 5 at once, then one every 2 minutes. */
export const SIGNUP_TOKEN_LIMIT: Readonly<RateLimit> = Object.freeze({ capacity: 5, refillPerSec: 1 / 120 });
const SIGNUP_PAGE = 'signup.html';

export interface SignupDeps {
  db: Sql;
  clock: Clock;
  log: Logger;
  /** The site's public address (the callback is <publicUrl>/signup/callback). */
  publicUrl: string;
  founderName: string;
  /** Google sign-in (the same web client as the owner's). null: sign-up is not set up, and the page says so. */
  google: { clientId: string; exchange: CodeExchanger; verify: IdTokenVerifier } | null;
  /**
   * Starts the new customer owner's dashboard session (sets its cookie on ctx.res). Supplied by the owning lane
   * (hookups doc, section 4): the dashboard's sessions are owner-only until customer sessions exist.
   */
  startSession: (ctx: RequestContext, o: { email: string; name?: string; tenantId: string; userId: string }) => Promise<void>;
  /** Whether the request came over https (the cookie's Secure flag). */
  secure: (req: IncomingMessage) => boolean;
  /** The public folder (tests: the real one). */
  publicDir?: string;
  /** Tests and the preview only: other rate limits (per address, per link). */
  limits?: { perIp?: RateLimit; perToken?: RateLimit };
}

/** Plain words for the page: the codes in its address (no detail on why a link does not work). */
export type SignupNote = 'invalid' | 'wrong_account' | 'retry' | 'busy' | 'unavailable';

/**
 * The public sign-up routes: the page, what it shows about a link, the start of Google sign-in and its callback. Not
 * behind the owner guard (the visitor has no session yet): each is rate-limited per address, the link ones per link too,
 * and a link that does not work is never told apart from another.
 */
export function mountSignupRoutes(router: Router, d: SignupDeps): void {
  const pending = new PendingSignIns(d.clock);
  const perIp = new RateLimiter({ ...(d.limits?.perIp ?? SIGNIN_LIMIT), clock: d.clock });
  const perToken = new RateLimiter({ ...(d.limits?.perToken ?? SIGNUP_TOKEN_LIMIT), clock: d.clock });
  const base = d.publicUrl.replace(/\/+$/, '');
  const invites = { db: d.db, clock: d.clock };
  const page = (note?: SignupNote, token?: string) => {
    const q = new URLSearchParams();
    if (token) q.set('invite', token);
    if (note) q.set('error', note);
    const s = q.toString();
    return `/signup${s ? `?${s}` : ''}`;
  };
  const redirect = (res: ServerResponse, location: string, cookie?: string) => {
    res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', ...(cookie ? { 'Set-Cookie': cookie } : {}) }).end();
  };
  /**
   * False (and the answer sent) when this address, or for a sign-in attempt (`attempt`) this link, is over its limit.
   * Opening the page again costs a link nothing.
   */
  const allowed = (ctx: RequestContext, token: string | null, html: boolean, attempt = false): boolean => {
    const ip = clientAddress(ctx.req);
    const hash = inviteTokenHash(token);
    if (perIp.take(ip) && (!attempt || perToken.take(hash ?? 'malformed'))) return true;
    if (html) redirect(ctx.res, page('busy', hash ? token! : undefined));
    else sendError(ctx.res, 429, 'rate_limited', 'Too many tries. Wait a few minutes and try again.');
    return false;
  };
  const audit = async (event: string, detail: string, requestId: string) => {
    try {
      await platformAudit(d.db, { at: d.clock.now().toISOString(), actor: 'visitor', event, detail, requestId });
    } catch (e) {
      d.log.warn({ code: (e as Error | null)?.name ?? 'Error', requestId }, 'sign-up audit line could not be written');
    }
  };

  // The page. The invite stays in the address (it works once anyway); no Referer leaves the page, so it goes nowhere.
  router.get('/signup', async ({ res }) => {
    const body = await readFile(join(d.publicDir ?? PUBLIC_DIR, SIGNUP_PAGE));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }).end(body);
  });

  // What the page shows: the business and who invited them, or 404 for any link that does not work.
  router.get('/signup/api/invite', async (ctx) => {
    const token = ctx.url.searchParams.get('invite');
    if (!allowed(ctx, token, false)) return;
    const info = await inviteForSignup(invites, token);
    if (!info || !d.google) return sendError(ctx.res, 404, d.google ? 'invalid' : 'unavailable', d.google ? 'This invite link does not work any more. Ask for a new one.' : 'Sign-up is not available yet.');
    sendJson(ctx.res, 200, { business: info.business, founderName: d.founderName, expiresAt: info.expiresAt });
  });

  // Continue with Google: a sign-in in flight (state, nonce, PKCE), keyed by a cookie only /signup sees.
  router.get('/signup/google', async (ctx) => {
    const token = ctx.url.searchParams.get('invite');
    if (!allowed(ctx, token, true, true)) return;
    if (!d.google) return redirect(ctx.res, page('unavailable'));
    if (!(await inviteForSignup(invites, token))) return redirect(ctx.res, page('invalid'));
    let started: ReturnType<PendingSignIns['add']>;
    try {
      // PendingSignIns keeps returnTo as given: here it carries the invite, which never leaves the server.
      started = pending.add({ redirectUri: `${base}/signup/callback`, returnTo: token!, client: clientAddress(ctx.req) });
    } catch {
      return redirect(ctx.res, page('busy', token!));
    }
    const cookie = serializeCookie(SIGNUP_COOKIE, started.key, { httpOnly: true, sameSite: 'Lax', path: '/signup', maxAge: 600, secure: d.secure(ctx.req) });
    redirect(ctx.res, authorizeUrl({ clientId: d.google.clientId, redirectUri: `${base}/signup/callback`, state: started.state, nonce: started.nonce, challenge: started.challenge }), cookie);
  });

  // Back from Google: the invite is redeemed only for Google's verified email, and only when it is the invited one.
  router.get('/signup/callback', async (ctx) => {
    if (!allowed(ctx, null, true)) return;
    const clear = serializeCookie(SIGNUP_COOKIE, '', { httpOnly: true, sameSite: 'Lax', path: '/signup', maxAge: 0, secure: d.secure(ctx.req) });
    const key = parseCookies(ctx.req.headers.cookie)[SIGNUP_COOKIE];
    let p: Pending;
    try {
      p = pending.take(key, ctx.url.searchParams.get('state'));
    } catch {
      await audit('signup.failed', 'no_pending', ctx.requestId);
      return redirect(ctx.res, page('retry'), clear);
    }
    const token = p.returnTo;
    const code = ctx.url.searchParams.get('code');
    if (!d.google || !code || ctx.url.searchParams.has('error')) {
      await audit('signup.failed', 'no_code', ctx.requestId);
      return redirect(ctx.res, page('retry', token), clear);
    }
    let who: { email: string; name?: string };
    try {
      const idToken = await d.google.exchange({ code, verifier: p.verifier, redirectUri: p.redirectUri });
      who = checkClaims(await d.google.verify(idToken), { clientId: d.google.clientId, nonce: p.nonce, now: d.clock.now().getTime() });
    } catch (e) {
      // An email Google has not verified is never matched: the page says only that the account is not the invited one.
      if (e instanceof SignInRefused) {
        await audit('signup.wrong_account', 'unverified', ctx.requestId);
        return redirect(ctx.res, page('wrong_account', token), clear);
      }
      await audit('signup.failed', e instanceof SignInError ? e.code : 'google', ctx.requestId);
      return redirect(ctx.res, page('retry', token), clear);
    }
    const r = await redeemInvite(invites, { token, email: who.email, name: who.name ?? null, requestId: ctx.requestId });
    if (!r.ok) return redirect(ctx.res, r.reason === 'wrong_account' ? page('wrong_account', token) : page('invalid'), clear);
    await d.startSession(ctx, { email: who.email, ...(who.name ? { name: who.name } : {}), tenantId: r.tenantId, userId: r.userId });
    d.log.info({ requestId: ctx.requestId }, 'sign-up: an invite was used');
    redirect(ctx.res, '/dashboard/onboarding', clear);
  });
}
