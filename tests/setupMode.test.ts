import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { parseEnv } from '../src/config/env.ts';
import { Health } from '../src/health/health.ts';
import { isAuthFailure } from '../src/output/authFailure.ts';
import { DRIVE_SCOPES, MEETING_SCOPES, saveGrantedScopes, saveMeetingAccount, TokenStore, type OAuth2Client } from '../src/output/googleAuth.ts';
import { GoogleAuthHub, GoogleNotConnectedError } from '../src/output/googleAuthHub.ts';
import {
  buildGoogle, founderGateway, GOOGLE_NOT_CONNECTED_EXIT, googleCredentials, planStartup, setupLine, WHATSAPP_NOT_LINKED_EXIT,
} from '../src/setupMode.ts';
import type { Prices } from '../src/spend/pricing.ts';
import { SpendGuard } from '../src/spend/spendGuard.ts';
import { manualClock, systemClock } from '../src/util/clock.ts';
import { createLogger, silentLogger } from '../src/util/logger.ts';
import { AllowList } from '../src/wa/allowlist.ts';
import { backupAndReset, openSessionDb, useEncryptedAuthState } from '../src/wa/authState.ts';
import { NotConnectedError } from '../src/wa/switchableGateway.ts';
import { FakeAi } from './helpers/ai.ts';
import { seededDb, SHARMA } from './helpers/db.ts';
import { FakeDrive } from './helpers/fakeDrive.ts';

const log = silentLogger();
const P: Prices = { inputPerMTok: 4, outputPerMTok: 20, cacheWritePerMTok: 5, cacheReadPerMTok: 0.2 };

describe('planStartup', () => {
  it.each([
    [false, false, false, { exit: WHATSAPP_NOT_LINKED_EXIT }],
    [false, false, true, { exit: WHATSAPP_NOT_LINKED_EXIT }],
    [false, true, false, { exit: GOOGLE_NOT_CONNECTED_EXIT }],
    [false, true, true, { whatsapp: 'linked', google: 'connected' }],
    [true, false, false, { whatsapp: 'not_linked', google: 'not_connected' }],
    [true, false, true, { whatsapp: 'not_linked', google: 'connected' }],
    [true, true, false, { whatsapp: 'linked', google: 'not_connected' }],
    [true, true, true, { whatsapp: 'linked', google: 'connected' }],
  ] as const)('dashboard %s, WhatsApp linked %s, Google token %s', (dashboardEnabled, whatsappLinked, googleToken, expected) => {
    expect(planStartup({ dashboardEnabled, whatsappLinked, googleToken })).toEqual(expected);
  });

  it('the dashboard-off exits keep their exact messages', () => {
    expect(WHATSAPP_NOT_LINKED_EXIT).toBe('WhatsApp is not linked. Stop the service and run: npm run cli -- link');
    expect(GOOGLE_NOT_CONNECTED_EXIT).toBe('Google Drive is not connected. Run: npm run cli -- google-auth');
  });

  it('the runtime stops on the plan, and only an unreadable token with the dashboard on is tolerated (source scan)', () => {
    // The founder's start-up half moved from main.ts to the runtime (S4.4).
    const src = readFileSync(new URL('../src/runtime/customerRuntime.ts', import.meta.url), 'utf8');
    expect(src).toContain("const plan = planStartup({ dashboardEnabled: env.DASHBOARD_ENABLED, whatsappLinked: auth.hasSession, googleToken });");
    expect(src).toContain("if ('exit' in plan) exitEarly(plan.exit);");
    expect(src).toContain('if (!(env.DASHBOARD_ENABLED && e instanceof TokenDecryptError)) throw e;');
    expect(src).not.toMatch(/exitEarly\('WhatsApp is not linked|exitEarly\('Google Drive is not connected/);
    // Dashboard off: the link is checked before the token is read, as before.
    const linkCheck = src.indexOf('if (!env.DASHBOARD_ENABLED && !auth.hasSession) exitEarly(WHATSAPP_NOT_LINKED_EXIT);');
    expect(linkCheck).toBeGreaterThan(0);
    expect(linkCheck).toBeLessThan(src.indexOf('new TokenStore(db, key).load()'));
    // The setup line about Google only with the dashboard on; a reconnected main account uploads at once.
    expect(src).toContain('if (env.DASHBOARD_ENABLED) app.health.setGoogleConnected(google.connected());');
    expect(src).toContain("if (label === 'main') void app.publisher.publishNow()");
  });
});

describe('googleCredentials', () => {
  const base = { ANTHROPIC_API_KEY: 'k' };
  it('dashboard off: the desktop client is required, as before', () => {
    expect(() => googleCredentials(parseEnv({ ...base }))).toThrow('GOOGLE_OAUTH_CLIENT_ID');
    expect(googleCredentials(parseEnv({ ...base, GOOGLE_OAUTH_CLIENT_ID: 'd', GOOGLE_OAUTH_CLIENT_SECRET: 's' })))
      .toEqual({ desktop: { clientId: 'd', clientSecret: 's' } });
  });

  it('dashboard on: the desktop client is optional; the web client comes from the DASHBOARD_GOOGLE names', () => {
    const on = {
      ...base, DASHBOARD_ENABLED: 'true', DASHBOARD_OWNER_EMAILS: 'owner@studio.in', DASHBOARD_PUBLIC_URL: 'https://example.com',
      DASHBOARD_GOOGLE_CLIENT_ID: 'w', DASHBOARD_GOOGLE_CLIENT_SECRET: 'ws',
    };
    expect(googleCredentials(parseEnv(on))).toEqual({ web: { clientId: 'w', clientSecret: 'ws' } });
    expect(googleCredentials(parseEnv({ ...on, GOOGLE_OAUTH_CLIENT_ID: 'd', GOOGLE_OAUTH_CLIENT_SECRET: 's' })))
      .toEqual({ desktop: { clientId: 'd', clientSecret: 's' }, web: { clientId: 'w', clientSecret: 'ws' } });
  });
});

describe('founderGateway', () => {
  it('linked: builds the real gateway once, and start() starts it', () => {
    let built = 0;
    let starts = 0;
    const inner = {
      onEvent() {}, onStatus() {}, async stop() {}, async listGroups() { return []; }, failedCount: () => 0, droppedCount: () => 0,
      status: () => ({ state: 'connecting' as const, since: '2026-10-27T08:00:00.000Z', lastErrorCode: null, credsSaveFailures: 0 }),
      start() { starts++; },
    };
    const g = founderGateway({ linked: true, build: () => { built++; return inner; } });
    expect(built).toBe(1);
    expect(g.hasGateway()).toBe(true);
    g.start();
    expect(starts).toBe(1);
    expect(g.status().state).toBe('connecting');
  });

  it('not linked: no gateway, state not_linked, and listing groups says not connected', async () => {
    let built = 0;
    const g = founderGateway({ linked: false, build: () => { built++; throw new Error('never'); } });
    expect(built).toBe(0);
    expect(g.status().state).toBe('not_linked');
    expect(g.hasGateway()).toBe(false);
    await expect(g.listGroups()).rejects.toBeInstanceOf(NotConnectedError);
    g.start();
    await g.stop();
  });
});

describe('buildGoogle', () => {
  const fakeClient = () => {
    const c = {
      credentials: {} as { refresh_token?: string },
      setCredentials(x: { refresh_token?: string }) {
        this.credentials = { ...x };
      },
      async request() {
        return { data: { id: 'folder-1' }, status: 200, headers: {} };
      },
    };
    return c as unknown as OAuth2Client;
  };

  it('no main token: not connected, and Drive fails as a sign-in problem; a reconnect fixes both at once', async () => {
    const db = await seededDb();
    const key = randomBytes(32);
    const hub = await GoogleAuthHub.open({ db, key, credentials: { desktop: { clientId: 'd', clientSecret: 's' } }, newClient: fakeClient });
    const g = await buildGoogle({ db, key, credentials: {}, meetingsEnabled: false, log, hub });
    expect(g.connected()).toBe(false);
    expect(g.meetings).toBeUndefined();
    const err = await g.drive.createFolder('WA Agent').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleNotConnectedError);
    expect(isAuthFailure(err)).toBe(true);
    await hub.setToken('main', 'rt', 'desktop', DRIVE_SCOPES[0]!);
    expect(g.connected()).toBe(true);
    expect(await g.drive.createFolder('WA Agent')).toBe('folder-1');
  });

  it('logs an account it cannot use by label and reason only', async () => {
    const db = await seededDb();
    await new TokenStore(db, randomBytes(32)).save('rt-secret-value'); // written with another key
    const lines: string[] = [];
    const capture = createLogger('debug', { write: (l: string) => void lines.push(l) });
    await buildGoogle({ db, key: randomBytes(32), credentials: { desktop: { clientId: 'd', clientSecret: 's' } }, meetingsEnabled: false, log: capture });
    const warn = lines.find((l) => l.includes('cannot be used'));
    expect(warn).toContain('"account":"main"');
    expect(warn).toContain('"code":"unreadable"');
    expect(lines.join(' ')).not.toContain('rt-secret-value');
  });

  it('meetings on: the live API is rebuilt when an account is reconnected', async () => {
    const db = await seededDb();
    const key = randomBytes(32);
    await new TokenStore(db, key).save('rt');
    await saveGrantedScopes(db, DRIVE_SCOPES[0]!);
    const hub = await GoogleAuthHub.open({ db, key, credentials: { desktop: { clientId: 'd', clientSecret: 's' } }, newClient: fakeClient });
    const g = await buildGoogle({ db, key, credentials: {}, meetingsEnabled: true, log, hub });
    const signal = new AbortController().signal;
    await expect(g.meetings!.listConferences('2026-10-20T00:00:00Z', '2026-10-27T00:00:00Z', signal))
      .rejects.toMatchObject({ code: 'not_connected' }); // main has no meeting scopes: no account yet
    await saveMeetingAccount(db, key, 'company2', 'rt-2', MEETING_SCOPES.join(' '));
    await hub.setToken('company2', 'rt-2', 'desktop', MEETING_SCOPES.join(' '));
    // Rebuilt with company2: the call now reaches Google's client (the fake answers no list, which is not a refusal).
    await expect(g.meetings!.listConferences('2026-10-20T00:00:00Z', '2026-10-27T00:00:00Z', signal)).resolves.toBeDefined();
  });
});

describe('setup mode health', () => {
  async function health() {
    const db = await seededDb();
    const clock = manualClock('2026-10-27T08:00:00Z');
    const h = new Health({ db, clock, spend: new SpendGuard({ db, clock, capUsd: 15 }), freeBytes: () => 200e9 });
    return { h, clock };
  }
  const status = (state: 'not_linked' | 'linking' | 'open') => ({ state, since: '2026-10-27T08:00:00.000Z', lastErrorCode: null, credsSaveFailures: 0 });

  it.each([
    ['not_linked', true, "❌ WhatsApp is not linked. Open the dashboard → Connections and link the founder's phone."],
    ['linking', true, "⏳ WhatsApp is being linked from the dashboard. Reading resumes once the founder's phone has scanned the code."],
    ['open', false, '❌ Google is not connected. Open the dashboard → Connections and connect Google.'],
  ] as const)('WhatsApp %s, Google connected %s: its own line, ranked first, and not up', async (state, google, text) => {
    const { h } = await health();
    h.setWhatsApp(status(state));
    h.setGoogleConnected(google);
    expect(h.isUp()).toBe(false); // the setup state alone
    expect(h.line()).toEqual({ ok: false, text });
    h.markPublishFailed({ step: 'drive', auth: true }); // ranks below
    expect(h.line()).toEqual({ ok: false, text });
    expect(h.isUp()).toBe(false);
    expect(setupLine(state, google)).toEqual({ ok: false, text });
  });

  it('all set up: no setup line, and up as before', async () => {
    const { h } = await health();
    h.setWhatsApp(status('open'));
    h.setGoogleConnected(true);
    expect(setupLine('open', true)).toBeNull();
    expect(h.isUp()).toBe(true);
    expect(h.line().ok).toBe(true);
  });
});

describe('the app in setup mode', () => {
  it('starts and stops with no WhatsApp link and no Google: nothing to read, the health line says why', async () => {
    const db = await seededDb();
    const gateway = founderGateway({ linked: false, build: () => { throw new Error('never'); } });
    const app = await createApp({
      db, clock: systemClock, log, gateway, allow: new AllowList([SHARMA.groupId]), ai: new FakeAi(), drive: new FakeDrive(),
      prices: P, spendCapUsd: 15, quietMs: 240_000, maxWaitMs: 1_200_000, maxConcurrent: 3, dataDir: '.', freeBytes: () => 500e9, pollMs: 30_000,
    });
    app.health.setGoogleConnected(false);
    app.start();
    expect(app.health.line().text).toMatch(/WhatsApp is not linked/);
    expect(app.health.isUp()).toBe(false);
    await app.stop();
  });
});

// The session file is SQLite by design on the SQLite home; its Postgres twin (wa_auth, restored on open) is covered by
// tests/wa/authStatePg.test.ts.
describe('openSessionDb recovers a link that never finished', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wa-setup-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('a crash after the backup and reset: the next open brings the old session back', async () => {
    const file = join(dir, 'session.db');
    const key = randomBytes(32);
    const first = openSessionDb(file);
    const auth = await useEncryptedAuthState(first, key);
    auth.state.creds.me = { id: '919800000001:3@s.whatsapp.net', name: 'Founder' };
    await auth.saveCreds();
    const before = await first.all('SELECT k, v FROM auth ORDER BY k');
    await backupAndReset(first);
    await first.close(); // the process stops mid-link
    const again = openSessionDb(file);
    expect(await again.all('SELECT k, v FROM auth ORDER BY k')).toEqual(before);
    expect((await useEncryptedAuthState(again, key)).hasSession).toBe(true);
    await again.close();
  });
});
