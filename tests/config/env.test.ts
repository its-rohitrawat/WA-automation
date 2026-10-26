import { readFileSync } from 'node:fs';
import { parseEnv as parseDotenv } from 'node:util';
import { describe, expect, it } from 'vitest';
import { maskNumber, parseEnv, reportRecipient, reportSettings, requireKey } from '../../src/config/env.ts';

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
    const on = { TEAM_EMAIL_DOMAINS: 'ourstudio.example' };
    expect(parseEnv({ ...on, MEETINGS_ENABLED: 'true' }).MEETINGS_ENABLED).toBe(true);
    expect(parseEnv({ ...on, MEETINGS_ENABLED: '1' }).MEETINGS_ENABLED).toBe(true);
    expect(parseEnv({ MEETINGS_ENABLED: 'false' }).MEETINGS_ENABLED).toBe(false);
    expect(parseEnv({ MEETINGS_ENABLED: '0' }).MEETINGS_ENABLED).toBe(false);
    for (const v of ['yes', 'TRUE', 'on', '2']) expect(envError({ ...on, MEETINGS_ENABLED: v })).toMatch(/MEETINGS_ENABLED/);
  });

  it('TEAM_EMAIL_DOMAINS is a trimmed, lower-cased, comma-separated list', () => {
    expect(parseEnv({ TEAM_EMAIL_DOMAINS: ' OurStudio.example , ourstudio.co.example,' }).TEAM_EMAIL_DOMAINS).toEqual(['ourstudio.example', 'ourstudio.co.example']);
  });

  it('TEAM_EMAIL_DOMAINS drops repeats after lower-casing', () => {
    expect(parseEnv({ TEAM_EMAIL_DOMAINS: 'ourstudio.example,OURSTUDIO.EXAMPLE, ourstudio.co.example ,OurStudio.example' }).TEAM_EMAIL_DOMAINS).toEqual(['ourstudio.example', 'ourstudio.co.example']);
  });

  it('TEAM_EMAIL_DOMAINS is required when meetings are on, and the error names it', () => {
    const msg = envError({ MEETINGS_ENABLED: 'true' });
    expect(msg).toMatch(/TEAM_EMAIL_DOMAINS/);
    expect(msg).toMatch(/MEETINGS_ENABLED/);
    expect(envError({ MEETINGS_ENABLED: 'true', TEAM_EMAIL_DOMAINS: ' , ' })).toMatch(/TEAM_EMAIL_DOMAINS/);
    expect(parseEnv({ MEETINGS_ENABLED: 'true', TEAM_EMAIL_DOMAINS: 'ourstudio.example' }).TEAM_EMAIL_DOMAINS).toEqual(['ourstudio.example']);
  });

  it('TEAM_EMAIL_DOMAINS refuses public mail domains and bad shapes without echoing them', () => {
    const pub = envError({ TEAM_EMAIL_DOMAINS: 'zz-ourstudio-zz.example,Gmail.com' });
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

describe('morning report settings', () => {
  it('is off by default, with 06:00 to 12:00 IST', () => {
    const env = parseEnv({ REPORT_ENABLED: '', REPORT_TIME: '', REPORT_DEADLINE: '', REPORT_RECIPIENT: '' });
    expect(reportSettings(env)).toEqual({ enabled: false, time: '06:00', deadline: '12:00' });
    expect(env.REPORT_RECIPIENT).toBeUndefined();
  });

  it('turns on only with REPORT_ENABLED=true and a recipient', () => {
    const env = parseEnv({ REPORT_ENABLED: 'true', REPORT_RECIPIENT: '919800000000', REPORT_TIME: '06:30', REPORT_DEADLINE: '11:00' });
    expect(reportSettings(env)).toEqual({ enabled: true, time: '06:30', deadline: '11:00' });
    expect(reportRecipient(env)).toBe('919800000000');
    expect(parseEnv({ REPORT_ENABLED: 'false' }).REPORT_ENABLED).toBe(false);
  });

  it('refuses REPORT_ENABLED=true without a recipient, naming the variable', () => {
    expect(() => parseEnv({ REPORT_ENABLED: 'true' })).toThrowError('Invalid configuration in: REPORT_RECIPIENT');
    expect(() => reportRecipient(parseEnv({}))).toThrowError('REPORT_RECIPIENT is not configured');
  });

  it('refuses a recipient that is not digits only, without echoing it', () => {
    const startsValidBreaksLater = ['919800000000@g.us', '919800000000 ', '919800000000x', '1234567890123456'];
    // Without the 91, a 10-digit mobile reads as a foreign number (9812345678 would be +98, Iran).
    const notIndianMobile = ['9812345678', '09812345678', '0919812345678', '915812345678', '91981234567', '9198123456789', '12345678', '123456789012345', '449812345678'];
    for (const bad of ['+919800000000', '98000 00000', '1234', ...startsValidBreaksLater, ...notIndianMobile]) {
      try {
        parseEnv({ REPORT_RECIPIENT: bad });
        expect.unreachable();
      } catch (e) {
        expect((e as Error).message).toBe('Invalid configuration in: REPORT_RECIPIENT');
        expect((e as Error).message).not.toContain(bad);
      }
    }
  });

  it('accepts only 91 and a 10-digit Indian mobile', () => {
    for (const good of ['919812345678', '916000000000', '917000000000', '918999999999']) {
      expect(parseEnv({ REPORT_RECIPIENT: good }).REPORT_RECIPIENT).toBe(good);
    }
  });

  it('refuses bad times, and a deadline that is not after the start', () => {
    for (const bad of ['6:00', '24:00', '23:60', '06:000', 'x06:00', ' 06:00']) {
      expect(() => parseEnv({ REPORT_TIME: bad, REPORT_DEADLINE: '23:59' }), bad).toThrowError(/REPORT_TIME/);
    }
    for (const bad of ['9:00', '24:00', '12:60']) {
      expect(() => parseEnv({ REPORT_TIME: '00:00', REPORT_DEADLINE: bad }), bad).toThrowError(/REPORT_DEADLINE/);
    }
    expect(reportSettings(parseEnv({ REPORT_TIME: '00:00', REPORT_DEADLINE: '23:59' }))).toEqual({ enabled: false, time: '00:00', deadline: '23:59' });
    expect(() => parseEnv({ REPORT_ENABLED: 'yes' })).toThrowError(/REPORT_ENABLED/);
    expect(() => parseEnv({ REPORT_TIME: '12:00', REPORT_DEADLINE: '12:00' })).toThrowError('Invalid configuration in: REPORT_DEADLINE');
  });

  it('masks a number down to its last 4 digits', () => {
    expect(maskNumber('919812345678')).toBe('…5678');
  });
});
