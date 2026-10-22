import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findSamples, insideGitRepo } from '../../../src/stt/bakeoff/samples.ts';

describe('findSamples', () => {
  it('finds audio and video files in voice-notes and meetings, sorted, with ids from each file name', () => {
    const root = mkdtempSync(join(tmpdir(), 'stt-samples-'));
    mkdirSync(join(root, 'voice-notes', 'sub'), { recursive: true });
    mkdirSync(join(root, 'meetings'));
    for (const f of ['b.ogg', 'A note.opus', 'a-note.ogg', 'readme.txt', 'मीटिंग.OGG']) writeFileSync(join(root, 'voice-notes', f), 'x');
    writeFileSync(join(root, 'voice-notes', 'sub', 'hidden.ogg'), 'x');
    writeFileSync(join(root, 'meetings', 'Client Call 1.mp4'), 'x');
    // The hash is the first 8 hex characters of sha256 of the NFC file name, extension included.
    expect(findSamples(root)).toEqual([
      { id: 'voice-a-note-244d0c52', kind: 'voice', path: join(root, 'voice-notes', 'A note.opus') },
      { id: 'voice-a-note-fb3e13f6', kind: 'voice', path: join(root, 'voice-notes', 'a-note.ogg') },
      { id: 'voice-b-0016b74b', kind: 'voice', path: join(root, 'voice-notes', 'b.ogg') },
      { id: 'voice-file-754693cf', kind: 'voice', path: join(root, 'voice-notes', 'मीटिंग.OGG') },
      { id: 'meeting-client-call-1-6b5b3279', kind: 'meeting', path: join(root, 'meetings', 'Client Call 1.mp4') },
    ]);
  });

  it('keeps every id when other files are added, removed or renamed', () => {
    const root = mkdtempSync(join(tmpdir(), 'stt-stable-'));
    mkdirSync(join(root, 'voice-notes'));
    writeFileSync(join(root, 'voice-notes', 'b.ogg'), 'x');
    writeFileSync(join(root, 'voice-notes', 'c.ogg'), 'x');
    const before = findSamples(root);
    // "b!.ogg" has the same slug as "b.ogg" and sorts before it; "a.ogg" sorts first.
    writeFileSync(join(root, 'voice-notes', 'b!.ogg'), 'x');
    writeFileSync(join(root, 'voice-notes', 'a.ogg'), 'x');
    const after = findSamples(root);
    for (const s of before) expect(after.find((a) => a.path === s.path)?.id).toBe(s.id);
    expect(new Set(after.map((s) => s.id)).size).toBe(after.length);
  });

  it('refuses two files whose names give the same id', () => {
    const root = mkdtempSync(join(tmpdir(), 'stt-clash-'));
    const dir = join(root, 'voice-notes');
    mkdirSync(dir);
    // The same name in composed and decomposed Unicode: two files on NTFS, one id.
    writeFileSync(join(dir, 'café.ogg'.normalize('NFC')), 'x');
    writeFileSync(join(dir, 'café.ogg'.normalize('NFD')), 'x');
    if (readdirSync(dir).length < 2) return; // a file system that normalises names keeps only one file
    expect(() => findSamples(root)).toThrow(/same id/);
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
