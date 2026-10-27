import { hkdfSync, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { auth } from '@googleapis/drive';
import type { Env } from '../config/env.ts';
import { decrypt, encrypt } from '../crypto/envelope.ts';
import { tx, type Db } from '../store/db.ts';
import { deleteKv, getKv, setKv } from '../store/kv.ts';

/** Only files this app creates. */
export const DRIVE_SCOPES: readonly string[] = ['https://www.googleapis.com/auth/drive.file'];

/** Phase 3, read only: Meet recordings, the Calendar invite behind each, and the recording files Meet put in Drive. No Gmail. */
export const MEETING_SCOPES: readonly string[] = [
  'https://www.googleapis.com/auth/meetings.space.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/drive.meet.readonly',
];

const SCOPE_NAMES: Record<string, string> = {
  'https://www.googleapis.com/auth/drive.file': 'Google Drive (only the files WA Agent creates)',
  'https://www.googleapis.com/auth/meetings.space.readonly': 'Google Meet recordings list (read only)',
  'https://www.googleapis.com/auth/calendar.events.readonly': 'Calendar invites (read only)',
  'https://www.googleapis.com/auth/drive.meet.readonly': 'Meet files in Drive (read only)',
};

/** A scope in plain words, for the operator. */
export function scopeName(scope: string): string {
  return SCOPE_NAMES[scope] ?? scope;
}

/** What google-auth asks for: Drive always, the meeting scopes only when meetings are on. */
export function requestedScopes(env: Pick<Env, 'MEETINGS_ENABLED'>): string[] {
  return env.MEETINGS_ENABLED ? [...DRIVE_SCOPES, ...MEETING_SCOPES] : [...DRIVE_SCOPES];
}

/**
 * The main sign-in has no label in kv: it owns the Drive tree and, with meetings on, finds its own meetings. Extra
 * accounts (`google-auth --account <label>`) only find and read Meet recordings; each has its own token and scopes.
 */
export const MAIN_ACCOUNT = 'main';
const ACCOUNT_LABEL = /^[a-z0-9][a-z0-9-]{0,19}$/;
const ACCOUNTS_KEY = 'google_meeting_accounts';

/** A label is checked before it goes into a kv key: 1-20 lower-case letters, digits or '-', and never 'main'. */
export function checkAccountLabel(label: string): string {
  if (!ACCOUNT_LABEL.test(label) || label === MAIN_ACCOUNT) {
    throw new Error("The account name must be 1-20 lower-case letters, digits or '-', not 'main'. For example: company2");
  }
  return label;
}

/** The extra meeting accounts, in the order they were added. */
export function meetingAccounts(db: Db): string[] {
  try {
    const v: unknown = JSON.parse(getKv(db, ACCOUNTS_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((l): l is string => typeof l === 'string' && ACCOUNT_LABEL.test(l) && l !== MAIN_ACCOUNT) : [];
  } catch {
    return [];
  }
}

function setMeetingAccounts(db: Db, labels: string[]): void {
  setKv(db, ACCOUNTS_KEY, JSON.stringify(labels));
}

// The scopes Google granted with the stored token, as Google wrote them. Not a secret.
const SCOPES_KEY = 'google_scopes';
const scopesKey = (account?: string): string => (account === undefined ? SCOPES_KEY : `${SCOPES_KEY}:${checkAccountLabel(account)}`);

export function saveGrantedScopes(db: Db, scope: string, account?: string): void {
  setKv(db, scopesKey(account), scope);
}

/**
 * True only when the sign-in (the main one, or the extra account) recorded every meeting scope. A token from before
 * Phase 3 has none recorded: Drive only.
 */
export function hasMeetingScopes(db: Db, account?: string): boolean {
  const granted = new Set((getKv(db, scopesKey(account)) ?? '').split(' '));
  return MEETING_SCOPES.every((s) => granted.has(s));
}

/** Meetings can run: the main sign-in or at least one extra account has every meeting scope. */
export function meetingsReady(db: Db): boolean {
  return hasMeetingScopes(db) || meetingAccounts(db).some((a) => hasMeetingScopes(db, a));
}

/**
 * Which OAuth client issued an account's refresh token (D3): 'desktop' (google-auth on the Mac) or 'web' (the
 * dashboard). Kept in kv google_client:<label> ('main' for the main sign-in); missing means desktop.
 */
export type TokenIssuer = 'desktop' | 'web';

export function tokenIssuerKey(label: string): string {
  return `google_client:${label === MAIN_ACCOUNT ? MAIN_ACCOUNT : checkAccountLabel(label)}`;
}

export function saveTokenIssuer(db: Db, label: string, issuer: TokenIssuer): void {
  setKv(db, tokenIssuerKey(label), issuer);
}

/**
 * Stores an extra account's sign-in: its token, its scopes, its place in the list and the client that issued it, all
 * or nothing. The issuer defaults to desktop (google-auth); a stale 'web' from an earlier dashboard reconnect would
 * pair this token with the wrong client.
 */
export function saveMeetingAccount(db: Db, key: Buffer, label: string, refreshToken: string, scope: string, issuer: TokenIssuer = 'desktop'): void {
  checkAccountLabel(label);
  tx(db, () => {
    new TokenStore(db, key, label).save(refreshToken);
    saveGrantedScopes(db, scope, label);
    saveTokenIssuer(db, label, issuer);
    const labels = meetingAccounts(db);
    if (!labels.includes(label)) setMeetingAccounts(db, [...labels, label]);
  });
}

/** Forgets an extra account here (its token, scopes and list entry). Google keeps the grant until it is removed there. */
export function removeMeetingAccount(db: Db, label: string): boolean {
  checkAccountLabel(label);
  const labels = meetingAccounts(db);
  if (!labels.includes(label)) return false;
  tx(db, () => {
    deleteKv(db, tokenKey(label));
    deleteKv(db, scopesKey(label));
    deleteKv(db, tokenIssuerKey(label));
    setMeetingAccounts(db, labels.filter((l) => l !== label));
  });
  return true;
}

export type OAuth2Client = InstanceType<typeof auth.OAuth2>;

export function createOAuthClient(clientId: string, clientSecret: string, redirectUri?: string): OAuth2Client {
  return new auth.OAuth2(clientId, clientSecret, redirectUri);
}

const TOKEN_KEY = 'google_refresh_token';
/** The main token keeps its pre-multi-account key; an extra account's is `google_refresh_token:<label>`. */
const tokenKey = (account?: string): string => (account === undefined ? TOKEN_KEY : `${TOKEN_KEY}:${checkAccountLabel(account)}`);

export class TokenDecryptError extends Error {
  constructor(options?: { cause?: unknown; account?: string }) {
    const command = options?.account === undefined ? 'google-auth' : `google-auth --account ${options.account}`;
    super(`Stored Google sign-in cannot be read with this PC's key. Run: npm run cli -- ${command}`, options);
    this.name = 'TokenDecryptError';
  }
}

export class TokenStore {
  readonly #db: Db;
  readonly #key: Buffer;
  readonly #account: string | undefined;
  readonly #kvKey: string;
  /** The kv key is the AAD, so one account's token never opens as another's. */
  readonly #aad: Buffer;

  /** No account: the main sign-in. */
  constructor(db: Db, key: Buffer, account?: string) {
    this.#db = db;
    // A purpose-specific key, so the master key itself never encrypts the token directly.
    this.#key = Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), 'google-refresh-token', 32));
    this.#account = account;
    this.#kvKey = tokenKey(account);
    this.#aad = Buffer.from(this.#kvKey);
  }

  save(refreshToken: string): void {
    setKv(this.#db, this.#kvKey, encrypt(this.#key, Buffer.from(refreshToken, 'utf8'), this.#aad).toString('base64'));
  }

  load(): string | undefined {
    const v = getKv(this.#db, this.#kvKey);
    if (!v) return undefined;
    try {
      return decrypt(this.#key, Buffer.from(v, 'base64'), this.#aad).toString('utf8');
    } catch (e) {
      throw new TokenDecryptError({ cause: e, ...(this.#account === undefined ? {} : { account: this.#account }) });
    }
  }
}

/**
 * Returns the authorisation code, or undefined when the request is not the redirect (no `state`: a stray local request).
 * Throws when the request is the redirect but failed.
 */
export function parseCallback(requestUrl: string, expectedState: string): string | undefined {
  const url = new URL(requestUrl, 'http://127.0.0.1');
  const state = url.searchParams.get('state');
  if (state === null) return undefined;
  if (state !== expectedState) throw new Error('Sign-in response did not match this request (state mismatch)');
  const error = url.searchParams.get('error');
  if (error) throw new Error(`Google sign-in was cancelled or failed (${error.replace(/[^a-z_]/gi, '').slice(0, 40)})`);
  const code = url.searchParams.get('code');
  if (!code) throw new Error('Sign-in response had no authorisation code');
  return code;
}

const NO_DRIVE_SCOPE = 'Drive access was not granted. Run google-auth again and keep the Google Drive box ticked.';
const NO_REFRESH = 'Google returned no refresh token. Remove WA Agent at myaccount.google.com/permissions and try again.';
const noMeetingScope = (missing: string[]) =>
  `Some meeting permissions were not granted: ${missing.map(scopeName).join(', ')}. Run google-auth again and tick every box Google shows.`;

/** A refusal written here, safe to show, as opposed to Google's own error text. */
class ConsentRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsentRefused';
  }
}

export interface ConsentResult {
  refreshToken: string;
  /** The scopes Google granted, space-separated, as Google wrote them. */
  scope: string;
}

/** The part of the OAuth client the sign-in uses (so tests can inject a fake). */
export interface ConsentClient {
  generateCodeVerifierAsync(): Promise<{ codeVerifier?: string; codeChallenge?: string }>;
  generateAuthUrl(opts: { access_type: string; prompt: string; scope: string[]; state: string; code_challenge_method: string; code_challenge?: string }): string;
  getToken(opts: { code: string; codeVerifier?: string }): Promise<{ tokens: { refresh_token?: string | null; scope?: string } }>;
}

/** One-time loopback sign-in with PKCE. Listens on 127.0.0.1 only, for one redirect, then closes. */
export async function runLoopbackConsent(o: {
  clientId: string;
  clientSecret: string;
  scopes: readonly string[];
  showUrl: (url: string) => void;
  timeoutMs?: number;
  /** Default true. False for an extra meetings account, which never gets Drive file access. */
  requireDrive?: boolean;
  /** Test seam: build the OAuth client for the given redirect URI. */
  createClient?: (redirectUri: string) => ConsentClient;
}): Promise<ConsentResult> {
  const state = randomBytes(16).toString('hex');
  const makeClient = o.createClient ?? ((uri: string) => createOAuthClient(o.clientId, o.clientSecret, uri) as unknown as ConsentClient);
  return await new Promise<ConsentResult>((resolve, reject) => {
    let client: ConsentClient | undefined;
    let codeVerifier: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let handled = false;
    let settled = false;
    const server = createServer((req, res) => {
      if (handled || !req.url) {
        res.writeHead(404).end();
        return;
      }
      let code: string | undefined;
      try {
        code = parseCallback(req.url, state);
      } catch (e) {
        handled = true;
        res.writeHead(400, { 'content-type': 'text/plain' }).end('Sign-in failed. Return to the terminal.');
        finish(e as Error);
        return;
      }
      if (code === undefined) {
        res.writeHead(404).end();
        return;
      }
      handled = true;
      res.writeHead(200, { 'content-type': 'text/plain' }).end('Sign-in received. Return to the terminal.');
      client!
        .getToken({ code, codeVerifier })
        .then(({ tokens }) => {
          if (!tokens.refresh_token) throw new ConsentRefused(NO_REFRESH);
          const scope = tokens.scope ?? '';
          const granted = new Set(scope.split(' '));
          if (o.requireDrive !== false && !granted.has(DRIVE_SCOPES[0]!)) throw new ConsentRefused(NO_DRIVE_SCOPE);
          // Every requested scope, or no result at all (so the caller saves nothing).
          const missing = o.scopes.filter((s) => !granted.has(s));
          if (missing.length > 0) throw new ConsentRefused(noMeetingScope(missing));
          finish(null, { refreshToken: tokens.refresh_token, scope });
        })
        // Google's own error text can echo request details, so replace it.
        .catch((e: Error) => finish(e instanceof ConsentRefused ? e : new Error('Google would not exchange the sign-in code')));
    });
    function finish(err: Error | null, result?: ConsentResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      server.closeAllConnections();
      if (err) reject(err);
      else resolve(result!);
    }
    server.on('error', (e) => finish(e));
    timer = setTimeout(() => finish(new Error('Timed out waiting for Google sign-in')), o.timeoutMs ?? 300_000);
    server.listen(0, '127.0.0.1', () => {
      void (async () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        client = makeClient(`http://127.0.0.1:${port}`);
        const pkce = await client.generateCodeVerifierAsync();
        codeVerifier = pkce.codeVerifier;
        o.showUrl(
          client.generateAuthUrl({
            access_type: 'offline',
            prompt: 'consent',
            scope: [...o.scopes],
            state,
            code_challenge_method: 'S256',
            code_challenge: pkce.codeChallenge,
          }),
        );
      })().catch((e: unknown) => finish(e instanceof Error ? e : new Error('Could not start Google sign-in')));
    });
  });
}
