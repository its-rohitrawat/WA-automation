import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { auth } from '@googleapis/drive';
import { decrypt, encrypt } from '../crypto/envelope.ts';
import type { Db } from '../store/db.ts';
import { getKv, setKv } from '../store/kv.ts';

/** Only files this app creates. Gmail/Calendar read-only scopes are added in Phase 3. */
export const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.file'];

export type OAuth2Client = InstanceType<typeof auth.OAuth2>;

export function createOAuthClient(clientId: string, clientSecret: string, redirectUri?: string): OAuth2Client {
  return new auth.OAuth2(clientId, clientSecret, redirectUri);
}

const TOKEN_KEY = 'google_refresh_token';

export class TokenStore {
  readonly #db: Db;
  readonly #key: Buffer;

  constructor(db: Db, key: Buffer) {
    this.#db = db;
    this.#key = key;
  }

  save(refreshToken: string): void {
    setKv(this.#db, TOKEN_KEY, encrypt(this.#key, Buffer.from(refreshToken, 'utf8')).toString('base64'));
  }

  load(): string | undefined {
    const v = getKv(this.#db, TOKEN_KEY);
    return v ? decrypt(this.#key, Buffer.from(v, 'base64')).toString('utf8') : undefined;
  }
}

export function parseCallback(requestUrl: string, expectedState: string): string {
  const url = new URL(requestUrl, 'http://127.0.0.1');
  const error = url.searchParams.get('error');
  if (error) throw new Error(`Google sign-in was cancelled or failed (${error.replace(/[^a-z_]/gi, '').slice(0, 40)})`);
  if (url.searchParams.get('state') !== expectedState) throw new Error('Sign-in response did not match this request (state mismatch)');
  const code = url.searchParams.get('code');
  if (!code) throw new Error('Sign-in response had no authorisation code');
  return code;
}

const NO_REFRESH = 'Google returned no refresh token. Remove WA Agent at myaccount.google.com/permissions and try again.';

/** One-time loopback sign-in. Listens on 127.0.0.1 only, for one redirect, then closes. */
export async function runLoopbackConsent(o: {
  clientId: string;
  clientSecret: string;
  scopes: string[];
  showUrl: (url: string) => void;
  timeoutMs?: number;
}): Promise<string> {
  const state = randomBytes(16).toString('hex');
  return await new Promise<string>((resolve, reject) => {
    let client: OAuth2Client | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let handled = false;
    const server = createServer((req, res) => {
      if (!req.url || req.url.startsWith('/favicon') || handled) {
        res.writeHead(404).end();
        return;
      }
      let code: string;
      try {
        code = parseCallback(req.url, state);
      } catch (e) {
        handled = true;
        res.writeHead(400, { 'content-type': 'text/plain' }).end('Sign-in failed. You can close this tab and try again.');
        finish(e as Error);
        return;
      }
      handled = true;
      res.writeHead(200, { 'content-type': 'text/plain' }).end('WA Agent is connected to Google Drive. You can close this tab.');
      client!
        .getToken(code)
        .then(({ tokens }) => {
          if (!tokens.refresh_token) throw new Error(NO_REFRESH);
          finish(null, tokens.refresh_token);
        })
        // Google's own error text can echo request details, so replace it.
        .catch((e: Error) => finish(e.message === NO_REFRESH ? e : new Error('Google would not exchange the sign-in code')));
    });
    function finish(err: Error | null, token?: string): void {
      clearTimeout(timer);
      server.close();
      if (err) reject(err);
      else resolve(token!);
    }
    timer = setTimeout(() => finish(new Error('Timed out waiting for Google sign-in')), o.timeoutMs ?? 300_000);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      client = createOAuthClient(o.clientId, o.clientSecret, `http://127.0.0.1:${port}`);
      o.showUrl(client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: o.scopes, state }));
    });
  });
}
