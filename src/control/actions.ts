import Anthropic from '@anthropic-ai/sdk';
import type { BeatNowResult } from '../health/heartbeat.ts';
import type { Clock } from '../util/clock.ts';
import { fail, ok, type ApiError, type ApiResult, type AuditFn, type OwnerContext } from '../web/routes/context.ts';

// The dashboard's quick actions (D3 task 7): upload the tracker now, test the Claude connection, send a test heartbeat.
// Plain functions, mounted later as POST /dashboard/api/actions/<name> behind D1's owner guard and CSRF check. Results
// carry only short codes: never a key, the heartbeat link, or an error's text.

export const UPLOAD_TIMEOUT_MS = 60_000;
export const CLAUDE_TIMEOUT_MS = 15_000;
/** Tries allowed per action within one rolling window. */
export const ACTION_LIMIT = 5;
export const ACTION_WINDOW_MS = 60_000;

export const ACTION_NAMES = ['upload-tracker', 'test-claude', 'test-heartbeat'] as const;
export type ActionName = (typeof ACTION_NAMES)[number];

export const isActionName = (name: string): name is ActionName => (ACTION_NAMES as readonly string[]).includes(name);

export type UploadResult = { ok: true; at: string } | { ok: false; reason: 'failed' | 'timeout' };
export type ClaudeTestResult = { ok: true; ms: number } | { ok: false; reason: 'auth' | 'timeout' | 'unreachable' };
export type TestBeatResult = BeatNowResult;

export interface UploadDeps {
  /** DrivePublisher: resolves true when the run published. */
  publisher: { publishNow(): Promise<boolean> };
  clock: Clock;
  uploadTimeoutMs?: number;
}

export interface ClaudeDeps {
  /**
   * One cheap call that proves the key works (no tokens spent). main binds it with claudeModelsCheck(client), which
   * passes the signal so a timed-out test really stops its request instead of running on with the client's retries.
   */
  listModels: (signal: AbortSignal) => Promise<unknown>;
  clock: Clock;
  claudeTimeoutMs?: number;
}

export interface BeatDeps {
  /** Undefined when HEARTBEAT_URL is not set. */
  heartbeat?: { beatNow(): Promise<BeatNowResult> } | undefined;
}

export interface ActionDeps extends UploadDeps, ClaudeDeps, BeatDeps {
  limiter: ActionRateLimiter;
  audit: AuditFn;
}

const TIMED_OUT = Symbol('timed out');

/**
 * Settles with the work's outcome or TIMED_OUT, whichever comes first, and clears its timer either way. A rejection
 * that arrives after the timeout is swallowed here (the race already handled it), so it never goes unhandled.
 */
async function within<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<{ value: T } | { error: unknown } | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = new AbortController();
  const settled = (async () => {
    try {
      return { value: await work(abort.signal) };
    } catch (error) {
      return { error };
    }
  })();
  const deadline = new Promise<typeof TIMED_OUT>((r) => (timer = setTimeout(() => {
    abort.abort(); // work that takes the signal stops here
    r(TIMED_OUT);
  }, ms)));
  try {
    return await Promise.race([settled, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Uploads the tracker now (a run in flight counts: its result is returned and one follow-up is queued). */
export async function uploadTrackerNow(deps: UploadDeps): Promise<UploadResult> {
  const r = await within(() => deps.publisher.publishNow(), deps.uploadTimeoutMs ?? UPLOAD_TIMEOUT_MS);
  if (r === TIMED_OUT) return { ok: false, reason: 'timeout' };
  if ('error' in r || !r.value) return { ok: false, reason: 'failed' };
  return { ok: true, at: deps.clock.now().toISOString() };
}

/** One models.list call: proves the key works and Anthropic is reachable, without spending tokens. */
export async function testClaude(deps: ClaudeDeps): Promise<ClaudeTestResult> {
  const started = deps.clock.now().getTime();
  const r = await within((signal) => deps.listModels(signal), deps.claudeTimeoutMs ?? CLAUDE_TIMEOUT_MS);
  if (r === TIMED_OUT) return { ok: false, reason: 'timeout' };
  if ('error' in r) {
    const e = r.error as { status?: unknown; name?: unknown } | null | undefined;
    if (e?.status === 401 || e?.status === 403) return { ok: false, reason: 'auth' };
    if (r.error instanceof Anthropic.APIConnectionTimeoutError || e?.name === 'APIConnectionTimeoutError') return { ok: false, reason: 'timeout' };
    return { ok: false, reason: 'unreachable' };
  }
  return { ok: true, ms: Math.max(0, deps.clock.now().getTime() - started) };
}

/** What claudeModelsCheck needs of the Anthropic client. */
export interface ModelsClient {
  models: { list(params: { limit: number }, options: { timeout: number; maxRetries: number; signal: AbortSignal }): PromiseLike<unknown> };
}

/** listModels for main: one try (no SDK retries), the action's own timeout, and the signal that cancels it. */
export function claudeModelsCheck(client: ModelsClient): (signal: AbortSignal) => Promise<unknown> {
  return async (signal) => client.models.list({ limit: 1 }, { timeout: CLAUDE_TIMEOUT_MS, maxRetries: 0, signal });
}

/** One heartbeat visit now. beatNow has its own 10 s limit and never throws; a throw is still mapped, without its text. */
export async function sendTestBeat(deps: BeatDeps): Promise<TestBeatResult> {
  if (!deps.heartbeat) return { ok: false, reason: 'not_configured' };
  try {
    const r = await deps.heartbeat.beatNow();
    // Copy only the known fields, so nothing else the heartbeat might add reaches the page.
    return {
      ok: r.ok === true,
      ...(typeof r.status === 'number' ? { status: r.status } : {}),
      ...(typeof r.reason === 'string' ? { reason: r.reason } : {}),
    };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}

/** In memory: at most `limit` tries per action in any rolling `windowMs`. A refused try does not use a slot. */
export class ActionRateLimiter {
  readonly #clock: Clock;
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #tries = new Map<ActionName, number[]>();

  constructor(clock: Clock, limit = ACTION_LIMIT, windowMs = ACTION_WINDOW_MS) {
    this.#clock = clock;
    this.#limit = limit;
    this.#windowMs = windowMs;
  }

  /** Records a try and returns true, or returns false when the action is at its limit. */
  take(name: ActionName): boolean {
    const now = this.#clock.now().getTime();
    const recent = this.#recent(name, now);
    if (recent.length >= this.#limit) return false;
    recent.push(now);
    return true;
  }

  /** Milliseconds until the action has a free slot; 0 when it has one now. */
  retryAfterMs(name: ActionName): number {
    const now = this.#clock.now().getTime();
    const recent = this.#recent(name, now);
    if (recent.length < this.#limit) return 0;
    return recent[recent.length - this.#limit]! + this.#windowMs - now;
  }

  #recent(name: ActionName, now: number): number[] {
    // A try "in the future" means the wall clock went back: dropped, so the action is not blocked for the jump.
    const kept = (this.#tries.get(name) ?? []).filter((t) => t > now - this.#windowMs && t <= now);
    this.#tries.set(name, kept);
    return kept;
  }
}

const AUDIT_EVENT: Record<ActionName, string> = {
  // Neutral wording: the detail says whether it worked (ok) or why not.
  'upload-tracker': 'Tracker upload tried',
  'test-claude': 'Claude connection tested',
  'test-heartbeat': 'Test heartbeat tried',
};

export type ActionResult = UploadResult | ClaudeTestResult | TestBeatResult;

/**
 * POST /dashboard/api/actions/<name>. Answers 200 with the action's result even when it failed (the page shows the
 * reason), 429 rate_limited over the limit, 404 for an unknown name. Each attempt that runs is audited (kind ops, detail
 * `ok` or the reason code); refused tries are not, so a stuck page can't flood the audit log.
 */
export async function actionHandler(name: string, deps: ActionDeps, ctx: OwnerContext): Promise<ApiResult<ActionResult | ApiError>> {
  if (!isActionName(name)) return fail(404, 'not_found', 'There is no such action.');
  if (!deps.limiter.take(name)) {
    const retryAfterSec = Math.max(1, Math.ceil(deps.limiter.retryAfterMs(name) / 1000));
    return fail(429, 'rate_limited', 'Too many tries. Wait a minute and try again.', { retryAfterSec });
  }
  const result: ActionResult =
    name === 'upload-tracker' ? await uploadTrackerNow(deps) : name === 'test-claude' ? await testClaude(deps) : await sendTestBeat(deps);
  await deps.audit({
    actor: ctx.actor,
    requestId: ctx.requestId,
    kind: 'ops',
    event: AUDIT_EVENT[name],
    detail: result.ok ? 'ok' : (result.reason ?? 'failed'),
  });
  return ok(result);
}
