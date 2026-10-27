import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIRST_BEAT_MS, Heartbeat, HEARTBEAT_INTERVAL_MS } from '../../src/health/heartbeat.ts';
import { createLogger } from '../../src/util/logger.ts';

const URL_ = 'https://heartbeat.uptimerobot.com/secret-token-123';

function setup(o: { up?: () => boolean; fetchImpl?: (...a: unknown[]) => Promise<Response> } = {}) {
  const lines: string[] = [];
  const log = createLogger(
    'debug',
    new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    }),
  );
  const fetchMock = vi.fn(o.fetchImpl ?? (async () => new Response('ok', { status: 200 })));
  const hb = new Heartbeat({ url: URL_, isUp: o.up ?? (() => true), log, fetch: fetchMock as unknown as typeof fetch });
  return { hb, fetchMock, lines };
}

describe('Heartbeat', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('visits the link a minute after start, then every 5 minutes, with a plain GET and no body', async () => {
    const { hb, fetchMock } = setup();
    hb.start();
    await vi.advanceTimersByTimeAsync(FIRST_BEAT_MS - 1);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(URL_);
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await hb.stop();
  });

  it('skips the visit while the agent is not up, and resumes when it is', async () => {
    let up = false;
    const { hb, fetchMock, lines } = setup({ up: () => up });
    hb.start();
    await vi.advanceTimersByTimeAsync(FIRST_BEAT_MS + HEARTBEAT_INTERVAL_MS);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lines.filter((l) => l.includes('heartbeat paused')).length).toBe(1); // logged once, not every 5 minutes
    up = true;
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await hb.stop();
  });

  it('never throws and never logs the link when the visit fails', async () => {
    const failing = setup({ fetchImpl: async () => { throw new TypeError(`fetch failed for ${URL_}`); } });
    failing.hb.start();
    await vi.advanceTimersByTimeAsync(FIRST_BEAT_MS);
    expect(failing.fetchMock).toHaveBeenCalledTimes(1);
    await failing.hb.stop();

    const refused = setup({ fetchImpl: async () => new Response('no', { status: 404 }) });
    refused.hb.start();
    await vi.advanceTimersByTimeAsync(FIRST_BEAT_MS);
    await refused.hb.stop();

    const all = [...failing.lines, ...refused.lines].join('\n');
    expect(all).toContain('heartbeat');
    expect(all).toContain('404');
    expect(all).not.toContain('secret-token-123');
    expect(all).not.toContain('uptimerobot');
  });

  it('starts no new visit while one is still running, and stop() aborts it and leaves no timers', async () => {
    let signal: AbortSignal | undefined;
    const { hb, fetchMock } = setup({
      fetchImpl: (_u, init) => {
        signal = (init as RequestInit).signal ?? undefined;
        return new Promise(() => {}); // never answers
      },
    });
    hb.start();
    await vi.advanceTimersByTimeAsync(FIRST_BEAT_MS + 2 * HEARTBEAT_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await hb.stop();
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('main.ts heartbeat wiring', () => {
  it('starts the heartbeat only with HEARTBEAT_URL, gates it on Health.isUp, stops it on shutdown, and never logs the link', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(import.meta.dirname, '../../src/main.ts'), 'utf8');
    expect(src).toMatch(/env\.HEARTBEAT_URL \? new Heartbeat\(\{ url: env\.HEARTBEAT_URL, isUp: \(\) => app\.health\.isUp\(\), log \}\) : undefined/);
    expect(src).toContain('heartbeat?.start();');
    expect(src).toContain('void heartbeat?.stop();');
    expect(src).not.toMatch(/log\.\w+\([^)]*HEARTBEAT_URL/);
  });
});
