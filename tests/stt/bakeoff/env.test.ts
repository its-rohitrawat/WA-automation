import { describe, expect, it } from 'vitest';
import { KEY_NAMES, parseBakeoffEnv } from '../../../src/stt/bakeoff/env.ts';

describe('parseBakeoffEnv', () => {
  it('treats every key as optional and defaults the rupee rate', () => {
    expect(parseBakeoffEnv({})).toEqual({ INR_PER_USD: 88 });
  });

  it('reads the bake-off settings and ignores everything else', () => {
    const env = parseBakeoffEnv({ SARVAM_API_KEY: 's', FFMPEG_PATH: 'C:\\f.exe', INR_PER_USD: '90', ANTHROPIC_API_KEY: 'other', EMPTY: '' });
    expect(env).toEqual({ SARVAM_API_KEY: 's', FFMPEG_PATH: 'C:\\f.exe', INR_PER_USD: 90 });
  });

  it('treats an empty value as unset', () => {
    expect(parseBakeoffEnv({ OPENAI_API_KEY: '' }).OPENAI_API_KEY).toBeUndefined();
  });

  it('names a bad setting without echoing its value', () => {
    expect(() => parseBakeoffEnv({ INR_PER_USD: 'secret-looking-value' })).toThrow(/INR_PER_USD/);
    expect(() => parseBakeoffEnv({ INR_PER_USD: 'secret-looking-value' })).not.toThrow(/secret-looking-value/);
  });

  it('maps each provider to its key name', () => {
    expect(KEY_NAMES).toEqual({ sarvam: 'SARVAM_API_KEY', elevenlabs: 'ELEVENLABS_API_KEY', openai: 'OPENAI_API_KEY' });
  });
});
