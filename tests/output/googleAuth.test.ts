import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseCallback, TokenStore } from '../../src/output/googleAuth.ts';
import { getKv } from '../../src/store/kv.ts';
import { seededDb } from '../helpers/db.ts';

describe('TokenStore', () => {
  it('stores the refresh token encrypted', () => {
    const db = seededDb();
    const store = new TokenStore(db, randomBytes(32));
    store.save('1//refresh-token-value');
    expect(getKv(db, 'google_refresh_token')).not.toContain('refresh-token-value');
    expect(store.load()).toBe('1//refresh-token-value');
  });

  it('returns undefined before sign-in', () => {
    expect(new TokenStore(seededDb(), randomBytes(32)).load()).toBeUndefined();
  });
});

describe('parseCallback', () => {
  it('returns the code when the state matches', () => {
    expect(parseCallback('/?state=abc&code=4%2F0AX', 'abc')).toBe('4/0AX');
  });

  it('rejects a mismatched state, an error, or a missing code', () => {
    expect(() => parseCallback('/?state=evil&code=x', 'abc')).toThrowError(/state mismatch/);
    expect(() => parseCallback('/?error=access_denied&state=abc', 'abc')).toThrowError(/access_denied/);
    expect(() => parseCallback('/?state=abc', 'abc')).toThrowError(/no authorisation code/);
  });
});
