import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../src/config/env.ts';
import { checkLocalEngineFiles } from '../src/stt/local.ts';
import { createLogger } from '../src/util/logger.ts';
import { buildVoiceDeps } from '../src/voiceDeps.ts';

const dirs: string[] = [];
const KEY = 'test-voice-key-value';

function setup(vars: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'wa-voice-deps-'));
  dirs.push(dir);
  const bin = join(dir, 'transcribe-cli');
  const model = join(dir, 'voxtral-model.gguf');
  const env = parseEnv({ DATA_DIR: dir, GROUPS_FILE: join(dir, 'groups.json'), ...vars });
  const lines: string[] = [];
  const log = createLogger('info', new Writable({ write(c, _e, cb) { lines.push(String(c)); cb(); } }));
  const out = () => lines.join('');
  const findFfmpeg = vi.fn(async (_configured: string | undefined): Promise<string | null> => 'ffmpeg');
  return { dir, bin, model, env, log, out, findFfmpeg };
}

/** A local setup whose two files may be created on disk. */
function local(files: { bin: boolean; model: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'wa-voice-deps-local-'));
  dirs.push(dir);
  const bin = join(dir, 'transcribe-cli');
  const model = join(dir, 'voxtral-model.gguf');
  if (files.bin) writeFileSync(bin, 'bin');
  if (files.model) writeFileSync(model, 'model');
  return { ...setup({ VOICE_STT_PROVIDER: 'local', STT_LOCAL_BIN: bin, STT_LOCAL_MODEL: model }), bin, model };
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('buildVoiceDeps (Phase 2b Task 10)', () => {
  it('VOICE_STT_PROVIDER none: no transcriber, no problem, no ffmpeg search and no file check', async () => {
    const { env, log, out, findFfmpeg } = setup({ STT_MAX_SECONDS: '900' });
    const check = vi.fn(checkLocalEngineFiles);
    const d = await buildVoiceDeps(env, { findFfmpeg, check, log });
    expect(d).toEqual({ voice: null, maxVoiceSeconds: 900, voiceProblem: null });
    expect(findFfmpeg).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(out()).toContain('"code":"stt_none"');
  });

  it('local with both files and ffmpeg: a free local transcriber, and no problem', async () => {
    const { env, log, out, findFfmpeg, bin, model } = local({ bin: true, model: true });
    const d = await buildVoiceDeps(env, { findFfmpeg, check: checkLocalEngineFiles, log });
    expect(d.voiceProblem).toBeNull();
    expect(d.maxVoiceSeconds).toBe(600);
    expect(d.voice).toMatchObject({ provider: 'local', costsNothing: true, canForget: false });
    expect(d.voice!.canSend('audio/ogg; codecs=opus')).toBe(true);
    expect(findFfmpeg).toHaveBeenCalledWith(undefined);
    for (const path of [bin, model]) expect(out()).not.toContain(path.replaceAll('\\', '\\\\'));
    expect(out()).not.toContain('voxtral-model');
  });

  it('passes FFMPEG_PATH to the ffmpeg search', async () => {
    const { dir, log, findFfmpeg } = setup({});
    const bin = join(dir, 'transcribe-cli');
    const model = join(dir, 'model.gguf');
    writeFileSync(bin, 'bin');
    writeFileSync(model, 'model');
    const ffmpegPath = join(dir, 'ffmpeg.exe');
    const env = parseEnv({ DATA_DIR: dir, GROUPS_FILE: join(dir, 'g.json'), VOICE_STT_PROVIDER: 'local', STT_LOCAL_BIN: bin, STT_LOCAL_MODEL: model, FFMPEG_PATH: ffmpegPath });
    await buildVoiceDeps(env, { findFfmpeg, check: checkLocalEngineFiles, log });
    expect(findFfmpeg).toHaveBeenCalledWith(ffmpegPath);
  });

  it.each([
    ['STT_LOCAL_BIN', { bin: false, model: true }, 'local_not_set_up_bin'],
    ['STT_LOCAL_MODEL', { bin: true, model: false }, 'local_not_set_up_model'],
  ] as const)('local with %s missing: voice is off, the problem names the setting, and so does the warning (never its path)', async (name, files, problem) => {
    const { env, log, out, findFfmpeg, bin, model } = local(files);
    const d = await buildVoiceDeps(env, { findFfmpeg, check: checkLocalEngineFiles, log });
    expect(d).toEqual({ voice: null, maxVoiceSeconds: 600, voiceProblem: problem });
    expect(out()).toContain('"code":"local_not_set_up"');
    expect(out()).toContain(`"setting":"${name}"`);
    expect(out()).toContain('"level":40'); // warn
    for (const path of [bin, model]) expect(out()).not.toContain(path.replaceAll('\\', '\\\\'));
    expect(out()).not.toContain('transcribe-cli');
    expect(out()).not.toContain('voxtral-model');
  });

  it('local whose check throws is treated as not set up, and the service keeps running', async () => {
    const { env, log, out, findFfmpeg } = local({ bin: true, model: true });
    const check = vi.fn((): 'STT_LOCAL_BIN' | 'STT_LOCAL_MODEL' | null => {
      throw new Error('stat exploded');
    });
    const d = await buildVoiceDeps(env, { findFfmpeg, check, log });
    expect(d).toEqual({ voice: null, maxVoiceSeconds: 600, voiceProblem: 'local_not_set_up_bin' });
    expect(out()).toContain('"setting":"STT_LOCAL_BIN"');
    expect(out()).not.toContain('stat exploded');
  });

  type Search = (configured: string | undefined) => Promise<string | null>;
  const notFound: Search = async () => null;
  const searchThrows: Search = async () => {
    throw new Error('spawn failed C:\\secret\\ffmpeg.exe');
  };
  it.each([
    ['not found', notFound],
    ['search throws', searchThrows],
  ] as const)('no ffmpeg (%s): the problem is no_ffmpeg, voice notes are kept but not transcribed', async (_label, impl) => {
    const { env, log, out } = local({ bin: true, model: true });
    const findFfmpeg = vi.fn(impl);
    const d = await buildVoiceDeps(env, { findFfmpeg, check: checkLocalEngineFiles, log });
    expect(d.voiceProblem).toBe('no_ffmpeg');
    // The transcriber is still built: every note is kept as format_not_supported, for cli transcribe-voice later.
    expect(d.voice).toMatchObject({ provider: 'local', costsNothing: true });
    expect(d.voice!.canSend('audio/ogg; codecs=opus')).toBe(false);
    expect(out()).toContain('"code":"no_ffmpeg_voice"');
    expect(out()).toContain('voice notes are kept but not transcribed');
    expect(out()).not.toContain('secret');
  });

  it('a paid provider: the paid transcriber, and the key never reaches the log', async () => {
    const { env, log, out, findFfmpeg } = setup({ STT_PROVIDER: 'elevenlabs', VOICE_STT_PROVIDER: 'elevenlabs', STT_API_KEY: KEY });
    const check = vi.fn(checkLocalEngineFiles);
    const d = await buildVoiceDeps(env, { findFfmpeg, check, log });
    expect(d.voiceProblem).toBeNull();
    expect(d.voice).toMatchObject({ provider: 'elevenlabs', costsNothing: false, canForget: true });
    expect(check).not.toHaveBeenCalled(); // the local files matter only for local
    expect(findFfmpeg).toHaveBeenCalledTimes(1);
    expect(out()).not.toContain(KEY);
  });

  it('a paid provider without ffmpeg: no_ffmpeg too', async () => {
    const { env, log, out } = setup({ STT_PROVIDER: 'sarvam', VOICE_STT_PROVIDER: 'sarvam', STT_API_KEY: KEY });
    const d = await buildVoiceDeps(env, { findFfmpeg: async () => null, check: checkLocalEngineFiles, log });
    expect(d.voiceProblem).toBe('no_ffmpeg');
    expect(d.voice).toMatchObject({ provider: 'sarvam', costsNothing: false });
    expect(out()).not.toContain(KEY);
  });
});
