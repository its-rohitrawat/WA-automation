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
