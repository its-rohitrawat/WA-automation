import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// A fake execFile: runFile's own seam. The real one is exercised in audio.test.ts.
type Callback = (err: { code?: unknown } | null, stdout: string, stderr: string) => void;
const fake = vi.hoisted(() => ({
  calls: [] as { file: string; args: string[]; options: Record<string, unknown>; callback: Callback; child: EventEmitter & { pid?: number } }[],
}));

vi.mock('node:child_process', () => ({
  execFile: (file: string, args: string[], options: Record<string, unknown>, callback: Callback) => {
    const child = Object.assign(new EventEmitter(), { pid: 4242 });
    fake.calls.push({ file, args, options, callback, child });
    return child;
  },
}));

const { minimalEnv, runFile } = await import('../../src/stt/audio.ts');

describe('runFile with a fake execFile', () => {
  beforeEach(() => {
    fake.calls.length = 0;
  });

  it('on an abort, resolves only once the child has closed', async () => {
    const ac = new AbortController();
    let settled = false;
    const p = runFile('ffmpeg.exe', ['-i', 'x'], { timeoutMs: 1000, signal: ac.signal }).then((r) => {
      settled = true;
      return r;
    });
    const call = fake.calls[0]!;
    expect(call.options.signal).toBe(ac.signal);
    ac.abort();
    call.callback({ code: 'ABORT_ERR' }, '', ''); // Node calls back as soon as the kill is sent
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    call.child.emit('close', null, 'SIGTERM');
    expect(await p).toEqual({ code: -1, stderr: '' });
  });

  it('without an abort, resolves from the callback', async () => {
    const p = runFile('ffmpeg.exe', [], { timeoutMs: 1000 });
    fake.calls[0]!.callback({ code: 2 }, '', 'oops');
    expect(await p).toEqual({ code: 2, stderr: 'oops' });
  });

  it('passes the minimal env by default, the given env, or the parent env only when asked', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'dummy-test-value';
    try {
      void runFile('a', [], { timeoutMs: 1 });
      void runFile('b', [], { timeoutMs: 1, env: { PATH: 'x' } });
      void runFile('c', [], { timeoutMs: 1, inheritEnv: true });
      expect(fake.calls[0]!.options.env).toEqual(minimalEnv());
      expect(fake.calls[0]!.options.env).not.toHaveProperty('ANTHROPIC_API_KEY');
      expect(fake.calls[1]!.options.env).toEqual({ PATH: 'x' });
      expect(fake.calls[2]!.options.env).toBe(process.env);
      for (const c of fake.calls) c.callback(null, '', '');
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});
