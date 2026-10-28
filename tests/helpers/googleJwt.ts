import { createSign, generateKeyPairSync } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { vi } from 'vitest';

/**
 * Offline Google ID tokens for testing the production verifier (googleIdVerifier): a locally generated RSA key signs
 * RS256 JWTs by hand, and Google's public certificates are stubbed with that key, so nothing goes to the network.
 */
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();
/** The key id the stubbed certificates know. */
export const KID = 'k1';

type Certs = Awaited<ReturnType<OAuth2Client['getFederatedSignonCertsAsync']>>;

/** Google's certificate fetch answers with the local key (as key id `k1`). Vitest's restoreMocks undoes it. */
export function stubGoogleCerts() {
  return vi.spyOn(OAuth2Client.prototype, 'getFederatedSignonCertsAsync').mockResolvedValue({ certs: { [KID]: PEM }, format: 'PEM' } as unknown as Certs);
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** An RS256 JWT signed with the local key. */
export function signJwt(payload: Record<string, unknown>, kid = KID): string {
  const head = b64({ alg: 'RS256', kid, typ: 'JWT' });
  const body = b64(payload);
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}

/** Good claims for `clientId`, valid for an hour from the real time (the library checks expiry against Date.now). */
export function goodPayload(clientId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return { iss: 'https://accounts.google.com', aud: clientId, iat: now, exp: now + 3600, sub: '1', nonce: 'N', email: 'Owner@Example.com', email_verified: true, ...extra };
}

/** The ways a forged or wrong token can look: each must be refused by the production verifier. */
export function badTokens(clientId: string): [string, string][] {
  const good = goodPayload(clientId);
  const now = Math.floor(Date.now() / 1000);
  const tampered = signJwt(good).replace(/\.([^.]+)\./, () => `.${b64({ ...good, email: 'evil@example.com' })}.`);
  return [
    ['a tampered payload', tampered],
    ['alg none', `${b64({ alg: 'none', kid: KID })}.${b64(good)}.`],
    ['an unknown key id', signJwt(good, 'k2')],
    ['a wrong audience', signJwt({ ...good, aud: 'other-client.apps.googleusercontent.com' })],
    ['an expired token', signJwt({ ...good, iat: now - 7200, exp: now - 3600 })],
  ];
}
