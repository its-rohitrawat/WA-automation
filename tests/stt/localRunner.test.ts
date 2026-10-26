import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A fake execFile: the seam of the local engine's own runner (runLocalEngine). A real child is run in local.test.ts.
type Callback = (err: { code?: unknown; signal?: string | null } | null, stdout: string, stderr: string) => void;
type FakeChild = EventEmitter & { pid?: number; exitCode: number | null; signalCode: string | null; kills: string[]; kill(signal: string): boolean };
interface FakeProgram {
  /** What the program does with each kill: 'exit' ends it, 'ignore' leaves it running. */
  onKill: (signal: string) => 'exit' | 'ignore';
  /** A program that cannot start: no pid, and an ENOENT callback. */
  missing?: boolean;
}
const fake = vi.hoisted(() => ({
  calls: [] as { file: string; args: string[]; options: Record<string, unknown>; callback: Callback; child: FakeChild }[],
  program: { onKill: () => 'exit' } as FakeProgram,
}));

vi.mock('node:child_process', () => ({
  execFile: (file: string, args: string[], options: Record<string, unknown>, callback: Callback) => {
    const program = fake.program;
    const child = Object.assign(new EventEmitter(), {
      pid: program.missing ? undefined : 4242,
      exitCode: null as number | null,
      signalCode: null as string | null,
      kills: [] as string[],
      kill(signal: string): boolean {
        child.kills.push(signal);
        if (program.onKill(signal) === 'exit' && child.exitCode === null && child.signalCode === null) {
          setTimeout(() => {
            child.signalCode = signal;
            child.emit('exit', null, signal);
            callback({ code: null, signal }, '', 'zz-said-zz');
          }, 5);
        }
        return true;
      },
    }) as FakeChild;
    fake.calls.push({ file, args, options, callback, child });
    if (program.missing) setTimeout(() => callback({ code: 'ENOENT' }, '', ''), 1);
    return child;
  },
}));

const { minimalEnv } = await import('../../src/stt/audio.ts');
const { KILL_GRACE_MS, LocalEngine, LocalEngineError, runLocalEngine } = await import('../../src/stt/local.ts');

const BIN = '/opt/stt/transcribe.cpp/build/bin/transcribe-cli';
const MODEL = '/opt/stt/models/Voxtral-Mini-3B-2507-Q4_K_M.gguf';

let root: string;
let workDir: string;
beforeEach(() => {
  fake.calls.length = 0;
  fake.program = { onKill: () => 'exit' };
  root = mkdtempSync(join(tmpdir(), 'local-runner-'));
  workDir = join(root, 'note-1');
  mkdirSync(workDir);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function engineError(p: Promise<unknown>): Promise<InstanceType<typeof LocalEngineError>> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(LocalEngineError);
    return e as InstanceType<typeof LocalEngineError>;
  }
  throw new Error('expected a LocalEngineError');
}

const engine = (over: { timeoutMs?: number; killGraceMs?: number } = {}) =>
  new LocalEngine({ engine: 'voxtral', bin: BIN, model: MODEL, threads: 8, timeoutMs: 60_000, language: 'hi', tmpDir: root, ...over });
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

describe("LocalEngine's own runner (runLocalEngine)", () => {
  it('is the default, and runs the program with no shell, windowsHide and minimalEnv, keeping the stop to itself', async () => {
    const ac = new AbortController();
    const p = engine().transcribe(join(workDir, 'note.wav'), { workDir, signal: ac.signal });
    await tick();
    expect(fake.calls).toHaveLength(1);
    const { file, options } = fake.calls[0]!;
    expect(file).toBe(BIN);
    expect(options.windowsHide).toBe(true);
    expect(options.shell).toBeUndefined();
    expect(options.env).toEqual(minimalEnv());
    // The runner sends the kills itself, so Node's own signal and timeout options are not used.
    expect(options.signal).toBeUndefined();
    expect(options.timeout).toBeUndefined();
    ac.abort();
    expect((await engineError(p)).code).toBe('aborted');
  });

  it('a program that ignores the first kill at the timeout gets SIGKILL after the grace time, and the call is timeout', async () => {
    fake.program = { onKill: (s) => (s === 'SIGKILL' ? 'exit' : 'ignore') };
    let settled = false;
    const p = engineError(engine({ timeoutMs: 30, killGraceMs: 80 }).transcribe(join(workDir, 'note.wav'), { workDir })).finally(() => {
      settled = true;
    });
    await tick(60);
    const { child } = fake.calls[0]!;
    expect(child.kills).toEqual(['SIGTERM']);
    expect(settled).toBe(false);
    const e = await p;
    expect(e.code).toBe('timeout');
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL']);
    expect(e.message).not.toContain('zz-said-zz');
  });

  it('a program that ignores the first kill at an abort gets SIGKILL too, and the call is aborted only once it has exited', async () => {
    fake.program = { onKill: (s) => (s === 'SIGKILL' ? 'exit' : 'ignore') };
    const ac = new AbortController();
    const p = engine({ killGraceMs: 50 }).transcribe(join(workDir, 'note.wav'), { workDir, signal: ac.signal });
    await tick();
    ac.abort();
    const e = await engineError(p);
    expect(e.code).toBe('aborted');
    const { child } = fake.calls[0]!;
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL']);
    expect(child.signalCode).toBe('SIGKILL');
  });

  it('a program that exits on SIGTERM is never sent SIGKILL', async () => {
    const ac = new AbortController();
    const p = engine({ killGraceMs: 30 }).transcribe(join(workDir, 'note.wav'), { workDir, signal: ac.signal });
    await tick();
    ac.abort();
    expect((await engineError(p)).code).toBe('aborted');
    await tick(60);
    expect(fake.calls[0]!.child.kills).toEqual(['SIGTERM']);
  });

  it('a program that exits by itself is never killed, and its code is kept', async () => {
    const p = runLocalEngine(BIN, [], { timeoutMs: 1000, killGraceMs: 30 });
    const { child, callback } = fake.calls[0]!;
    child.exitCode = 3;
    child.emit('exit', 3, null);
    callback({ code: 3 }, '', 'err');
    expect(await p).toEqual({ code: 3, stderr: 'err' });
    await tick(50);
    expect(child.kills).toEqual([]);
  });

  it('a callback while the program still runs (too much output) stops it the same way, and waits for its exit', async () => {
    fake.program = { onKill: (s) => (s === 'SIGKILL' ? 'exit' : 'ignore') };
    let settled = false;
    const p = runLocalEngine(BIN, [], { timeoutMs: 10_000, killGraceMs: 40 }).then((r) => {
      settled = true;
      return r;
    });
    const { child, callback } = fake.calls[0]!;
    callback({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, '', '');
    await tick(20);
    expect(child.kills).toEqual(['SIGTERM']);
    expect(settled).toBe(false);
    expect((await p).code).toBe(-1);
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('its own timeout is a backstop for a caller without a signal', async () => {
    fake.program = { onKill: (s) => (s === 'SIGKILL' ? 'exit' : 'ignore') };
    expect(await runLocalEngine(BIN, [], { timeoutMs: 20, killGraceMs: 20 })).toEqual({ code: -1, stderr: 'zz-said-zz' });
    expect(fake.calls[0]!.child.kills).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('a program that cannot start is exit_-1, with nothing to kill', async () => {
    fake.program = { onKill: () => 'exit', missing: true };
    expect((await engineError(engine().transcribe(join(workDir, 'note.wav'), { workDir }))).code).toBe('exit_-1');
    expect(fake.calls[0]!.child.kills).toEqual([]);
  });

  it('an already-aborted signal never starts the program', async () => {
    const ac = new AbortController();
    ac.abort();
    expect(await runLocalEngine(BIN, [], { timeoutMs: 1000, killGraceMs: 30, signal: ac.signal })).toEqual({ code: -1, stderr: '' });
    expect(fake.calls).toHaveLength(0);
  });

  it('gives a stopped program 5 seconds by default', () => {
    expect(KILL_GRACE_MS).toBe(5_000);
  });
});
