import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/*
 * scripts/stt-local-check.ts run as the owner runs it, as a child node process, with a fake engine: a tiny node script
 * that writes what its "model" file says. The settings come only from the child's env (the preload makes sure no .env
 * file is read), and the system's temporary folder is one of this test's own, so what the check leaves there is seen.
 * On Windows the preload runs the fake engine through node, since a script cannot be run as a program there without a
 * shell; elsewhere it is an executable script with a #! line.
 */

const SCRIPT = fileURLToPath(new URL('../../scripts/stt-local-check.ts', import.meta.url));
const PRELOAD = pathToFileURL(fileURLToPath(new URL('../fixtures/localCheckPreload.ts', import.meta.url))).href;

const FAKE_ENGINE = `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2);
appendFileSync(join(dirname(fileURLToPath(import.meta.url)), 'runs.log'), JSON.stringify(args) + '\\n');
const plan = JSON.parse(readFileSync(args[args.indexOf('-m') + 1], 'utf8'));
if (plan.stderr) process.stderr.write(plan.stderr);
if (plan.code) process.exit(plan.code);
writeFileSync(args[args.indexOf('-o') + 1], plan.text);
`;

/** A PCM WAV of the given format, holding `seconds` of silence. */
function wavFile(o: { sampleRate?: number; channels?: number; seconds?: number } = {}): Buffer {
  const sampleRate = o.sampleRate ?? 16000;
  const channels = o.channels ?? 1;
  const bytes = Math.round(sampleRate * channels * 2 * (o.seconds ?? 1));
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(36 + bytes, 4);
  head.write('WAVEfmt ', 8, 'latin1');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(channels, 22);
  head.writeUInt32LE(sampleRate, 24);
  head.writeUInt32LE(sampleRate * channels * 2, 28);
  head.writeUInt16LE(channels * 2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'latin1');
  head.writeUInt32LE(bytes, 40);
  return Buffer.concat([head, Buffer.alloc(bytes)]);
}

let root: string;
let engineDir: string;
let systemTmp: string;
let bin: string;
let model: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'zz-check-root-zz-'));
  engineDir = join(root, 'zz-engine-dir-zz');
  systemTmp = join(root, 'zz-system-tmp-zz');
  mkdirSync(engineDir);
  mkdirSync(systemTmp);
  bin = join(engineDir, 'zz-fake-engine-zz.mjs');
  writeFileSync(bin, process.platform === 'win32' ? FAKE_ENGINE : `#!${process.execPath}\n${FAKE_ENGINE}`);
  if (process.platform !== 'win32') chmodSync(bin, 0o755);
  model = join(engineDir, 'zz-model-zz.gguf');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** What the fake engine does: write `text` to its -o file, or print `stderr` and exit with `code`. */
const plan = (p: { text?: string; code?: number; stderr?: string }) => writeFileSync(model, JSON.stringify(p));

function writeWav(name: string, o?: Parameters<typeof wavFile>[0]): string {
  const path = join(root, name);
  writeFileSync(path, wavFile(o));
  return path;
}

function runCheck(wav: string, over: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '',
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    TEMP: systemTmp,
    TMP: systemTmp,
    TMPDIR: systemTmp,
    VOICE_STT_PROVIDER: 'local',
    STT_LOCAL_ENGINE: 'voxtral',
    STT_LOCAL_BIN: bin,
    STT_LOCAL_MODEL: model,
    ...over,
  };
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', PRELOAD, SCRIPT, wav], { env, cwd: root, windowsHide: true, timeout: 30_000, encoding: 'utf8' }, (e, out, err) => {
      resolve({ code: e === null ? 0 : typeof e.code === 'number' ? e.code : -1, out, err });
    });
  });
}

/** The test's own names, none of which may appear in what the check prints. */
const PRIVATE = ['zz-check-root-zz', 'zz-engine-dir-zz', 'zz-system-tmp-zz', 'zz-model-zz', 'zz-note-zz', 'zz-fake-engine-zz', 'wa-stt-check'];
function expectNoPrivate(text: string): void {
  for (const p of PRIVATE) expect(text).not.toContain(p);
  expect(text).not.toContain(root);
}

const engineRuns = (): string[][] => {
  const log = join(engineDir, 'runs.log');
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);
};

describe('scripts/stt-local-check.ts', () => {
  it('runs the engine once and prints the transcript, no path, and leaves no temporary folder', async () => {
    plan({ text: 'Site visit  kal\nsubah 10 baje\n' });
    const wav = writeWav('zz-note-zz.wav', { seconds: 2 });
    const r = await runCheck(wav);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain('Engine: voxtral\n');
    expect(r.out).toContain('Audio length: 2.0 s\n');
    expect(r.out).toContain('\nTranscript:\nSite visit kal subah 10 baje\n');
    expectNoPrivate(r.out);
    // The engine wrote into the check's own temporary folder, which is gone now.
    const runs = engineRuns();
    expect(runs).toHaveLength(1);
    const out = runs[0]![runs[0]!.indexOf('-o') + 1]!;
    expect(out.startsWith(join(systemTmp, 'wa-stt-check-'))).toBe(true);
    expect(runs[0]!.at(-1)).toBe(wav);
    expect(readdirSync(systemTmp)).toEqual([]);
  });

  it('an engine failure prints only its code and a hint, never its stderr or a path, and removes the temporary folder', async () => {
    plan({ code: 3, stderr: `zz-stderr-said-zz ${root}\n` });
    const r = await runCheck(writeWav('zz-note-zz.wav'));
    expect(r.code).toBe(1);
    expect(r.out).toContain('Failed (exit_3). ');
    expect(r.out + r.err).not.toContain('zz-stderr-said-zz');
    expectNoPrivate(r.out + r.err);
    expect(engineRuns()).toHaveLength(1);
    expect(readdirSync(systemTmp)).toEqual([]);
  });

  it('refuses a WAV that is not 16 kHz mono, without running the engine', async () => {
    plan({ text: 'never' });
    for (const o of [{ sampleRate: 44100 }, { sampleRate: 48000 }, { channels: 2 }]) {
      const r = await runCheck(writeWav('zz-note-zz.wav', o));
      expect(r.code).toBe(1);
      expect(r.out).toContain('This WAV is not 16 kHz mono 16-bit.');
      expectNoPrivate(r.out + r.err);
    }
    expect(engineRuns()).toEqual([]);
    expect(readdirSync(systemTmp)).toEqual([]);
  });

  it('a fatal error prints only the error name and code', async () => {
    plan({ text: 'never' });
    // The system's temporary folder does not exist, so making the check's own folder in it fails (ENOENT).
    const missing = join(root, 'zz-missing-tmp-zz');
    const r = await runCheck(writeWav('zz-note-zz.wav'), { TEMP: missing, TMP: missing, TMPDIR: missing });
    expect(r.code).toBe(1);
    expect(r.err).toBe('Stopped: Error (ENOENT)\n');
    expect(r.out).not.toContain('zz-missing-tmp-zz');
    expectNoPrivate(r.out + r.err);
    expect(engineRuns()).toEqual([]);
  });
});
