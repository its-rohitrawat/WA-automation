import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { OAUTH_STATE_MAX_AGE_MS, signOAuthState, verifyOAuthState } from '../../src/output/oauthState.ts';

const KEY = randomBytes(32);
const AT = new Date('2026-10-30T06:00:00.000Z');
const later = (ms: number) => new Date(AT.getTime() + ms);
const claims = { tenantId: '00000000-0000-4000-8000-000000000001', account: 'main' };

describe('signed OAuth state', () => {
  it('round-trips the customer and the account, and no two states are equal', () => {
    const s = signOAuthState(KEY, { ...claims, at: AT });
    expect(s).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(verifyOAuthState(KEY, s, later(1_000))).toEqual(claims);
    expect(signOAuthState(KEY, { ...claims, at: AT })).not.toBe(s);
  });

  it('refuses a state with any one character changed', () => {
    const s = signOAuthState(KEY, { ...claims, at: AT });
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '.') continue;
      const changed = s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
      expect(verifyOAuthState(KEY, changed, later(1_000)), `position ${i}`).toBeNull();
    }
  });

  it('refuses the same MAC spelled another way (the last character’s spare bits set)', () => {
    const s = signOAuthState(KEY, { ...claims, at: AT });
    const ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const respelled = s.slice(0, -1) + ABC[ABC.indexOf(s.at(-1)!) ^ 1]; // a 32-byte MAC leaves 2 spare bits at the end
    expect(Buffer.from(respelled.split('.')[1]!, 'base64url')).toEqual(Buffer.from(s.split('.')[1]!, 'base64url'));
    expect(verifyOAuthState(KEY, respelled, later(1_000))).toBeNull();
  });

  it('accepts a state up to 10 minutes old, and refuses it 1 ms later or dated ahead', () => {
    const s = signOAuthState(KEY, { ...claims, at: AT });
    expect(verifyOAuthState(KEY, s, later(OAUTH_STATE_MAX_AGE_MS))).toEqual(claims);
    expect(verifyOAuthState(KEY, s, later(OAUTH_STATE_MAX_AGE_MS + 1))).toBeNull();
    expect(verifyOAuthState(KEY, s, later(-1))).toBeNull();
  });

  it('refuses a state signed with another key: customer B cannot hand in a state for customer A', () => {
    const s = signOAuthState(randomBytes(32), { ...claims, at: AT });
    expect(verifyOAuthState(KEY, s, later(1_000))).toBeNull();
  });

  it('refuses malformed states, including a well-signed payload that is not a state', () => {
    for (const s of ['', '.', 'abc', 'a.b.c', 'not base64!.x']) expect(verifyOAuthState(KEY, s, AT), s).toBeNull();
    const payload = Buffer.from(JSON.stringify({ t: 1, a: 'main', at: AT.getTime(), n: 'x' })).toString('base64url');
    const signed = `${payload}.${createHmac('sha256', KEY).update(payload).digest('base64url')}`;
    expect(verifyOAuthState(KEY, signed, AT)).toBeNull();
  });
});
