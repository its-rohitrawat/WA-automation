import { readFileSync } from 'node:fs';
import { parseEnv as parseDotenv } from 'node:util';
import { describe, expect, it } from 'vitest';
import { parseEnv, requireKey } from '../../src/config/env.ts';

describe('parseEnv', () => {
  it('applies defaults', () => {
    const env = parseEnv({});
    expect(env.AI_MODEL).toBe('claude-opus-5-5');
    expect(env.AI_EFFORT).toBe('medium');
    expect(env.DAILY_SPEND_CAP_USD).toBe(15);
    expect(env.QUIET_MINUTES).toBe(4);
    expect(env.MAX_WAIT_MINUTES).toBe(20);
    expect(env.GROUPS_FILE).toBe('config/allowed-groups.json');
  });

  it('treats empty values as unset', () => {
    expect(parseEnv({ AI_EFFORT: '' }).AI_EFFORT).toBe('medium');
  });

  it('names the bad variable without echoing its value', () => {
    expect(() => parseEnv({ AI_EFFORT: 'turbo-secret-value' })).toThrowError(/AI_EFFORT/);
    try {
      parseEnv({ AI_EFFORT: 'turbo-secret-value' });
    } catch (e) {
      expect((e as Error).message).not.toContain('turbo-secret-value');
    }
  });

  it('requireKey reports a missing key by name', () => {
    expect(() => requireKey(parseEnv({}), 'ANTHROPIC_API_KEY')).toThrowError('ANTHROPIC_API_KEY is not configured');
    expect(requireKey(parseEnv({ ANTHROPIC_API_KEY: 'k' }), 'ANTHROPIC_API_KEY')).toBe('k');
  });
});

/** The message parseEnv throws, or '' when it does not throw. */
function envError(source: Record<string, string>): string {
  try {
    parseEnv(source);
    return '';
  } catch (e) {
    return (e as Error).message;
  }
}

describe('meeting settings', () => {
  it('apply defaults: meetings off, no team domains, 5 and 180 minutes, no start date, no ffmpeg path', () => {
    const env = parseEnv({});
    expect(env.MEETINGS_ENABLED).toBe(false);
    expect(env.TEAM_EMAIL_DOMAINS).toEqual([]);
    expect(env.MEETING_POLL_MINUTES).toBe(5);
    expect(env.MEETING_MAX_MINUTES).toBe(180);
    expect(env.MEETINGS_SINCE).toBeUndefined();
    expect(env.FFMPEG_PATH).toBeUndefined();
  });

  it('MEETINGS_ENABLED accepts true, false, 1 and 0 only', () => {
    const on = { TEAM_EMAIL_DOMAINS: 'ourstudio.in' };
    expect(parseEnv({ ...on, MEETINGS_ENABLED: 'true' }).MEETINGS_ENABLED).toBe(true);
    expect(parseEnv({ ...on, MEETINGS_ENABLED: '1' }).MEETINGS_ENABLED).toBe(true);
    expect(parseEnv({ MEETINGS_ENABLED: 'false' }).MEETINGS_ENABLED).toBe(false);
    expect(parseEnv({ MEETINGS_ENABLED: '0' }).MEETINGS_ENABLED).toBe(false);
    for (const v of ['yes', 'TRUE', 'on', '2']) expect(envError({ ...on, MEETINGS_ENABLED: v })).toMatch(/MEETINGS_ENABLED/);
  });

  it('TEAM_EMAIL_DOMAINS is a trimmed, lower-cased, comma-separated list', () => {
    expect(parseEnv({ TEAM_EMAIL_DOMAINS: ' OurStudio.in , ourstudio.co.uk,' }).TEAM_EMAIL_DOMAINS).toEqual(['ourstudio.in', 'ourstudio.co.uk']);
  });

  it('TEAM_EMAIL_DOMAINS drops repeats after lower-casing', () => {
    expect(parseEnv({ TEAM_EMAIL_DOMAINS: 'ourstudio.in,OURSTUDIO.IN, ourstudio.co.uk ,OurStudio.in' }).TEAM_EMAIL_DOMAINS).toEqual(['ourstudio.in', 'ourstudio.co.uk']);
  });

  it('TEAM_EMAIL_DOMAINS is required when meetings are on, and the error names it', () => {
    const msg = envError({ MEETINGS_ENABLED: 'true' });
    expect(msg).toMatch(/TEAM_EMAIL_DOMAINS/);
    expect(msg).toMatch(/MEETINGS_ENABLED/);
    expect(envError({ MEETINGS_ENABLED: 'true', TEAM_EMAIL_DOMAINS: ' , ' })).toMatch(/TEAM_EMAIL_DOMAINS/);
    expect(parseEnv({ MEETINGS_ENABLED: 'true', TEAM_EMAIL_DOMAINS: 'ourstudio.in' }).TEAM_EMAIL_DOMAINS).toEqual(['ourstudio.in']);
  });

  it('TEAM_EMAIL_DOMAINS refuses public mail domains and bad shapes without echoing them', () => {
    const pub = envError({ TEAM_EMAIL_DOMAINS: 'zz-ourstudio-zz.in,Gmail.com' });
    expect(pub).toMatch(/TEAM_EMAIL_DOMAINS/);
    expect(pub).toMatch(/public mail domain/);
    expect(pub).not.toContain('zz-ourstudio-zz');
    const bad = envError({ TEAM_EMAIL_DOMAINS: 'zz-distinctive-value-zz' });
    expect(bad).toMatch(/TEAM_EMAIL_DOMAINS/);
    expect(bad).not.toContain('zz-distinctive-value-zz');
  });

  it('MEETING_POLL_MINUTES is a whole number from 2 to 60', () => {
    expect(parseEnv({ MEETING_POLL_MINUTES: '2' }).MEETING_POLL_MINUTES).toBe(2);
    expect(parseEnv({ MEETING_POLL_MINUTES: '60' }).MEETING_POLL_MINUTES).toBe(60);
    for (const v of ['1', '61', '2.5', 'often']) expect(envError({ MEETING_POLL_MINUTES: v })).toMatch(/MEETING_POLL_MINUTES/);
  });

  it('MEETING_MAX_MINUTES is a whole number from 10 to 300', () => {
    expect(parseEnv({ MEETING_MAX_MINUTES: '10' }).MEETING_MAX_MINUTES).toBe(10);
    expect(parseEnv({ MEETING_MAX_MINUTES: '300' }).MEETING_MAX_MINUTES).toBe(300);
    for (const v of ['9', '301', '90.5', 'long']) expect(envError({ MEETING_MAX_MINUTES: v })).toMatch(/MEETING_MAX_MINUTES/);
  });

  it('MEETINGS_SINCE is a real YYYY-MM-DD date', () => {
    expect(parseEnv({ MEETINGS_SINCE: '2026-10-01' }).MEETINGS_SINCE).toBe('2026-10-01');
    expect(parseEnv({ MEETINGS_SINCE: '2028-02-29' }).MEETINGS_SINCE).toBe('2028-02-29');
    for (const v of ['2026-13-01', '2026-02-30', '2027-02-29', '1-10-2026', '2026-10-01T00:00:00Z', 'yesterday']) {
      expect(envError({ MEETINGS_SINCE: v })).toMatch(/MEETINGS_SINCE/);
    }
  });

  it('FFMPEG_PATH is kept as given', () => {
    const path = String.raw`C:\ffmpeg\bin\ffmpeg.exe`;
    expect(parseEnv({ FFMPEG_PATH: path }).FFMPEG_PATH).toBe(path);
  });
});

describe('speech-to-text settings', () => {
  it('apply defaults: no provider, no key, 88 rupees per dollar', () => {
    const env = parseEnv({});
    expect(env.STT_PROVIDER).toBe('none');
    expect(env.STT_API_KEY).toBeUndefined();
    expect(env.INR_PER_USD).toBe(88);
  });

  it('accepts each provider with a key', () => {
    for (const p of ['sarvam', 'elevenlabs', 'openai'] as const) {
      expect(parseEnv({ STT_PROVIDER: p, STT_API_KEY: 'k' }).STT_PROVIDER).toBe(p);
    }
    expect(envError({ STT_PROVIDER: 'whisper' })).toMatch(/STT_PROVIDER/);
  });

  it('none needs no key', () => {
    expect(parseEnv({ STT_PROVIDER: 'none' }).STT_API_KEY).toBeUndefined();
  });

  it('a provider without STT_API_KEY is an error naming STT_API_KEY', () => {
    for (const p of ['sarvam', 'elevenlabs', 'openai']) expect(envError({ STT_PROVIDER: p })).toMatch(/STT_API_KEY/);
    expect(envError({ STT_PROVIDER: 'sarvam', STT_API_KEY: '' })).toMatch(/STT_API_KEY/);
  });

  it('INR_PER_USD is from 40 to 200', () => {
    expect(parseEnv({ INR_PER_USD: '40' }).INR_PER_USD).toBe(40);
    expect(parseEnv({ INR_PER_USD: '200' }).INR_PER_USD).toBe(200);
    for (const v of ['39', '8800', 'Infinity', 'rupees']) expect(envError({ INR_PER_USD: v })).toMatch(/INR_PER_USD/);
  });

  it('requireKey reports a missing STT_API_KEY by name and returns a set one', () => {
    expect(() => requireKey(parseEnv({}), 'STT_API_KEY')).toThrowError('STT_API_KEY is not configured');
    expect(requireKey(parseEnv({ STT_PROVIDER: 'openai', STT_API_KEY: 'k' }), 'STT_API_KEY')).toBe('k');
  });
});

describe('setting values never appear in errors', () => {
  const SECRET = 'zz-distinctive-secret-zz';

  it('for every new setting', () => {
    const cases: Record<string, string>[] = [
      { MEETINGS_ENABLED: SECRET },
      { TEAM_EMAIL_DOMAINS: SECRET },
      { TEAM_EMAIL_DOMAINS: `${SECRET}.com,gmail.com` },
      { MEETING_POLL_MINUTES: SECRET },
      { MEETING_MAX_MINUTES: SECRET },
      { MEETINGS_SINCE: SECRET },
      { STT_PROVIDER: SECRET },
      { INR_PER_USD: SECRET },
      { STT_PROVIDER: 'sarvam', MEETINGS_ENABLED: 'true', ANTHROPIC_API_KEY: SECRET, GOOGLE_OAUTH_CLIENT_SECRET: SECRET, FFMPEG_PATH: SECRET },
    ];
    for (const c of cases) {
      const msg = envError(c);
      expect(msg).toMatch(/^Invalid configuration in: /);
      expect(msg).not.toContain(SECRET);
    }
  });

  it('a set STT_API_KEY is never echoed when another setting is wrong', () => {
    const msg = envError({ STT_PROVIDER: 'openai', STT_API_KEY: SECRET, INR_PER_USD: '1' });
    expect(msg).toMatch(/INR_PER_USD/);
    expect(msg).not.toContain(SECRET);
  });
});

describe('.env.example', () => {
  it('lists every meeting and speech-to-text setting, and its placeholders parse to the defaults', () => {
    const vars = parseDotenv(readFileSync('.env.example', 'utf8'));
    const names = ['MEETINGS_ENABLED', 'TEAM_EMAIL_DOMAINS', 'MEETING_POLL_MINUTES', 'MEETING_MAX_MINUTES', 'MEETINGS_SINCE', 'FFMPEG_PATH', 'STT_PROVIDER', 'STT_API_KEY', 'INR_PER_USD'];
    for (const n of names) expect(Object.keys(vars)).toContain(n);
    expect(vars.STT_API_KEY).toBe('');
    expect(parseEnv(vars)).toMatchObject({ MEETINGS_ENABLED: false, TEAM_EMAIL_DOMAINS: [], MEETING_POLL_MINUTES: 5, MEETING_MAX_MINUTES: 180, STT_PROVIDER: 'none', INR_PER_USD: 88 });
  });
});
