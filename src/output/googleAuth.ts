import { hkdfSync, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { auth } from '@googleapis/drive';
import type { Env } from '../config/env.ts';
import { decrypt, encrypt } from '../crypto/envelope.ts';
import type { Db } from '../store/db.ts';
import { getKv, setKv } from '../store/kv.ts';

/** Only files this app creates. */
export const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.file'];

/** Phase 3, read only: Meet recordings, the Calendar invite behind each, and the recording files Meet put in Drive. No Gmail. */
export const MEETING_SCOPES = [
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

// The scopes Google granted with the stored token, as Google wrote them. Not a secret.
const SCOPES_KEY = 'google_scopes';

export function saveGrantedScopes(db: Db, scope: string): void {
  setKv(db, SCOPES_KEY, scope);
}

/** True only when the stored sign-in recorded every meeting scope. A token from before Phase 3 has none recorded: Drive only. */
export function hasMeetingScopes(db: Db): boolean {
  const granted = new Set((getKv(db, SCOPES_KEY) ?? '').split(' '));
  return MEETING_SCOPES.every((s) => granted.has(s));
}

export type OAuth2Client = InstanceType<typeof auth.OAuth2>;

export function createOAuthClient(clientId: string, clientSecret: string, redirectUri?: string): OAuth2Client {
  return new auth.OAuth2(clientId, clientSecret, redirectUri);
}

const TOKEN_KEY = 'google_refresh_token';
const TOKEN_AAD = Buffer.from(TOKEN_KEY);

export class TokenDecryptError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("Stored Google sign-in cannot be read with this PC's key. Run: npm run cli -- google-auth", options);
    this.name = 'TokenDecryptError';
  }
}

export class TokenStore {
  readonly #db: Db;
  readonly #key: Buffer;

  constructor(db: Db, key: Buffer) {
    this.#db = db;
    // A purpose-specific key, so the master key itself never encrypts the token directly.
    this.#key = Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), 'google-refresh-token', 32));
  }

  save(refreshToken: string): void {
    setKv(this.#db, TOKEN_KEY, encrypt(this.#key, Buffer.from(refreshToken, 'utf8'), TOKEN_AAD).toString('base64'));
  }

  load(): string | undefined {
    const v = getKv(this.#db, TOKEN_KEY);
    if (!v) return undefined;
    try {
      return decrypt(this.#key, Buffer.from(v, 'base64'), TOKEN_AAD).toString('utf8');
    } catch (e) {
      throw new TokenDecryptError({ cause: e });
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
class ConsentRefused extends Error {}

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
  scopes: string[];
  showUrl: (url: string) => void;
  timeoutMs?: number;
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
          if (!granted.has(DRIVE_SCOPES[0]!)) throw new ConsentRefused(NO_DRIVE_SCOPE);
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
            scope: o.scopes,
            state,
            code_challenge_method: 'S256',
            code_challenge: pkce.codeChallenge,
          }),
        );
      })().catch((e: unknown) => finish(e instanceof Error ? e : new Error('Could not start Google sign-in')));
    });
  });
}
