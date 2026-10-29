import { Assistant, QUESTION_MAX, type AssistantEvent } from '../../assistant/assistant.ts';
import { runProposal, type PendingActions } from '../../assistant/proposals.ts';
import type { SettingsStore } from '../../config/settingsStore.ts';
import { ControlError } from '../../control/errors.ts';
import type { Db } from '../../store/db.ts';
import type { Clock } from '../../util/clock.ts';
import type { AuditLog } from '../audit.ts';
import { readJson, sendJson } from '../http.ts';
import { RateLimiter, type RateLimit } from '../guard.ts';
import type { Router } from '../router.ts';
import { hashToken } from '../sessions.ts';
import { actionSession, controlled, readBody, type ActionGuard } from './respond.ts';

// The dashboard assistant's API (owner request, 29 Oct 2026). Every route needs the signed-in owner; asking, confirming,
// cancelling and a new chat also need the Origin and CSRF checks. Questions have their own limit (ASK_LIMIT, per
// client address) on top of the paid-call spend cap; Confirm, Cancel and New chat count against the shared action limit.
// An answer streams back as one JSON object per line (AssistantEvent). A card's change runs only on Confirm, here.

/** Questions: 30 an hour per client. */
export const ASK_LIMIT: Readonly<RateLimit> = Object.freeze({ capacity: 30, refillPerSec: 30 / 3600 });

/** What the panel offers before the first question. */
export const SUGGESTIONS = [
  'Summarise today',
  'What needs my attention?',
  'Show overdue tasks',
  'Which client has the most open tasks?',
  'Explain today\'s AI spend',
  'Summarise the latest meeting',
];

export interface AssistantApiDeps extends ActionGuard {
  db: Db;
  clock: Clock;
  assistant: Assistant;
  pending: PendingActions;
  settings: Pick<SettingsStore, 'set'>;
  audit: Pick<AuditLog, 'recordSync'>;
  /** The question limit; ASK_LIMIT when not given. */
  asks?: Pick<RateLimiter, 'hit'>;
}

export function registerAssistantApi(router: Router, d: AssistantApiDeps): void {
  const asks = d.asks ?? new RateLimiter({ ...ASK_LIMIT, clock: d.clock });
  const ownerOf = (s: { id: string; email: string }) => ({ key: hashToken(s.id), email: s.email });

  router.get('/dashboard/api/assistant', controlled(async (ctx) => {
    await d.guard.requireOwner(ctx.req);
    sendJson(ctx.res, 200, { suggestions: SUGGESTIONS, questionMax: QUESTION_MAX });
  }));

  router.post('/dashboard/api/assistant/ask', controlled(async (ctx) => {
    const s = await d.guard.requireOwner(ctx.req);
    d.guard.requireCsrf(ctx.req, s);
    asks.hit(ctx.req, ctx.res);
    const body = await readJson(ctx.req, 3 * QUESTION_MAX + 1_024);
    const raw = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).question : undefined;
    const question = typeof raw === 'string' ? raw.trim() : '';
    if (question === '') throw new ControlError(422, 'Type a question', 'question');
    if (question.length > QUESTION_MAX) throw new ControlError(422, `A question can be at most ${QUESTION_MAX} characters`, 'question');
    const owner = ownerOf(s);
    if (d.assistant.busy(owner.key)) throw new ControlError(409, 'The assistant is still answering your last question.');
    const { res } = ctx;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    // The browser went away (panel closed, page left): no further Claude call starts.
    const gone = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) gone.abort();
    });
    const emit = (e: AssistantEvent) => {
      if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(e)}\n`);
    };
    await d.assistant.ask(owner, question, emit, gone.signal);
    if (!res.writableEnded) res.end();
  }));

  router.post('/dashboard/api/assistant/confirm', controlled(async (ctx) => {
    const s = await actionSession(ctx, d);
    const body = await readBody(ctx);
    const id = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).id : undefined;
    const p = d.pending.take(id, ownerOf(s).key);
    const done = await runProposal(p.action, {
      db: d.db, clock: d.clock, settings: d.settings, actor: s.email,
      audit: (e) => d.audit.recordSync({ ...e, actor: s.email, requestId: ctx.requestId }),
    });
    sendJson(ctx.res, 200, { ok: true, ...done });
  }));

  router.post('/dashboard/api/assistant/cancel', controlled(async (ctx) => {
    const s = await actionSession(ctx, d);
    const body = await readBody(ctx);
    d.pending.drop(typeof body === 'object' && body !== null ? (body as Record<string, unknown>).id : undefined, ownerOf(s).key);
    sendJson(ctx.res, 200, { ok: true });
  }));

  router.post('/dashboard/api/assistant/reset', controlled(async (ctx) => {
    const s = await actionSession(ctx, d);
    d.assistant.reset(ownerOf(s));
    sendJson(ctx.res, 200, { ok: true });
  }));
}
