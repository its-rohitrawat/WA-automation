import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACTION_LIMIT,
  ACTION_WINDOW_MS,
  ActionRateLimiter,
  CLAUDE_TIMEOUT_MS,
  UPLOAD_TIMEOUT_MS,
  actionHandler,
  claudeModelsCheck,
  sendTestBeat,
  testClaude,
  uploadTrackerNow,
  type ActionDeps,
} from '../../src/control/actions.ts';
import type { AuditFn, OwnerContext } from '../../src/web/routes/context.ts';
import { manualClock } from '../../src/util/clock.ts';

const KEY = 'sk-ant-api03-SECRETKEYVALUE';
const BEAT_URL = 'https://heartbeat.uptimerobot.com/secret-beat-token';
const ctx: OwnerContext = { actor: 'owner@example.com', sessionId: 'sess-1', requestId: 'abcdef012345' };

afterEach(() => vi.useRealTimers());

const never = <T>() => new Promise<T>(() => {});
const apiError = (status: number) => Object.assign(new Error(`${status} invalid x-api-key ${KEY}`), { status });

function deps(over: Partial<ActionDeps> = {}) {
  const clock = manualClock('2026-10-27T09:00:00.000Z');
  const audits: Parameters<AuditFn>[0][] = [];
  const d: ActionDeps = {
    clock,
    publisher: { publishNow: vi.fn(async () => true) },
    listModels: vi.fn(async () => ({ data: [{ id: 'claude-x' }] })),
    heartbeat: { beatNow: vi.fn(async () => ({ ok: true, status: 200 })) },
    limiter: new ActionRateLimiter(clock),
    audit: async (e) => { audits.push(e); },
    ...over,
  };
  return { d, clock, audits };
}

describe('uploadTrackerNow', () => {
  it('returns ok with the time the upload finished', async () => {
    const { d, clock } = deps({
      publisher: {
        publishNow: async () => {
          clock.advance(2_000);
          return true;
        },
      },
    });
    await expect(uploadTrackerNow(d)).resolves.toEqual({ ok: true, at: '2026-10-27T09:00:02.000Z' });
  });

  it('returns failed when the run did not publish, or threw', async () => {
    expect(await uploadTrackerNow(deps({ publisher: { publishNow: async () => false } }).d)).toEqual({ ok: false, reason: 'failed' });
    const threw = deps({ publisher: { publishNow: async () => { throw new Error('Drive token ya29.SECRET'); } } }).d;
    expect(await uploadTrackerNow(threw)).toEqual({ ok: false, reason: 'failed' });
  });

  it('times out after 60 s by default and leaves no timer', async () => {
    vi.useFakeTimers();
    const { d } = deps({ publisher: { publishNow: never } });
    const p = uploadTrackerNow(d);
    await vi.advanceTimersByTimeAsync(UPLOAD_TIMEOUT_MS - 1);
    let settled = false;
    void p.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toEqual({ ok: false, reason: 'timeout' });
    expect(UPLOAD_TIMEOUT_MS).toBe(60_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears its timer when the upload finishes first', async () => {
    vi.useFakeTimers();
    const { d } = deps();
    await uploadTrackerNow(d);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('testClaude', () => {
  it('makes one listModels call and returns ok with the time it took', async () => {
    const { d, clock } = deps();
    d.listModels = vi.fn(async () => {
      clock.advance(240);
      return {};
    });
    await expect(testClaude(d)).resolves.toEqual({ ok: true, ms: 240 });
    expect(d.listModels).toHaveBeenCalledTimes(1);
  });

  it('maps a 401 or 403 to auth, never the key or the raw error', async () => {
    for (const status of [401, 403]) {
      const { d } = deps({ listModels: async () => { throw apiError(status); } });
      const r = await testClaude(d);
      expect(r).toEqual({ ok: false, reason: 'auth' });
      expect(JSON.stringify(r)).not.toContain('SECRET');
    }
  });

  it('maps other failures to unreachable', async () => {
    for (const err of [apiError(500), apiError(429), new TypeError('fetch failed'), 'weird']) {
      const { d } = deps({ listModels: async () => { throw err; } });
      expect(await testClaude(d)).toEqual({ ok: false, reason: 'unreachable' });
    }
  });

  it("maps the SDK's own connection timeout to timeout", async () => {
    const e = Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' });
    const { d } = deps({ listModels: async () => { throw e; } });
    expect(await testClaude(d)).toEqual({ ok: false, reason: 'timeout' });
  });

  it('times out after 15 s by default and leaves no timer', async () => {
    vi.useFakeTimers();
    const { d } = deps({ listModels: never });
    const p = testClaude(d);
    await vi.advanceTimersByTimeAsync(CLAUDE_TIMEOUT_MS);
    await expect(p).resolves.toEqual({ ok: false, reason: 'timeout' });
    expect(CLAUDE_TIMEOUT_MS).toBe(15_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts a shorter injected timeout, and a late rejection is swallowed', async () => {
    let reject!: (e: unknown) => void;
    const { d } = deps({ listModels: () => new Promise((_r, rej) => (reject = rej)), claudeTimeoutMs: 5 });
    await expect(testClaude(d)).resolves.toEqual({ ok: false, reason: 'timeout' });
    reject(apiError(401)); // after the timeout: must not become an unhandled rejection
    await new Promise((r) => setTimeout(r, 5));
  });

  it('a timeout aborts the request through its signal, so it does not run on', async () => {
    let seen: AbortSignal | undefined;
    const { d } = deps({ listModels: (signal) => { seen = signal; return never(); }, claudeTimeoutMs: 5 });
    await testClaude(d);
    expect(seen?.aborted).toBe(true);
  });

  it("maps the SDK's real APIConnectionTimeoutError (whose name is not set) to timeout", async () => {
    const e = new Anthropic.APIConnectionTimeoutError();
    const { d } = deps({ listModels: async () => { throw e; } });
    expect(await testClaude(d)).toEqual({ ok: false, reason: 'timeout' });
  });

  it('claudeModelsCheck asks for one model, with one try, the action timeout and the signal', async () => {
    const calls: unknown[] = [];
    const client = { models: { list: async (params: { limit: number }, options: unknown) => { calls.push([params, options]); return {}; } } };
    const signal = new AbortController().signal;
    await claudeModelsCheck(client)(signal);
    expect(calls).toEqual([[{ limit: 1 }, { timeout: CLAUDE_TIMEOUT_MS, maxRetries: 0, signal }]]);
  });
});

describe('ActionRateLimiter after a clock jump', () => {
  it('a wall clock that went back does not block the action for the jump', () => {
    const clock = manualClock('2026-10-27T09:00:00.000Z');
    const l = new ActionRateLimiter(clock);
    for (let i = 0; i < 5; i++) l.take('test-claude');
    clock.set('2026-10-27T08:00:00.000Z'); // an hour back
    expect(l.take('test-claude')).toBe(true);
  });
});

describe('sendTestBeat', () => {
  it('returns what beatNow returns', async () => {
    const { d } = deps({ heartbeat: { beatNow: async () => ({ ok: false, status: 404, reason: 'refused' }) } });
    await expect(sendTestBeat(d)).resolves.toEqual({ ok: false, status: 404, reason: 'refused' });
    await expect(sendTestBeat(deps().d)).resolves.toEqual({ ok: true, status: 200 });
  });

  it('returns not_configured when there is no heartbeat', async () => {
    await expect(sendTestBeat(deps({ heartbeat: undefined }).d)).resolves.toEqual({ ok: false, reason: 'not_configured' });
  });

  it('returns unreachable if beatNow throws, without its text', async () => {
    const { d } = deps({ heartbeat: { beatNow: async () => { throw new Error(BEAT_URL); } } });
    const r = await sendTestBeat(d);
    expect(r).toEqual({ ok: false, reason: 'unreachable' });
  });
});

describe('ActionRateLimiter', () => {
  it('allows 5 per rolling minute per action, then frees a slot as each one ages out', () => {
    const clock = manualClock('2026-10-27T09:00:00.000Z');
    const l = new ActionRateLimiter(clock);
    expect(ACTION_LIMIT).toBe(5);
    expect(ACTION_WINDOW_MS).toBe(60_000);
    for (let i = 0; i < 5; i++) {
      expect(l.take('test-claude')).toBe(true);
      clock.advance(1_000); // tries at 0, 1, 2, 3, 4 s
    }
    expect(l.take('test-claude')).toBe(false);
    expect(l.take('upload-tracker')).toBe(true); // a separate budget per action
    clock.set('2026-10-27T09:00:59.999Z');
    expect(l.take('test-claude')).toBe(false);
    clock.set('2026-10-27T09:01:00.000Z'); // the first try is a minute old
    expect(l.take('test-claude')).toBe(true);
    expect(l.take('test-claude')).toBe(false);
    clock.set('2026-10-27T09:02:10.000Z'); // all aged out
    for (let i = 0; i < 5; i++) expect(l.take('test-claude')).toBe(true);
    expect(l.take('test-claude')).toBe(false);
  });

  it('a refused try does not use up a slot', () => {
    const clock = manualClock('2026-10-27T09:00:00.000Z');
    const l = new ActionRateLimiter(clock);
    for (let i = 0; i < 5; i++) l.take('test-heartbeat');
    clock.advance(30_000);
    for (let i = 0; i < 10; i++) expect(l.take('test-heartbeat')).toBe(false);
    clock.advance(30_000);
    for (let i = 0; i < 5; i++) expect(l.take('test-heartbeat')).toBe(true);
  });

  it('reports how long until the next slot frees', () => {
    const clock = manualClock('2026-10-27T09:00:00.000Z');
    const l = new ActionRateLimiter(clock);
    for (let i = 0; i < 5; i++) l.take('test-claude');
    clock.advance(20_500);
    expect(l.retryAfterMs('test-claude')).toBe(39_500);
    expect(l.retryAfterMs('upload-tracker')).toBe(0);
  });
});

describe('actionHandler', () => {
  it('runs each action, answers 200 with its result, and audits it as ops with ok', async () => {
    const { d, audits } = deps();
    expect(await actionHandler('upload-tracker', d, ctx)).toEqual({ status: 200, body: { ok: true, at: '2026-10-27T09:00:00.000Z' } });
    expect(await actionHandler('test-claude', d, ctx)).toEqual({ status: 200, body: { ok: true, ms: 0 } });
    expect(await actionHandler('test-heartbeat', d, ctx)).toEqual({ status: 200, body: { ok: true, status: 200 } });
    expect(audits).toEqual([
      { actor: ctx.actor, requestId: ctx.requestId, kind: 'ops', event: 'Tracker upload tried', detail: 'ok' },
      { actor: ctx.actor, requestId: ctx.requestId, kind: 'ops', event: 'Claude connection tested', detail: 'ok' },
      { actor: ctx.actor, requestId: ctx.requestId, kind: 'ops', event: 'Test heartbeat tried', detail: 'ok' },
    ]);
  });

  it('answers 200 for a failed action, so the page can show the reason, and audits the reason code', async () => {
    const { d, audits } = deps({
      publisher: { publishNow: async () => false },
      listModels: async () => { throw apiError(401); },
      heartbeat: undefined,
    });
    expect(await actionHandler('upload-tracker', d, ctx)).toEqual({ status: 200, body: { ok: false, reason: 'failed' } });
    expect(await actionHandler('test-claude', d, ctx)).toEqual({ status: 200, body: { ok: false, reason: 'auth' } });
    expect(await actionHandler('test-heartbeat', d, ctx)).toEqual({ status: 200, body: { ok: false, reason: 'not_configured' } });
    expect(audits.map((a) => a.detail)).toEqual(['failed', 'auth', 'not_configured']);
  });

  it('answers 429 rate_limited on the sixth try within a minute, without running or auditing it, and allows again after a minute', async () => {
    const { d, clock, audits } = deps();
    for (let i = 0; i < 5; i++) expect((await actionHandler('test-claude', d, ctx)).status).toBe(200);
    const limited = await actionHandler('test-claude', d, ctx);
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ error: { code: 'rate_limited', retryAfterSec: 60 } });
    expect(d.listModels).toHaveBeenCalledTimes(5);
    expect(audits).toHaveLength(5);
    expect((await actionHandler('upload-tracker', d, ctx)).status).toBe(200); // other actions keep their own budget
    clock.advance(60_000);
    expect((await actionHandler('test-claude', d, ctx)).status).toBe(200);
    expect(d.listModels).toHaveBeenCalledTimes(6);
  });

  it('answers 404 for an unknown action name, without auditing', async () => {
    const { d, audits } = deps();
    const r = await actionHandler('delete-everything', d, ctx);
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ error: { code: 'not_found' } });
    expect(audits).toEqual([]);
    expect(await actionHandler('__proto__', d, ctx)).toMatchObject({ status: 404 });
  });

  it('puts no key, heartbeat link or raw error text in any result or audit line', async () => {
    const { d, audits } = deps({
      publisher: { publishNow: async () => { throw new Error(`token ${KEY}`); } },
      listModels: async () => { throw apiError(403); },
      heartbeat: { beatNow: async () => { throw new Error(BEAT_URL); } },
    });
    const results = [
      await actionHandler('upload-tracker', d, ctx),
      await actionHandler('test-claude', d, ctx),
      await actionHandler('test-heartbeat', d, ctx),
    ];
    const all = JSON.stringify(results) + JSON.stringify(audits);
    for (const secret of ['SECRET', 'sk-ant', 'uptimerobot', 'secret-beat-token', 'x-api-key', 'token']) {
      expect(all).not.toContain(secret);
    }
  });
});
