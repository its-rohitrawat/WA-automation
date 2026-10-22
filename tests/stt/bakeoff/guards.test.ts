import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { saveSourcePrint, sourceChanged, sourcePrint, takeRunLock } from '../../../src/stt/bakeoff/guards.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stt-guards-'));
});

describe('takeRunLock', () => {
  it('creates the folder and run.lock, and returns its path', () => {
    const out = join(dir, 'bakeoff-out');
    const lock = takeRunLock(out, 'started now');
    expect(lock).toBe(join(out, 'run.lock'));
    expect(readFileSync(join(out, 'run.lock'), 'utf8')).toBe('started now\n');
  });

  it('returns null while another run holds the lock, and leaves its file alone', () => {
    expect(takeRunLock(dir, 'first')).not.toBeNull();
    expect(takeRunLock(dir, 'second')).toBeNull();
    expect(readFileSync(join(dir, 'run.lock'), 'utf8')).toBe('first\n');
  });
});

describe('source fingerprint', () => {
  const mp3 = (): string => join(dir, 'voice-a-12345678.mp3');
  const recording = (): string => join(dir, 'a.ogg');

  beforeEach(() => {
    writeFileSync(recording(), 'audio');
  });

  it('reads size and modification time', () => {
    const st = statSync(recording());
    expect(sourcePrint(recording())).toEqual({ size: 5, mtimeMs: st.mtimeMs });
  });

  it('is unchanged for a recording that was never prepared', () => {
    expect(sourceChanged(mp3(), sourcePrint(recording()))).toBe(false);
  });

  it('is unchanged when the saved print matches', () => {
    writeFileSync(mp3(), 'mp3');
    saveSourcePrint(mp3(), sourcePrint(recording()));
    expect(existsSync(`${mp3()}.source.json`)).toBe(true);
    expect(sourceChanged(mp3(), sourcePrint(recording()))).toBe(false);
  });

  it('is changed when the MP3 exists without a saved print', () => {
    writeFileSync(mp3(), 'mp3');
    expect(sourceChanged(mp3(), sourcePrint(recording()))).toBe(true);
  });

  it('is changed when the size or the time differs', () => {
    writeFileSync(mp3(), 'mp3');
    const now = sourcePrint(recording());
    saveSourcePrint(mp3(), now);
    expect(sourceChanged(mp3(), { ...now, size: now.size + 1 })).toBe(true);
    expect(sourceChanged(mp3(), { ...now, mtimeMs: now.mtimeMs + 1 })).toBe(true);
  });

  it('is changed when a saved print differs even though the MP3 is gone', () => {
    const now = sourcePrint(recording());
    saveSourcePrint(mp3(), { ...now, size: 99 });
    expect(sourceChanged(mp3(), now)).toBe(true);
  });

  it('is changed when the saved print cannot be read', () => {
    writeFileSync(mp3(), 'mp3');
    writeFileSync(`${mp3()}.source.json`, '{not json');
    expect(sourceChanged(mp3(), sourcePrint(recording()))).toBe(true);
    writeFileSync(`${mp3()}.source.json`, '{"size":"5"}');
    expect(sourceChanged(mp3(), sourcePrint(recording()))).toBe(true);
  });
});
