import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  checkAccountLabel, createOAuthClient, DRIVE_SCOPES, MAIN_ACCOUNT, MEETING_SCOPES, meetingAccounts, requestedScopes, type ConsentClient,
} from '../../output/googleAuth.ts';
import type { GoogleAuthHub, OAuthCredentials } from '../../output/googleAuthHub.ts';
import type { Db } from '../../store/db.ts';
import { systemClock, type Clock } from '../../util/clock.ts';
import type { Logger } from '../../util/logger.ts';
import { fail, ok, type ApiError, type ApiResult, type AuditFn, type OwnerContext } from './context.ts';

// Reconnecting or adding a Google account from the dashboard (D3 task 6), unmounted. The same safeguards as
// `google-auth`: PKCE, a random one-use state, offline access with consent, and a refusal when Google gives no refresh
// token or leaves out a required scope. It uses the dashboard's web OAuth client; the new token is stored by the hub
// (encrypted, as before) and the account's client is replaced in place. A pending sign-in belongs to the owner session
// that started it. No token, code or verifier is ever logged, audited or returned.

const PENDING_TTL_MS = 10 * 60_000;
/** Pending sign-ins one session may hold at once. */
const PENDING_PER_SESSION = 5;
export const CALLBACK_PATH = '/dashboard/connect/google/callback';
const DONE_PATH = '/dashboard/connections';

const ConnectBody = z
  .object({ account: z.union([z.string().min(1).max(20), z.object({ add: z.string().min(1).max(20) }).strict()]) })
  .strict();

interface Pending {
  sessionId: string;
  label: string;
  isNew: boolean;
  verifier: string | undefined;
  scopes: readonly string[];
  expiresAt: number;
}

/** A redirect for the callback; the mounting code sends `302 Location`. */
export interface RedirectResult {
  status: 302;
  location: string;
}

export interface GoogleConnectDeps {
  db: Db;
  hub: GoogleAuthHub;
  /** DASHBOARD_PUBLIC_URL (no trailing slash needed): the callback is registered under it with Google. */
  publicUrl: string;
  /** The dashboard's web OAuth client; undefined when it is not set up on the Mac. */
  web: OAuthCredentials | undefined;
  meetingsEnabled: boolean;
  audit: AuditFn;
  log: Logger;
  clock?: Clock;
  /** Test seam: the OAuth client for this redirect. */
  createClient?: (redirectUri: string) => ConsentClient;
}

export class GoogleConnectRoutes {
  readonly #d: GoogleConnectDeps;
  readonly #clock: Clock;
  readonly #pending = new Map<string, Pending>();

  constructor(d: GoogleConnectDeps) {
    this.#d = d;
    this.#clock = d.clock ?? systemClock;
  }

  get #redirectUri(): string {
    return `${this.#d.publicUrl.replace(/\/+$/, '')}${CALLBACK_PATH}`;
  }

  #client(): ConsentClient {
    const web = this.#d.web!;
    return this.#d.createClient?.(this.#redirectUri) ?? (createOAuthClient(web.clientId, web.clientSecret, this.#redirectUri) as unknown as ConsentClient);
  }

  /** POST /dashboard/api/google/connect, body { account: 'main' | <label> | { add: <label> } }. Returns Google's consent URL. */
  async connect(ctx: OwnerContext, body: unknown): Promise<ApiResult<{ url: string } | ApiError>> {
    const parsed = ConnectBody.safeParse(body);
    if (!parsed.success) return fail(400, 'invalid', 'Choose the account to connect.');
    if (!this.#d.web) return fail(503, 'not_configured', 'The dashboard Google client is not set up on the Mac.');
    const a = parsed.data.account;
    let label: string;
    let isNew = false;
    try {
      if (typeof a === 'string') {
        label = a === MAIN_ACCOUNT ? MAIN_ACCOUNT : checkAccountLabel(a);
        if (label !== MAIN_ACCOUNT && !meetingAccounts(this.#d.db).includes(label)) return fail(404, 'not_found', `There is no Google account named ${label}.`);
      } else {
        label = checkAccountLabel(a.add.trim());
        if (meetingAccounts(this.#d.db).includes(label)) return fail(409, 'exists', `A Google account named ${label} is already connected.`);
        isNew = true;
      }
    } catch (e) {
      return fail(400, 'invalid_label', (e as Error).message);
    }
    const scopes = label === MAIN_ACCOUNT ? requestedScopes({ MEETINGS_ENABLED: this.#d.meetingsEnabled }) : [...MEETING_SCOPES];
    this.#prune();
    const mine = [...this.#pending.entries()].filter(([, p]) => p.sessionId === ctx.sessionId);
    while (mine.length >= PENDING_PER_SESSION) this.#pending.delete(mine.shift()![0]); // the oldest first
    const state = randomBytes(16).toString('hex');
    const client = this.#client();
    const pkce = await client.generateCodeVerifierAsync();
    // PKCE is required, never skipped silently.
    if (!pkce.codeVerifier || !pkce.codeChallenge) return fail(503, 'unavailable', 'Google sign-in could not be started. Try again.');
    const url = client.generateAuthUrl({
      access_type: 'offline', prompt: 'consent', scope: [...scopes], state, code_challenge_method: 'S256', code_challenge: pkce.codeChallenge,
    });
    this.#pending.set(state, {
      sessionId: ctx.sessionId, label, isNew, verifier: pkce.codeVerifier, scopes, expiresAt: this.#clock.now().getTime() + PENDING_TTL_MS,
    });
    return ok({ url });
  }

  /**
   * GET /dashboard/connect/google/callback?state=&code= (or &error=). Always a redirect to Connections: with
   * ?connected=<label> on success, or ?google_error=<code> (state, denied, exists, not_found, exchange, no_refresh_token,
   * missing_scope, save). A state that is unknown, expired, used or another session's is refused.
   */
  async callback(ctx: OwnerContext, params: { state?: string | null; code?: string | null; error?: string | null }): Promise<RedirectResult> {
    const refuse = (code: string): RedirectResult => ({ status: 302, location: `${DONE_PATH}?google_error=${code}` });
    this.#prune();
    const state = params.state ?? '';
    const pending = this.#pending.get(state);
    // Another session's state is refused and left in place for its owner.
    if (!pending || pending.sessionId !== ctx.sessionId) return refuse('state');
    this.#pending.delete(state); // one use
    if (params.error || !params.code) return refuse('denied');
    // The account list may have changed since connect (another tab, or the CLI): an add must still be new, and a
    // reconnect must still have its account. Otherwise a live account's token could be overwritten, or a removed one revived.
    if (pending.label !== MAIN_ACCOUNT) {
      const listed = meetingAccounts(this.#d.db).includes(pending.label);
      if (pending.isNew && listed) return refuse('exists');
      if (!pending.isNew && !listed) return refuse('not_found');
    }
    let tokens: { refresh_token?: string | null; scope?: string };
    try {
      ({ tokens } = await this.#client().getToken({ code: params.code, codeVerifier: pending.verifier }));
    } catch (err) {
      // Google's error text can echo request details: only the type is logged.
      this.#d.log.warn({ account: pending.label, code: (err as Error | null)?.name ?? 'Error' }, 'Google sign-in code could not be exchanged');
      return refuse('exchange');
    }
    if (!tokens.refresh_token) return refuse('no_refresh_token');
    const scope = tokens.scope ?? '';
    const granted = new Set(scope.split(' '));
    const required = pending.label === MAIN_ACCOUNT ? [...DRIVE_SCOPES, ...pending.scopes] : pending.scopes;
    if (!required.every((s) => granted.has(s))) return refuse('missing_scope');
    try {
      this.#d.hub.setToken(pending.label, tokens.refresh_token, 'web', scope);
    } catch (err) {
      this.#d.log.error({ account: pending.label, code: (err as Error | null)?.name ?? 'Error' }, 'reconnected Google account could not be saved');
      return refuse('save');
    }
    this.#d.audit({
      actor: ctx.actor, kind: 'connection', requestId: ctx.requestId,
      event: pending.isNew ? `Google account added · ${pending.label}` : `Google account reconnected · ${pending.label}`,
    });
    return { status: 302, location: `${DONE_PATH}?connected=${encodeURIComponent(pending.label)}` };
  }

  #prune(): void {
    const now = this.#clock.now().getTime();
    for (const [state, p] of this.#pending) if (p.expiresAt <= now) this.#pending.delete(state);
  }
}
