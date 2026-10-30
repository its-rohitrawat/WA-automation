import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import type { Clock } from '../util/clock.ts';
import { UNSAFE_TEXT } from './sessions.ts';

/** Google's sign-in page (OpenID Connect authorization endpoint). */
export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
/** Where a sign-in code is exchanged for the ID token. */
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** The only issuers a Google ID token may name. */
export const GOOGLE_ISSUERS: readonly string[] = ['accounts.google.com', 'https://accounts.google.com'];
/** Sign-in asks for who the person is and nothing else. */
export const SIGNIN_SCOPES = 'openid email profile';
/** The short cookie that ties Google's redirect back to the browser that started the sign-in. */
export const SIGNIN_COOKIE = 'wa_signin';
/** A started sign-in must come back within 10 minutes. */
export const PENDING_TTL_MS = 10 * 60_000;
/**
 * At most this many sign-ins wait at once (each under 0.5 KB, so a few MB at worst). When full, a new sign-in is
 * refused (`busy`) rather than dropping one in flight, so a flood of anonymous logins cannot push out the owner's.
 */
export const PENDING_MAX = 10_000;
/** At most this many sign-ins wait per client (rate-limit key); a client's next one drops its own oldest. */
export const PENDING_PER_CLIENT = 5;
/** The dashboard's screens, as in the approved design: `/dashboard/<screen>`. */
export const DASHBOARD_SCREENS: readonly string[] = Object.freeze([
  'overview',
  'clients',
  'tasks',
  'meetings',
  'activity',
  'tracker',
  'connections',
  'usage',
  'automations',
  'audit',
  'settings',
  // The founder's platform screens (SaaS S5); the shell shows them only when the platform is on.
  'customers',
  'invite',
  // A customer's Getting started (SaaS S5, S4.8): the shell shows it to customer sessions only.
  'onboarding',
]);
const NAME_MAX = 80;

/** Why a sign-in failed. Only this code is logged, never Google's text or any token. */
export type SignInFailure =
  | 'no_pending'
  | 'state_mismatch'
  | 'expired'
  | 'google_error'
  | 'no_code'
  | 'token_exchange'
  | 'no_id_token'
  | 'id_token_invalid'
  | 'issuer'
  | 'audience'
  | 'token_expired'
  | 'nonce'
  | 'no_email'
  | 'busy';

/** A sign-in that went wrong (not a refused person): the page shows a plain "try again". */
export class SignInError extends Error {
  readonly code: SignInFailure;
  constructor(code: SignInFailure) {
    super(`sign-in failed: ${code}`);
    this.name = 'SignInError';
    this.code = code;
  }
}

/** A real Google account that may not open the dashboard. `email` is lower-cased and must only be shown masked. */
export class SignInRefused extends Error {
  readonly reason: 'unverified' | 'not_owner';
  readonly email: string;
  constructor(reason: 'unverified' | 'not_owner', email: string) {
    super(`sign-in refused: ${reason}`);
    this.name = 'SignInRefused';
    this.reason = reason;
    this.email = email;
  }
}

/** The claims read from a verified Google ID token. Typed loosely: every one is checked before use. */
export interface IdClaims {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  nonce?: unknown;
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
}

/** Checks an ID token's signature (production: Google's keys) and returns its claims; rejects anything else. */
export type IdTokenVerifier = (idToken: string) => Promise<IdClaims>;
/** Exchanges a sign-in code (with its PKCE verifier) for the ID token. Rejects with a `SignInError`. */
export type CodeExchanger = (o: { code: string; verifier: string; redirectUri: string }) => Promise<string>;

/** 32 random bytes in base64url (43 characters). */
function token(): string {
  return randomBytes(32).toString('base64url');
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Where to go after signing in: `/dashboard`, `/dashboard/<known screen>` or `/dashboard/clients/groups`, exactly.
 * Anything else (another site, `//host`, dot segments, unknown screens, a search string) becomes `/dashboard`.
 */
export function safeReturnPath(raw: string | null | undefined): string {
  if (raw === '/dashboard/clients/groups') return raw;
  const m = raw === null || raw === undefined ? null : /^\/dashboard\/([a-z]+)$/.exec(raw);
  if (m !== null && DASHBOARD_SCREENS.includes(m[1]!)) return raw!;
  return '/dashboard';
}

export interface Pending {
  state: string;
  nonce: string;
  /** The PKCE code verifier: stays on the server, only its S256 challenge goes to Google. */
  verifier: string;
  redirectUri: string;
  returnTo: string;
  createdAt: number;
  /** The client (rate-limit key) that started it, for the per-client cap. */
  client?: string;
}

/**
 * Sign-ins that went to Google and have not come back, in memory only. Each is keyed by the random value in the
 * browser's `wa_signin` cookie, lives 10 minutes and is used once: `take` removes it whatever the outcome.
 */
export class PendingSignIns {
  readonly #clock: Clock;
  readonly #ttlMs: number;
  readonly #max: number;
  readonly #perClient: number;
  readonly #map = new Map<string, Pending>();

  constructor(clock: Clock, o: { ttlMs?: number; max?: number; perClient?: number } = {}) {
    this.#clock = clock;
    this.#ttlMs = o.ttlMs ?? PENDING_TTL_MS;
    this.#max = o.max ?? PENDING_MAX;
    this.#perClient = o.perClient ?? PENDING_PER_CLIENT;
  }

  /**
   * Starts one: returns the cookie key, and the state, nonce and S256 challenge for Google's page. Expired records are
   * dropped first, then this client's own oldest past its cap. If the map is still full, throws `SignInError('busy')`:
   * a sign-in in flight is never dropped to make room for someone else's.
   */
  add(o: { redirectUri: string; returnTo: string; client?: string }): { key: string; state: string; nonce: string; challenge: string } {
    const now = this.#clock.now().getTime();
    const mine: string[] = [];
    for (const [k, p] of this.#map) {
      if (now - p.createdAt > this.#ttlMs) this.#map.delete(k);
      else if (o.client !== undefined && p.client === o.client) mine.push(k);
    }
    // Insertion order is oldest first.
    while (mine.length >= this.#perClient) this.#map.delete(mine.shift()!);
    if (this.#map.size >= this.#max) throw new SignInError('busy');
    const key = token();
    const p: Pending = { state: token(), nonce: token(), verifier: token(), redirectUri: o.redirectUri, returnTo: o.returnTo, createdAt: now };
    if (o.client !== undefined) p.client = o.client;
    this.#map.set(key, p);
    return { key, state: p.state, nonce: p.nonce, challenge: createHash('sha256').update(p.verifier).digest('base64url') };
  }

  /** The sign-in this cookie started, if `state` matches and it is under 10 minutes old. Used up either way. */
  take(key: string | undefined, state: string | null | undefined): Pending {
    const p = key === undefined ? undefined : this.#map.get(key);
    if (p === undefined) throw new SignInError('no_pending');
    this.#map.delete(key!);
    if (this.#clock.now().getTime() - p.createdAt > this.#ttlMs) throw new SignInError('expired');
    if (typeof state !== 'string' || !sameText(state, p.state)) throw new SignInError('state_mismatch');
    return p;
  }

  size(): number {
    return this.#map.size;
  }
}

/** Google's sign-in page for this attempt: OpenID Connect code flow with PKCE (S256) and the account picker. */
export function authorizeUrl(o: { clientId: string; redirectUri: string; state: string; nonce: string; challenge: string }): string {
  const q = new URLSearchParams({
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    response_type: 'code',
    scope: SIGNIN_SCOPES,
    prompt: 'select_account',
    state: o.state,
    nonce: o.nonce,
    code_challenge: o.challenge,
    code_challenge_method: 'S256',
  });
  return `${GOOGLE_AUTHORIZE_URL}?${q.toString()}`;
}

/** One plain line, or undefined. */
function cleanName(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const one = v.replace(UNSAFE_TEXT, ' ').replace(/\s+/g, ' ').trim();
  return one === '' ? undefined : one.slice(0, NAME_MAX).trimEnd();
}

/**
 * The checks on a verified ID token's claims: Google issuer, our client as the audience, not expired, the nonce of
 * this sign-in, an email, and that email verified. Returns the lower-cased email and a display name.
 */
export function checkClaims(c: IdClaims, o: { clientId: string; nonce: string; now: number }): { email: string; name?: string } {
  if (typeof c.iss !== 'string' || !GOOGLE_ISSUERS.includes(c.iss)) throw new SignInError('issuer');
  if (typeof c.aud !== 'string' || c.aud !== o.clientId) throw new SignInError('audience');
  if (typeof c.exp !== 'number' || !(c.exp * 1000 > o.now)) throw new SignInError('token_expired');
  if (typeof c.nonce !== 'string' || !sameText(c.nonce, o.nonce)) throw new SignInError('nonce');
  if (typeof c.email !== 'string' || c.email.trim() === '') throw new SignInError('no_email');
  const email = c.email.trim().toLowerCase();
  if (c.email_verified !== true) throw new SignInRefused('unverified', email);
  const name = cleanName(c.name);
  return name === undefined ? { email } : { email, name };
}

/**
 * `st••••@gmail.com`: the first characters and the domain, for the audit log of a refused sign-in. A short name keeps
 * fewer (two from 4 characters up, one for 2-3, none for 1), so no address is ever shown whole.
 */
export function maskEmail(email: string): string {
  const clean = email.replace(UNSAFE_TEXT, '').trim().toLowerCase();
  const at = clean.lastIndexOf('@');
  if (at < 0) return '••••';
  const local = Array.from(clean.slice(0, at));
  const keep = local.length > 3 ? 2 : local.length > 1 ? 1 : 0;
  const head = local.slice(0, keep).join('');
  return `${head}••••@${clean.slice(at + 1).slice(0, 100)}`;
}

/** A short label for the audit log and the session, such as "Edge on Windows". Never the raw User-Agent. */
export function browserLabel(ua: string | undefined): string {
  if (ua === undefined || ua === '') return 'A browser';
  const browser = /\bEdg(e|A|iOS)?\//.test(ua)
    ? 'Edge'
    : /\b(OPR|Opera)\//.test(ua)
      ? 'Opera'
      : /\b(Firefox|FxiOS)\//.test(ua)
        ? 'Firefox'
        : /\b(Chrome|CriOS|Chromium)\//.test(ua)
          ? 'Chrome'
          : /\bSafari\//.test(ua)
            ? 'Safari'
            : 'A browser';
  const os = /\biPhone\b/.test(ua)
    ? 'iPhone'
    : /\biPad\b/.test(ua)
      ? 'iPad'
      : /\bAndroid\b/.test(ua)
        ? 'Android'
        : /\bWindows\b/.test(ua)
          ? 'Windows'
          : /\bCrOS\b/.test(ua)
            ? 'ChromeOS'
            : /\b(Macintosh|Mac OS X)\b/.test(ua)
              ? 'Mac'
              : /\bLinux\b/.test(ua)
                ? 'Linux'
                : undefined;
  return os === undefined ? browser : `${browser} on ${os}`;
}

/**
 * Production code exchange: posts the code, the PKCE verifier and the web client's id and secret to Google's token
 * endpoint and keeps only the ID token (the access token is dropped). Google's reply text is never echoed.
 */
export function googleCodeExchanger(o: { clientId: string; clientSecret: string; tokenUrl?: string; timeoutMs?: number }): CodeExchanger {
  const url = o.tokenUrl ?? GOOGLE_TOKEN_URL;
  return async ({ code, verifier, redirectUri }) => {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          client_id: o.clientId,
          client_secret: o.clientSecret,
          redirect_uri: redirectUri,
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
      });
    } catch {
      throw new SignInError('token_exchange');
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new SignInError('token_exchange');
    }
    if (!res.ok) throw new SignInError('token_exchange');
    const idToken = (body as { id_token?: unknown } | null)?.id_token;
    if (typeof idToken !== 'string' || idToken === '') throw new SignInError('no_id_token');
    return idToken;
  };
}

/**
 * Production ID-token check with google-auth-library: Google's signature, issuer, audience (our client id) and
 * expiry. The caller still checks the claims (`checkClaims`), including the nonce.
 */
export function googleIdVerifier(clientId: string): IdTokenVerifier {
  const client = new OAuth2Client({ clientId });
  return async (idToken) => {
    const ticket = await client.verifyIdToken({ idToken, audience: clientId });
    const payload = ticket.getPayload();
    if (payload === undefined) throw new SignInError('id_token_invalid');
    return payload;
  };
}
