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
    for (const bad of ['+919800000000', '98000 00000', '1234']) {
      try {
        parseEnv({ REPORT_RECIPIENT: bad });
        expect.unreachable();
      } catch (e) {
        expect((e as Error).message).toBe('Invalid configuration in: REPORT_RECIPIENT');
        expect((e as Error).message).not.toContain(bad);
      }
    }
  });

  it('refuses bad times, and a deadline that is not after the start', () => {
    expect(() => parseEnv({ REPORT_TIME: '6:00' })).toThrowError(/REPORT_TIME/);
    expect(() => parseEnv({ REPORT_ENABLED: 'yes' })).toThrowError(/REPORT_ENABLED/);
    expect(() => parseEnv({ REPORT_TIME: '12:00', REPORT_DEADLINE: '12:00' })).toThrowError('Invalid configuration in: REPORT_DEADLINE');
  });

  it('masks a number down to its last 4 digits', () => {
    expect(maskNumber('919812345678')).toBe('…5678');
  });
});
