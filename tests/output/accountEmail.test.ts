import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fillAccountEmails } from '../../src/output/accountEmail.ts';
import {
  accountEmail, DRIVE_SCOPES, MEETING_SCOPES, removeMeetingAccount, saveAccountEmail, saveGrantedScopes, saveMeetingAccount, TokenStore,
  type OAuth2Client,
} from '../../src/output/googleAuth.ts';
import { GoogleAuthHub } from '../../src/output/googleAuthHub.ts';
import { createLogger } from '../../src/util/logger.ts';
import { seededDb } from '../helpers/db.ts';

const fakeClient = () => {
  const c = { credentials: {} as Record<string, unknown>, setCredentials(x: Record<string, unknown>) { this.credentials = x; } };
  return c as unknown as OAuth2Client;
};

async function setup() {
  const db = await seededDb();
  const key = randomBytes(32);
  new TokenStore(db, key).save('main-token');
  saveGrantedScopes(db, DRIVE_SCOPES[0]!);
  const hub = () => new GoogleAuthHub({ db, key, credentials: { desktop: { clientId: 'd', clientSecret: 's' } }, newClient: fakeClient });
  const lines: string[] = [];
  const log = createLogger('debug', { write: (l: string) => void lines.push(l) });
  return { db, key, hub, lines, log };
}

describe('account emails', () => {
  it('stores one lower-cased address per account and refuses anything else', async () => {
    const { db } = await setup();
    expect(saveAccountEmail(db, 'main', ' Owner@Studio.IN ')).toBe(true);
    expect(accountEmail(db, 'main')).toBe('owner@studio.in');
    for (const bad of ['', 'no-at-sign', 'a@b', 'two@at@x.com', 'sp ace@x.com', `${'x'.repeat(65)}@x.com`]) {
      expect(saveAccountEmail(db, 'org2', bad)).toBe(false);
    }
    expect(accountEmail(db, 'org2')).toBeNull();
  });

  it('a new sign-in for the account forgets its email; removing an account forgets it too', async () => {
    const { db, key } = await setup();
    saveAccountEmail(db, 'main', 'owner@studio.in');
    new TokenStore(db, key).save('another-main-token');
    expect(accountEmail(db, 'main')).toBeNull();
    saveMeetingAccount(db, key, 'org2', 'org2-token', MEETING_SCOPES.join(' '));
    saveAccountEmail(db, 'org2', 'meet@org2.in');
    expect(removeMeetingAccount(db, 'org2')).toBe(true);
    expect(accountEmail(db, 'org2')).toBeNull();
  });
});

describe('fillAccountEmails', () => {
  it('fills an older account once from Drive, and asks no more once it is known', async () => {
    const t = await setup();
    const hub = t.hub();
    let asked = 0;
    const lookup = async () => {
      asked++;
      return 'Owner@Studio.in';
    };
    expect(await fillAccountEmails({ db: t.db, hub, log: t.log, lookup })).toBe(1);
    expect(accountEmail(t.db, 'main')).toBe('owner@studio.in');
    expect(await fillAccountEmails({ db: t.db, hub, log: t.log, lookup })).toBe(0);
    expect(asked).toBe(1);
  });

  it('skips an account without a Drive scope, and one without a usable client', async () => {
    const t = await setup();
    saveGrantedScopes(t.db, 'openid');
    let asked = 0;
    await fillAccountEmails({ db: t.db, hub: t.hub(), log: t.log, lookup: async () => (asked++, 'x@y.in') });
    expect(asked).toBe(0);
    expect(accountEmail(t.db, 'main')).toBeNull();
  });

  it('a failing lookup leaves it empty and logs only the label and the error type', async () => {
    const t = await setup();
    const err = Object.assign(new Error('owner@studio.in is not allowed'), { name: 'GaxiosError' });
    expect(await fillAccountEmails({ db: t.db, hub: t.hub(), log: t.log, lookup: async () => { throw err; } })).toBe(0);
    expect(accountEmail(t.db, 'main')).toBeNull();
    const out = t.lines.join('\n');
    expect(out).toContain('GaxiosError');
    expect(out).not.toMatch(/owner@|studio\.in/);
  });

  it('an answer that arrives after a reconnect is dropped: the reconnect has its own email', async () => {
    const t = await setup();
    const hub = t.hub();
    const lookup = async () => {
      // The owner reconnects while Drive answers: a new client, and the new account's email from its ID token.
      hub.setToken('main', 'newer-token', 'desktop', DRIVE_SCOPES[0]!);
      saveAccountEmail(t.db, 'main', 'new@studio.in');
      return 'old@studio.in';
    };
    await fillAccountEmails({ db: t.db, hub, log: t.log, lookup });
    expect(accountEmail(t.db, 'main')).toBe('new@studio.in');
  });
});
