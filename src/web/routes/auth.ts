import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Clock } from '../../util/clock.ts';
import type { Logger } from '../../util/logger.ts';
import type { AuditLog } from '../audit.ts';
import type { Guard, RateLimiter } from '../guard.ts';
import { parseCookies, sendJson, serializeCookie } from '../http.ts';
import type { RequestContext, Router } from '../router.ts';
import {
  authorizeUrl,
  browserLabel,
  checkClaims,
  maskEmail,
  PENDING_TTL_MS,
  PendingSignIns,
  safeReturnPath,
  SIGNIN_COOKIE,
  SignInError,
  SignInRefused,
} from '../oidc.ts';
import type { CodeExchanger, IdTokenVerifier } from '../oidc.ts';
import { clearSessionCookie, csrfFor, hashToken, SESSION_COOKIE, sessionCookie } from '../sessions.ts';
import type { SessionStore } from '../sessions.ts';

/** The sign-out route (POST only, CSRF-checked). */
export const SIGN_OUT_PATH = '/dashboard/auth/logout';
const CALLBACK_PATH = '/dashboard/auth/callback';
const NAMES_MAX = 100;
const CODE_MAX = 2048;

export interface AuthRouteDeps {
  router: Router;
  sessions: SessionStore;
  guard: Guard;
  audit: AuditLog;
  log: Logger;
  clock: Clock;
  /** DASHBOARD_OWNER_EMAILS (lower-cased). */
  ownerEmails: readonly string[];
  /** DASHBOARD_GOOGLE_CLIENT_ID: the web client sign-in uses. */
  clientId: string;
  /** DASHBOARD_PUBLIC_URL: a bare origin, or absent. */
  publicUrl?: string;
  /** The port the dashboard listens on (for the localhost origins). */
  port: () => number | undefined;
  /** Code to ID token (production: `googleCodeExchanger`). */
  exchange: CodeExchanger;
  /** ID-token signature check (production: `googleIdVerifier`). */
  verifier: IdTokenVerifier;
  /** Sign-in and its callback (SIGNIN_LIMIT). */
  signinLimiter: RateLimiter;
  /** Requests that change something (ACTION_LIMIT): sign-out here. */
  actionLimiter: RateLimiter;
  /** Tests only: the pending sign-ins. */
  pending?: PendingSignIns;
}

function redirect(res: ServerResponse, location: string): void {
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

function signinCookie(value: string, secure: boolean): string {
  return serializeCookie(SIGNIN_COOKIE, value, { httpOnly: true, sameSite: 'Lax', path: '/dashboard/auth', maxAge: value === '' ? 0 : PENDING_TTL_MS / 1000, secure });
}

/**
 * Owner sign-in with Google (OpenID Connect, code flow with PKCE and a nonce), sign-out, and `/dashboard/api/me`.
 * Nothing here logs or returns the sign-in code, Google's tokens, the session id, the CSRF token or a refused email
 * in full: a failure is logged by its code only.
 */
export function registerAuthRoutes(d: AuthRouteDeps): void {
  const pending = d.pending ?? new PendingSignIns(d.clock);
  const owners = new Set(d.ownerEmails.map((e) => e.trim().toLowerCase()));
  const publicOrigin = d.publicUrl === undefined ? undefined : new URL(d.publicUrl).origin;
  // Display names from Google, by session id hash, in memory only (the sessions table has no name column). After a
  // restart, /api/me answers `name: null` until the next sign-in.
  const names = new Map<string, string>();

  /**
   * The origin this browser is using, from an allowlist only: the public address, or this machine's own
   * `http://localhost:<port>` / `http://127.0.0.1:<port>`. An unknown Host gets the public address (else localhost).
   */
  function origin(req: IncomingMessage): string {
    const host = req.headers.host;
    const port = d.port();
    if (publicOrigin !== undefined && host === new URL(publicOrigin).host) return publicOrigin;
    if (port !== undefined && (host === `localhost:${port}` || host === `127.0.0.1:${port}`)) return `http://${host}`;
    return publicOrigin ?? `http://localhost:${port ?? 0}`;
  }

  const isSecure = (o: string) => o.startsWith('https://');

  function remember(sessionId: string, name: string | undefined): void {
    if (name === undefined) return;
    while (names.size >= NAMES_MAX) names.delete(names.keys().next().value!);
    names.set(hashToken(sessionId), name);
  }

  d.router.get('/dashboard/auth/login', (ctx: RequestContext) => {
    const { req, res } = ctx;
    d.signinLimiter.hit(req, res);
    const o = origin(req);
    const redirectUri = `${o}${CALLBACK_PATH}`;
    const p = pending.add({ redirectUri, returnTo: safeReturnPath(ctx.url.searchParams.get('return')) });
    res.setHeader('Set-Cookie', signinCookie(p.key, isSecure(o)));
    redirect(res, authorizeUrl({ clientId: d.clientId, redirectUri, state: p.state, nonce: p.nonce, challenge: p.challenge }));
  });

  d.router.get(CALLBACK_PATH, async (ctx: RequestContext) => {
    const { req, res } = ctx;
    d.signinLimiter.hit(req, res);
    const secure = isSecure(origin(req));
    const cookies = parseCookies(typeof req.headers.cookie === 'string' ? req.headers.cookie : undefined);
    const clearSignin = signinCookie('', secure);
    const label = browserLabel(typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined);
    const q = ctx.url.searchParams;
    try {
      const p = pending.take(cookies[SIGNIN_COOKIE], q.get('state'));
      if (q.has('error')) throw new SignInError('google_error');
      const code = q.get('code');
      if (code === null || code === '' || code.length > CODE_MAX) throw new SignInError('no_code');
      const idToken = await d.exchange({ code, verifier: p.verifier, redirectUri: p.redirectUri });
      let claims;
      try {
        claims = await d.verifier(idToken);
      } catch {
        // The library's message can quote the token itself, so it is dropped here.
        throw new SignInError('id_token_invalid');
      }
      const who = checkClaims(claims, { clientId: d.clientId, nonce: p.nonce, now: d.clock.now().getTime() });
      if (!owners.has(who.email)) throw new SignInRefused('not_owner', who.email);

      // A browser signing in again leaves its earlier session behind: end it.
      const earlier = cookies[SESSION_COOKIE];
      if (earlier !== undefined) {
        d.sessions.destroy(earlier);
        names.delete(hashToken(earlier));
      }
      const s = d.sessions.create(who.email, label);
      remember(s.id, who.name);
      d.audit.record({ actor: who.email, event: 'Signed in', kind: 'auth', detail: label, requestId: ctx.requestId });
      res.setHeader('Set-Cookie', [clearSignin, sessionCookie(s.id, { secure })]);
      redirect(res, p.returnTo);
    } catch (err) {
      res.setHeader('Set-Cookie', clearSignin);
      if (err instanceof SignInRefused) {
        const masked = maskEmail(err.email);
        const why = err.reason === 'unverified' ? 'email not verified' : 'not on the owner list';
        d.audit.record({ actor: masked, event: 'Sign-in refused', kind: 'auth', detail: `${masked}, ${why}, ${label}`, requestId: ctx.requestId });
        d.log.warn({ rid: ctx.requestId, code: err.reason }, 'dashboard sign-in refused');
        redirect(res, '/dashboard?denied=1');
        return;
      }
      const code = err instanceof SignInError ? err.code : 'internal';
      d.log.warn({ rid: ctx.requestId, code }, 'dashboard sign-in failed');
      redirect(res, '/dashboard?error=signin');
    }
  });

  d.router.post(SIGN_OUT_PATH, (ctx: RequestContext) => {
    const { req, res } = ctx;
    d.actionLimiter.hit(req, res);
    const s = d.guard.requireOwner(req);
    d.guard.requireCsrf(req, s);
    d.sessions.destroy(s.id);
    names.delete(hashToken(s.id));
    const label = browserLabel(typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined);
    d.audit.record({ actor: s.email, event: 'Signed out', kind: 'auth', detail: label, requestId: ctx.requestId });
    res.statusCode = 204;
    res.setHeader('Set-Cookie', clearSessionCookie({ secure: isSecure(origin(req)) }));
    res.setHeader('Cache-Control', 'no-store');
    res.end();
  });

  d.router.get('/dashboard/api/me', (ctx: RequestContext) => {
    const s = d.guard.requireOwner(ctx.req);
    sendJson(ctx.res, 200, {
      email: s.email,
      name: names.get(hashToken(s.id)) ?? null,
      signedInAt: s.createdAt,
      expiresAt: s.expiresAt,
      csrf: csrfFor(s.id),
    });
  });
}
