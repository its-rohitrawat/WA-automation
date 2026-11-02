import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// The state parameter of a Google connect (S4.7). It carries the customer and the account the connect was started for,
// signed with HMAC-SHA256, so a callback can only store a token for the customer that started it, and only within 10
// minutes. The key is passed in (lane A derives it from the master key in main.ts); nothing here reads a key itself.
// The state is <payload>.<mac>, both base64url; the payload is JSON with a random nonce, so no two states are equal.

/** How long a connect may take, from its start to Google's callback. */
export const OAUTH_STATE_MAX_AGE_MS = 10 * 60_000;

export interface OAuthStateClaims {
  tenantId: string;
  account: string;
}

interface Payload {
  t: string;
  a: string;
  at: number;
  n: string;
}

const mac = (key: Buffer, payload: string): Buffer => createHmac('sha256', key).update(payload).digest();

export function signOAuthState(key: Buffer, s: OAuthStateClaims & { at: Date }): string {
  const body: Payload = { t: s.tenantId, a: s.account, at: s.at.getTime(), n: randomBytes(16).toString('base64url') };
  const payload = Buffer.from(JSON.stringify(body)).toString('base64url');
  return `${payload}.${mac(key, payload).toString('base64url')}`;
}

/** The claims of a state this key signed within the last 10 minutes; null when it is forged, altered, too old or malformed. */
export function verifyOAuthState(key: Buffer, state: string, now: Date): OAuthStateClaims | null {
  const parts = state.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts as [string, string];
  // Compared as text: decoding base64url ignores a last character's spare bits, so two spellings could give one MAC.
  const given = Buffer.from(sig);
  const expected = Buffer.from(mac(key, payload).toString('base64url'));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const p = body as Partial<Payload> | null;
  if (typeof p?.t !== 'string' || typeof p.a !== 'string' || typeof p.at !== 'number' || typeof p.n !== 'string') return null;
  const age = now.getTime() - p.at;
  if (!(age >= 0 && age <= OAUTH_STATE_MAX_AGE_MS)) return null;
  return { tenantId: p.t, account: p.a };
}
