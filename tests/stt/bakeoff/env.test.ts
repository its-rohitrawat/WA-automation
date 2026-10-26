import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KEY_NAMES, loadBakeoffEnv, parseBakeoffEnv } from '../../../src/stt/bakeoff/env.ts';

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

  it('accepts a rupee rate from 40 to 200 only, naming the variable and not the value', () => {
    expect(() => parseBakeoffEnv({ INR_PER_USD: '8800' })).toThrow(/INR_PER_USD/);
    expect(() => parseBakeoffEnv({ INR_PER_USD: '8800' })).not.toThrow(/8800/);
    expect(() => parseBakeoffEnv({ INR_PER_USD: '39' })).toThrow(/INR_PER_USD/);
    expect(() => parseBakeoffEnv({ INR_PER_USD: 'Infinity' })).toThrow(/INR_PER_USD/);
    expect(parseBakeoffEnv({ INR_PER_USD: '40' }).INR_PER_USD).toBe(40);
    expect(parseBakeoffEnv({ INR_PER_USD: '200' }).INR_PER_USD).toBe(200);
  });

  it('maps each provider to its key name', () => {
    expect(KEY_NAMES).toEqual({ sarvam: 'SARVAM_API_KEY', elevenlabs: 'ELEVENLABS_API_KEY', openai: 'OPENAI_API_KEY' });
  });
});

describe('loadBakeoffEnv', () => {
  const envFile = (text: string): string => {
    const path = join(mkdtempSync(join(tmpdir(), 'stt-env-')), '.env');
    writeFileSync(path, text);
    return path;
  };

  it('lets a value in the file beat the same variable in the shell', () => {
    const file = envFile('OPENAI_API_KEY=from-file\nINR_PER_USD=90\n');
    const env = loadBakeoffEnv(file, { OPENAI_API_KEY: 'from-shell', INR_PER_USD: '95', SARVAM_API_KEY: 'shell-only' });
    expect(env).toMatchObject({ OPENAI_API_KEY: 'from-file', INR_PER_USD: 90, SARVAM_API_KEY: 'shell-only' });
  });

  it('lets an empty value in the file hide a shell key, so a stray key from another account is never used', () => {
    expect(loadBakeoffEnv(envFile('OPENAI_API_KEY=\n'), { OPENAI_API_KEY: 'from-shell' }).OPENAI_API_KEY).toBeUndefined();
  });

  it('never puts the file values into process.env, which ffmpeg inherits', () => {
    loadBakeoffEnv(envFile('STT_BAKEOFF_TEST_ONLY=1\n'), {});
    expect(process.env['STT_BAKEOFF_TEST_ONLY']).toBeUndefined();
  });

  it('reads a file saved with a byte-order mark', () => {
    expect(loadBakeoffEnv(envFile('\uFEFFSARVAM_API_KEY=k\r\n'), {}).SARVAM_API_KEY).toBe('k');
  });

  it('uses the shell alone when there is no file', () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'stt-env-')), '.env');
    expect(loadBakeoffEnv(missing, { ELEVENLABS_API_KEY: 'e' })).toEqual({ ELEVENLABS_API_KEY: 'e', INR_PER_USD: 88 });
  });

  it('names a bad file setting only', () => {
    expect(() => loadBakeoffEnv(envFile('INR_PER_USD=8800\n'), {})).toThrow(/INR_PER_USD/);
    expect(() => loadBakeoffEnv(envFile('INR_PER_USD=8800\n'), {})).not.toThrow(/8800/);
  });
});
