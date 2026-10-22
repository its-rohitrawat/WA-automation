import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findSamples, insideGitRepo } from '../../../src/stt/bakeoff/samples.ts';

describe('findSamples', () => {
  it('finds audio and video files in voice-notes and meetings, sorted, with unique ids', () => {
    const root = mkdtempSync(join(tmpdir(), 'stt-samples-'));
    mkdirSync(join(root, 'voice-notes', 'sub'), { recursive: true });
    mkdirSync(join(root, 'meetings'));
    for (const f of ['b.ogg', 'A note.opus', 'a-note.ogg', 'readme.txt', 'मीटिंग.OGG']) writeFileSync(join(root, 'voice-notes', f), 'x');
    writeFileSync(join(root, 'voice-notes', 'sub', 'hidden.ogg'), 'x');
    writeFileSync(join(root, 'meetings', 'Client Call 1.mp4'), 'x');
    expect(findSamples(root)).toEqual([
      { id: 'voice-a-note', kind: 'voice', path: join(root, 'voice-notes', 'A note.opus') },
      { id: 'voice-a-note-2', kind: 'voice', path: join(root, 'voice-notes', 'a-note.ogg') },
      { id: 'voice-b', kind: 'voice', path: join(root, 'voice-notes', 'b.ogg') },
      { id: 'voice-file', kind: 'voice', path: join(root, 'voice-notes', 'मीटिंग.OGG') },
      { id: 'meeting-client-call-1', kind: 'meeting', path: join(root, 'meetings', 'Client Call 1.mp4') },
    ]);
  });

  it('returns nothing when the folders are missing', () => {
    expect(findSamples(mkdtempSync(join(tmpdir(), 'stt-empty-')))).toEqual([]);
  });
});

describe('insideGitRepo', () => {
  it('is true for a folder below one holding .git', () => {
    const root = mkdtempSync(join(tmpdir(), 'stt-git-'));
    mkdirSync(join(root, 'repo', '.git'), { recursive: true });
    expect(insideGitRepo(join(root, 'repo', 'x', 'y'))).toBe(true);
  });

  it('is true for a worktree, whose .git is a file', () => {
    const root = mkdtempSync(join(tmpdir(), 'stt-wt-'));
    writeFileSync(join(root, '.git'), 'gitdir: elsewhere');
    expect(insideGitRepo(join(root, 'out'))).toBe(true);
  });

  it('is false elsewhere', () => {
    expect(insideGitRepo(mkdtempSync(join(tmpdir(), 'stt-plain-')))).toBe(false);
  });
});
