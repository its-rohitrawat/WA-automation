import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FOUNDER_TENANT_ID, parseEnv, type Env } from '../../src/config/env.ts';
import { CUSTOMER_KEYS, customerDataDir, customerProfile } from '../../src/runtime/customerProfile.ts';

// A customer's env (Phase B, lane A 1): deny by default. Every founder-only setting is absent, not just empty; the
// customer's own folder, id and key go in; its data folder is a customer id directly inside DATA_DIR/tenants.
// Every key and secret here is a placeholder.

const CUSTOMER = '00000000-0000-4000-8000-0000000000c2';
let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** A founder env with every founder-only setting set, so an absence means something. */
function founderEnv(): Env {
  dir = mkdtempSync(join(tmpdir(), 'wa-profile-'));
  return parseEnv({
    DATA_DIR: dir, ANTHROPIC_API_KEY: 'sk-ant-founder-placeholder', STT_PROVIDER: 'sarvam', VOICE_STT_PROVIDER: 'sarvam', STT_API_KEY: 'stt-founder-placeholder',
    GROUPS_FILE: join(dir, 'allowed-groups.json'), REPORT_ENABLED: 'true', REPORT_RECIPIENT: '919812345678', REPORT_TIME: '07:30',
    HEARTBEAT_URL: 'https://heartbeat.example.com/placeholder', UPTIMEROBOT_READ_KEY: 'ur-placeholder',
    DASHBOARD_ENABLED: 'true', DASHBOARD_OWNER_EMAILS: 'owner@example.com', DASHBOARD_PUBLIC_URL: 'https://dash.example.com',
    DASHBOARD_GOOGLE_CLIENT_ID: 'web-client-placeholder', DASHBOARD_GOOGLE_CLIENT_SECRET: 'web-secret-placeholder',
    GOOGLE_OAUTH_CLIENT_ID: 'desktop-client-placeholder', GOOGLE_OAUTH_CLIENT_SECRET: 'desktop-secret-placeholder',
    MEETINGS_ENABLED: 'true', TEAM_EMAIL_DOMAINS: 'example.com', INVITES_GMAIL: 'true', PLATFORM_ENABLED: 'true',
    DAILY_SPEND_CAP_USD: '15', PLATFORM_DAILY_SPEND_CAP_USD: '100',
  });
}

/** Every founder-only setting: none may reach a customer runtime. */
const FOUNDER_ONLY = [
  'GROUPS_FILE', 'STT_API_KEY', 'REPORT_RECIPIENT', 'REPORT_TIME', 'REPORT_DAYS', 'REPORT_DEADLINE', 'HEARTBEAT_URL', 'UPTIMEROBOT_READ_KEY',
  'DASHBOARD_OWNER_EMAILS', 'DASHBOARD_GOOGLE_CLIENT_ID', 'DASHBOARD_GOOGLE_CLIENT_SECRET', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET',
  'TEAM_EMAIL_DOMAINS', 'MEETINGS_SINCE', 'MEETING_POLL_MINUTES', 'MEETING_MAX_MINUTES', 'DAILY_SPEND_CAP_USD', 'PLATFORM_DAILY_SPEND_CAP_USD',
  'PLATFORM_FOUNDER_NAME', 'PLATFORM_MAX_ACTIVE', 'PLATFORM_MAX_RSS_MB', 'DATABASE_URL', 'DATABASE_PLATFORM_URL', 'DATABASE_OWNER_URL',
] as const;

describe('customerProfile (Phase B)', () => {
  it('deny by default: every founder-only setting is absent, and nothing outside the list is copied', () => {
    const founder = founderEnv();
    const env = customerProfile(founder, { tenantId: CUSTOMER, aiKey: null });
    for (const k of FOUNDER_ONLY) expect(k in env, k).toBe(false);
    const own = new Set<string>([...CUSTOMER_KEYS, 'DATA_DIR', 'TENANT_ID', 'STT_PROVIDER', 'VOICE_STT_PROVIDER', 'ANTHROPIC_API_KEY',
      'REPORT_ENABLED', 'MEETINGS_ENABLED', 'INVITES_GMAIL', 'PLATFORM_ENABLED', 'DASHBOARD_ASSISTANT']);
    expect(Object.keys(env).filter((k) => !own.has(k))).toEqual([]);
    expect(JSON.stringify(env)).not.toMatch(/founder-placeholder|secret-placeholder|ur-placeholder|heartbeat|919812345678/);
    expect(CUSTOMER_KEYS.filter((k) => (FOUNDER_ONLY as readonly string[]).includes(k))).toEqual([]);
  });

  it('the customer’s own values: its folder, its id, its key or none, D2 speech, and everything else off', () => {
    const founder = founderEnv();
    const without = customerProfile(founder, { tenantId: CUSTOMER, aiKey: null });
    expect('ANTHROPIC_API_KEY' in without).toBe(false); // no key of its own: none at all, never the founder's
    const env = customerProfile(founder, { tenantId: CUSTOMER, aiKey: 'sk-ant-customer-placeholder' });
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-customer-placeholder');
    expect(env.DATA_DIR).toBe(resolve(founder.DATA_DIR, 'tenants', CUSTOMER));
    expect(existsSync(env.DATA_DIR)).toBe(true);
    expect(env.TENANT_ID).toBe(CUSTOMER);
    expect([env.STT_PROVIDER, env.VOICE_STT_PROVIDER]).toEqual(['none', 'none']); // the founder's paid speech is the founder's
    expect([env.REPORT_ENABLED, env.MEETINGS_ENABLED, env.INVITES_GMAIL, env.PLATFORM_ENABLED, env.DASHBOARD_ASSISTANT]).toEqual([false, false, false, false, false]);
    expect([env.AI_MODEL, env.DASHBOARD_PUBLIC_URL]).toEqual([founder.AI_MODEL, founder.DASHBOARD_PUBLIC_URL]);
  });

  it('the data folder: a customer id only, directly inside DATA_DIR/tenants; no traversal, never the founder', () => {
    const founder = founderEnv();
    for (const bad of ['', 'x', '../..', `${CUSTOMER}/../..`, `../${CUSTOMER}`, '..\\..\\etc', CUSTOMER.toUpperCase(), `${CUSTOMER} `, FOUNDER_TENANT_ID]) {
      expect(() => customerDataDir(founder.DATA_DIR, bad), JSON.stringify(bad)).toThrow(/customer id/);
      expect(() => customerProfile(founder, { tenantId: bad, aiKey: null, makeDir: false }), JSON.stringify(bad)).toThrow();
    }
    expect(customerDataDir(founder.DATA_DIR, CUSTOMER)).toBe(resolve(founder.DATA_DIR, 'tenants', CUSTOMER));
  });
});
