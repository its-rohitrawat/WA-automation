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
    const env = parseEnv({ STT_PROVIDER: 'none' });
    expect(env.STT_API_KEY).toBeUndefined();
    expect(env.STT_MAX_SECONDS).toBe(600);
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

  it('STT_MAX_SECONDS defaults to 600', () => {
    expect(parseEnv({}).STT_MAX_SECONDS).toBe(600);
  });

  it('STT_MAX_SECONDS is a whole number from 30 to 900, refused without echoing the value', () => {
    expect(parseEnv({ STT_MAX_SECONDS: '30' }).STT_MAX_SECONDS).toBe(30);
    expect(parseEnv({ STT_MAX_SECONDS: '900' }).STT_MAX_SECONDS).toBe(900);
    for (const v of ['29', '901', 'abc', '60.5']) {
      const msg = envError({ STT_MAX_SECONDS: v });
      expect(msg).toMatch(/STT_MAX_SECONDS/);
      expect(msg).not.toContain(v);
    }
  });

  it('requireKey reports a missing STT_API_KEY by name and returns a set one', () => {
    expect(() => requireKey(parseEnv({}), 'STT_API_KEY')).toThrowError('STT_API_KEY is not configured');
    expect(requireKey(parseEnv({ STT_PROVIDER: 'openai', STT_API_KEY: 'k' }), 'STT_API_KEY')).toBe('k');
  });
});

describe('voice-note speech-to-text settings (local engine)', () => {
  const BIN = '/opt/stt/transcribe.cpp/build/bin/transcribe-cli';
  const MODEL = '/opt/stt/models/Voxtral-Mini-3B-2507-Q4_K_M.gguf';
  const local = { VOICE_STT_PROVIDER: 'local', STT_LOCAL_BIN: BIN, STT_LOCAL_MODEL: MODEL };

  it('apply defaults: voice notes off, voxtral, no paths, 8 threads, 1800 seconds, Hindi', () => {
    const env = parseEnv({});
    expect(env.VOICE_STT_PROVIDER).toBe('none');
    expect(env.STT_LOCAL_ENGINE).toBe('voxtral');
    expect(env.STT_LOCAL_BIN).toBeUndefined();
    expect(env.STT_LOCAL_MODEL).toBeUndefined();
    expect(env.STT_LOCAL_THREADS).toBe(8);
    expect(env.STT_LOCAL_TIMEOUT_SECONDS).toBe(1800);
    expect(env.STT_LOCAL_LANGUAGE).toBe('hi');
  });

  it('leaves STT_PROVIDER alone: meetings keep their own provider', () => {
    const env = parseEnv({ ...local, STT_PROVIDER: 'sarvam', STT_API_KEY: 'k' });
    expect(env.STT_PROVIDER).toBe('sarvam');
    expect(env.VOICE_STT_PROVIDER).toBe('local');
  });

  it('local needs no key, and takes both paths as given', () => {
    const env = parseEnv(local);
    expect(env.STT_API_KEY).toBeUndefined();
    expect(env.STT_LOCAL_BIN).toBe(BIN);
    expect(env.STT_LOCAL_MODEL).toBe(MODEL);
  });

  it('local without STT_LOCAL_BIN or STT_LOCAL_MODEL is an error naming the missing one', () => {
    const noBin = envError({ VOICE_STT_PROVIDER: 'local', STT_LOCAL_MODEL: MODEL });
    expect(noBin).toMatch(/STT_LOCAL_BIN/);
    expect(noBin).not.toMatch(/STT_LOCAL_MODEL/);
    const noModel = envError({ VOICE_STT_PROVIDER: 'local', STT_LOCAL_BIN: BIN });
    expect(noModel).toMatch(/STT_LOCAL_MODEL/);
    expect(noModel).not.toMatch(/STT_LOCAL_BIN/);
    const neither = envError({ VOICE_STT_PROVIDER: 'local', STT_LOCAL_BIN: '', STT_LOCAL_MODEL: '' });
    expect(neither).toMatch(/STT_LOCAL_BIN/);
    expect(neither).toMatch(/STT_LOCAL_MODEL/);
  });

  it('both paths must be absolute, only for local, refused without echoing them', () => {
    for (const name of ['STT_LOCAL_BIN', 'STT_LOCAL_MODEL']) {
      for (const rel of ['zz-relative-zz/transcribe-cli', './zz-relative-zz', 'zz-relative-zz', '-zz-relative-zz']) {
        const msg = envError({ ...local, [name]: rel });
        expect(msg).toMatch(new RegExp(`${name} must be an absolute path`));
        expect(msg).not.toContain('zz-relative-zz');
      }
    }
  });

  it('a stray relative path while voice notes are not local never stops the service', () => {
    for (const provider of [{}, { VOICE_STT_PROVIDER: 'none' }, { VOICE_STT_PROVIDER: 'openai', STT_PROVIDER: 'openai', STT_API_KEY: 'k' }]) {
      const env = parseEnv({ ...provider, STT_LOCAL_BIN: 'zz-relative-zz/transcribe-cli', STT_LOCAL_MODEL: './model.gguf' });
      expect(env.STT_LOCAL_BIN).toBe('zz-relative-zz/transcribe-cli');
    }
    // Paths outside local are kept, so a later switch to local needs no other change.
    expect(parseEnv({ STT_LOCAL_BIN: BIN }).STT_LOCAL_BIN).toBe(BIN);
  });

  it('refuses an unknown VOICE_STT_PROVIDER by name, without echoing it', () => {
    for (const v of ['whisper', 'Local', 'LOCAL', 'voxtral', 'zz-unknown-zz', 'local ']) {
      const msg = envError({ VOICE_STT_PROVIDER: v, STT_LOCAL_BIN: BIN, STT_LOCAL_MODEL: MODEL });
      expect(msg).toMatch(/VOICE_STT_PROVIDER/);
      expect(msg).not.toContain('zz-unknown-zz');
    }
  });

  it('accepts each engine and language, and refuses others by name', () => {
    for (const e of ['voxtral', 'qwen3-asr', 'whisper'] as const) expect(parseEnv({ ...local, STT_LOCAL_ENGINE: e }).STT_LOCAL_ENGINE).toBe(e);
    for (const l of ['hi', 'en', 'auto'] as const) expect(parseEnv({ ...local, STT_LOCAL_LANGUAGE: l }).STT_LOCAL_LANGUAGE).toBe(l);
    for (const v of ['llama', 'Voxtral', 'qwen3']) expect(envError({ STT_LOCAL_ENGINE: v })).toMatch(/STT_LOCAL_ENGINE/);
    for (const v of ['hindi', 'HI', 'fr']) expect(envError({ STT_LOCAL_LANGUAGE: v })).toMatch(/STT_LOCAL_LANGUAGE/);
    expect(envError({ VOICE_STT_PROVIDER: 'whisper' })).toMatch(/VOICE_STT_PROVIDER/);
  });

  it('STT_LOCAL_THREADS is a whole number from 1 to 64', () => {
    expect(parseEnv({ STT_LOCAL_THREADS: '1' }).STT_LOCAL_THREADS).toBe(1);
    expect(parseEnv({ STT_LOCAL_THREADS: '64' }).STT_LOCAL_THREADS).toBe(64);
    for (const v of ['0', '65', '4.5', 'all']) expect(envError({ STT_LOCAL_THREADS: v })).toMatch(/STT_LOCAL_THREADS/);
  });

  it('STT_LOCAL_TIMEOUT_SECONDS is a whole number from 60 to 7200', () => {
    expect(parseEnv({ STT_LOCAL_TIMEOUT_SECONDS: '60' }).STT_LOCAL_TIMEOUT_SECONDS).toBe(60);
    expect(parseEnv({ STT_LOCAL_TIMEOUT_SECONDS: '7200' }).STT_LOCAL_TIMEOUT_SECONDS).toBe(7200);
    for (const v of ['59', '7201', '90.5', 'long']) expect(envError({ STT_LOCAL_TIMEOUT_SECONDS: v })).toMatch(/STT_LOCAL_TIMEOUT_SECONDS/);
  });

  it('a paid voice provider must be the same as STT_PROVIDER, since both use STT_API_KEY', () => {
    for (const p of ['sarvam', 'elevenlabs', 'openai'] as const) {
      expect(parseEnv({ VOICE_STT_PROVIDER: p, STT_PROVIDER: p, STT_API_KEY: 'k' }).VOICE_STT_PROVIDER).toBe(p);
      expect(envError({ VOICE_STT_PROVIDER: p })).toMatch(/VOICE_STT_PROVIDER/);
    }
    const other = envError({ VOICE_STT_PROVIDER: 'openai', STT_PROVIDER: 'sarvam', STT_API_KEY: 'k' });
    expect(other).toMatch(/VOICE_STT_PROVIDER/);
    expect(other).toMatch(/STT_PROVIDER/);
    // local and none go with any STT_PROVIDER.
    expect(parseEnv({ VOICE_STT_PROVIDER: 'none', STT_PROVIDER: 'openai', STT_API_KEY: 'k' }).VOICE_STT_PROVIDER).toBe('none');
    expect(parseEnv({ ...local, STT_PROVIDER: 'elevenlabs', STT_API_KEY: 'k' }).VOICE_STT_PROVIDER).toBe('local');
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
      { STT_MAX_SECONDS: SECRET },
      { STT_PROVIDER: 'sarvam', MEETINGS_ENABLED: 'true', ANTHROPIC_API_KEY: SECRET, GOOGLE_OAUTH_CLIENT_SECRET: SECRET, FFMPEG_PATH: SECRET },
      { VOICE_STT_PROVIDER: SECRET },
      { VOICE_STT_PROVIDER: 'openai', STT_PROVIDER: 'sarvam', STT_API_KEY: SECRET },
      { STT_LOCAL_ENGINE: SECRET },
      { VOICE_STT_PROVIDER: 'local', STT_LOCAL_BIN: SECRET, STT_LOCAL_MODEL: '/opt/stt/models/m.gguf' },
      { VOICE_STT_PROVIDER: 'local', STT_LOCAL_BIN: '/opt/stt/bin/transcribe-cli', STT_LOCAL_MODEL: SECRET },
      { VOICE_STT_PROVIDER: 'local', STT_LOCAL_BIN: SECRET, STT_LOCAL_MODEL: `${SECRET}/model.gguf` },
      { VOICE_STT_PROVIDER: 'local', STT_LOCAL_BIN: `/opt/${SECRET}/transcribe-cli` },
      { STT_LOCAL_THREADS: SECRET },
      { STT_LOCAL_TIMEOUT_SECONDS: SECRET },
      { STT_LOCAL_LANGUAGE: SECRET },
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
    const names = [
      'MEETINGS_ENABLED', 'TEAM_EMAIL_DOMAINS', 'MEETING_POLL_MINUTES', 'MEETING_MAX_MINUTES', 'MEETINGS_SINCE', 'FFMPEG_PATH', 'STT_PROVIDER', 'STT_API_KEY', 'INR_PER_USD', 'STT_MAX_SECONDS',
      'VOICE_STT_PROVIDER', 'STT_LOCAL_ENGINE', 'STT_LOCAL_BIN', 'STT_LOCAL_MODEL', 'STT_LOCAL_THREADS', 'STT_LOCAL_TIMEOUT_SECONDS', 'STT_LOCAL_LANGUAGE',
    ];
    for (const n of names) expect(Object.keys(vars)).toContain(n);
    expect(vars.REPORT_DAYS).toBe('');
    expect(parseEnv(vars).REPORT_DAYS).toBe('weekdays');
    expect(vars.STT_API_KEY).toBe('');
    expect(vars.STT_LOCAL_BIN).toBe('');
    expect(vars.STT_LOCAL_MODEL).toBe('');
    expect(parseEnv(vars)).toMatchObject({
      MEETINGS_ENABLED: false, TEAM_EMAIL_DOMAINS: [], MEETING_POLL_MINUTES: 5, MEETING_MAX_MINUTES: 180, STT_PROVIDER: 'none', INR_PER_USD: 88, STT_MAX_SECONDS: 600,
      VOICE_STT_PROVIDER: 'none', STT_LOCAL_ENGINE: 'voxtral', STT_LOCAL_THREADS: 8, STT_LOCAL_TIMEOUT_SECONDS: 1800, STT_LOCAL_LANGUAGE: 'hi',
    });
  });
});

describe('morning report settings', () => {
  it('is off by default, with 06:00 to 12:00 IST', () => {
    const env = parseEnv({ REPORT_ENABLED: '', REPORT_TIME: '', REPORT_DEADLINE: '', REPORT_RECIPIENT: '' });
    expect(reportSettings(env)).toEqual({ enabled: false, time: '06:00', deadline: '12:00', days: 'weekdays' });
    expect(env.REPORT_RECIPIENT).toBeUndefined();
  });

  it('turns on only with REPORT_ENABLED=true and a recipient', () => {
    const env = parseEnv({ REPORT_ENABLED: 'true', REPORT_RECIPIENT: '919800000000', REPORT_TIME: '06:30', REPORT_DEADLINE: '11:00' });
    expect(reportSettings(env)).toEqual({ enabled: true, time: '06:30', deadline: '11:00', days: 'weekdays' });
    expect(reportRecipient(env)).toBe('919800000000');
    expect(parseEnv({ REPORT_ENABLED: 'false' }).REPORT_ENABLED).toBe(false);
  });

  it('sends Monday to Friday by default; REPORT_DAYS accepts weekdays, mon-sat and daily', () => {
    expect(parseEnv({}).REPORT_DAYS).toBe('weekdays');
    expect(parseEnv({ REPORT_DAYS: '' }).REPORT_DAYS).toBe('weekdays');
    for (const days of ['weekdays', 'mon-sat', 'daily'] as const) {
      expect(reportSettings(parseEnv({ REPORT_DAYS: days })).days).toBe(days);
    }
  });

  it('refuses a bad REPORT_DAYS, naming only that setting and not echoing the value', () => {
    for (const bad of ['weekend', 'Weekdays', 'mon-fri', ' daily', 'sunday-secret']) {
      try {
        parseEnv({ REPORT_DAYS: bad });
        expect.unreachable();
      } catch (e) {
        expect((e as Error).message).toBe('Invalid configuration in: REPORT_DAYS');
        expect((e as Error).message).not.toContain(bad);
      }
    }
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
    expect(reportSettings(parseEnv({ REPORT_TIME: '00:00', REPORT_DEADLINE: '23:59' }))).toEqual({ enabled: false, time: '00:00', deadline: '23:59', days: 'weekdays' });
    expect(() => parseEnv({ REPORT_ENABLED: 'yes' })).toThrowError(/REPORT_ENABLED/);
    expect(() => parseEnv({ REPORT_TIME: '12:00', REPORT_DEADLINE: '12:00' })).toThrowError('Invalid configuration in: REPORT_DEADLINE');
  });

  it('masks a number down to its last 4 digits', () => {
    expect(maskNumber('919812345678')).toBe('…5678');
  });
});

describe('uptime heartbeat setting', () => {
  it('is off by default and when empty', () => {
    expect(parseEnv({}).HEARTBEAT_URL).toBeUndefined();
    expect(parseEnv({ HEARTBEAT_URL: '' }).HEARTBEAT_URL).toBeUndefined();
  });

  it('accepts an https link', () => {
    const url = 'https://heartbeat.uptimerobot.com/abc123';
    expect(parseEnv({ HEARTBEAT_URL: url }).HEARTBEAT_URL).toBe(url);
  });

  it('refuses a non-https or malformed link, naming the setting without echoing it', () => {
    for (const bad of ['http://heartbeat.uptimerobot.com/abc123', 'heartbeat.uptimerobot.com/abc123', 'not a url', 'ftp://x.y/z']) {
      try {
        parseEnv({ HEARTBEAT_URL: bad });
        expect.unreachable(bad);
      } catch (e) {
        expect((e as Error).message).toBe('Invalid configuration in: HEARTBEAT_URL. HEARTBEAT_URL must be an https:// link');
        expect((e as Error).message).not.toContain(bad);
      }
    }
  });
});
