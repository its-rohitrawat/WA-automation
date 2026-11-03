import { Assistant, QUESTION_MAX, type AssistantEvent } from '../../assistant/assistant.ts';
import { runProposal, type PendingActions } from '../../assistant/proposals.ts';
import type { SettingsStore } from '../../config/settingsStore.ts';
import { ControlError } from '../../control/errors.ts';
import { chatMessages, cleanTitle, deleteChat, getChat, listChats, renameChat, setCardState } from '../../store/assistantChats.ts';
import type { Db } from '../../store/db.ts';
import type { Clock } from '../../util/clock.ts';
import type { AuditLog } from '../audit.ts';
import { jsonText, readJson, sendJson } from '../http.ts';
import { RateLimiter, type RateLimit } from '../guard.ts';
import type { RequestContext, Router } from '../router.ts';
import { hashToken } from '../sessions.ts';
import { actionSession, controlled, readBody, type ActionGuard } from './respond.ts';

// The dashboard assistant's API (owner request, 29 Oct 2026; stored chats, November release changes 1 and 8). Every
// route needs the signed-in owner; asking and every change (rename, delete, stop, confirm, cancel) also need the Origin
// and CSRF checks. Questions have their own limit (ASK_LIMIT, per client address) on top of the paid-call spend cap; the
// other changes count against the shared action limit. Chats belong to the workspace (row-level security on Postgres):
// an id from another workspace is a 404. An answer streams back as one JSON object per line (AssistantEvent), the first
// naming the chat; it runs to its end on the agent even when the browser stops reading. A card's change runs only on
// Confirm, here, and the chat records what became of it.

/** Questions: 30 an hour per client. */
export const ASK_LIMIT: Readonly<RateLimit> = Object.freeze({ capacity: 30, refillPerSec: 30 / 3600 });

/** What the page offers before the first question. */
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
  audit: Pick<AuditLog, 'record'>;
  /** The question limit; ASK_LIMIT when not given. */
  asks?: Pick<RateLimiter, 'hit'>;
}

const GONE = 'That chat is not here any more.';

/** A chat id from the address: a positive whole number, else 404 (never a database error). */
function chatIdOf(ctx: RequestContext): number {
  const raw = ctx.params.id ?? '';
  if (!/^[1-9]\d{0,14}$/.test(raw)) throw new ControlError(404, GONE);
  return Number(raw);
}

export function registerAssistantApi(router: Router, d: AssistantApiDeps): void {
  const asks = d.asks ?? new RateLimiter({ ...ASK_LIMIT, clock: d.clock });
  const ownerOf = (s: { id: string; email: string }) => ({ key: hashToken(s.id), email: s.email });
  const at = () => d.clock.now().toISOString();
  /** The chat, or a 404. */
  const chatOf = async (id: number) => {
    const c = await getChat(d.db, id);
    if (!c) throw new ControlError(404, GONE);
    return c;
  };

  router.get('/dashboard/api/assistant', controlled(async (ctx) => {
    await d.guard.requireOwner(ctx.req);
    sendJson(ctx.res, 200, { suggestions: SUGGESTIONS, questionMax: QUESTION_MAX });
  }));

  // The workspace's chats, the most recently used first: titles only.
  router.get('/dashboard/api/assistant/chats', controlled(async (ctx) => {
    await d.guard.requireOwner(ctx.req);
    const chats = (await listChats(d.db)).map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, running: d.assistant.running(c.id) }));
    sendJson(ctx.res, 200, { chats });
  }));

  // One chat with its messages. An answer saved as running that nothing is running any more (the agent restarted) reads
  // as interrupted; a card is live while this session can still Confirm it.
  router.get('/dashboard/api/assistant/chats/:id', controlled(async (ctx) => {
    const s = await d.guard.requireOwner(ctx.req);
    const chat = await chatOf(chatIdOf(ctx));
    const running = d.assistant.running(chat.id);
    const messages = await chatMessages(d.db, chat.id);
    const live = d.pending.live(messages.flatMap((m) => m.cards.filter((c) => c.state === 'waiting').map((c) => c.id)), ownerOf(s).key);
    sendJson(ctx.res, 200, {
      chat: { id: chat.id, title: chat.title, updatedAt: chat.updatedAt },
      running,
      messages: messages.map((m) => ({
        id: m.id, role: m.role, body: m.body, status: m.status === 'running' && !running ? 'interrupted' : m.status, note: m.note, costUsd: m.costUsd,
        links: m.links, cards: m.cards.map((c) => ({ ...c, live: c.state === 'waiting' && live.has(c.id) })), createdAt: m.createdAt,
      })),
    });
  }));

  router.post('/dashboard/api/assistant/ask', controlled(async (ctx) => {
    const s = await d.guard.requireOwner(ctx.req);
    d.guard.requireCsrf(ctx.req, s);
    asks.hit(ctx.req, ctx.res);
    const body = await readJson(ctx.req, 3 * QUESTION_MAX + 1_024);
    const o = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const question = typeof o.question === 'string' ? o.question.trim() : '';
    if (question === '') throw new ControlError(422, 'Type a question', 'question');
    if (question.length > QUESTION_MAX) throw new ControlError(422, `A question can be at most ${QUESTION_MAX} characters`, 'question');
    let chatId: number | undefined;
    if (o.chatId !== undefined && o.chatId !== null) {
      if (typeof o.chatId !== 'number' || !Number.isSafeInteger(o.chatId) || o.chatId < 1) throw new ControlError(404, GONE, 'chatId');
      chatId = o.chatId;
    }
    const { res } = ctx;
    // The browser may stop reading (the owner left the page): the answer still runs to its end and is saved.
    let reading = true;
    res.on('close', () => {
      reading = false;
    });
    const emit = (e: AssistantEvent) => {
      if (reading && !res.destroyed && !res.writableEnded) res.write(`${jsonText(e)}\n`);
    };
    await d.assistant.ask(ownerOf(s), { chatId, question }, (chat) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();
      emit({ type: 'chat', id: chat.id, title: chat.title });
    }, emit);
    if (!res.writableEnded) res.end();
  }));

  router.post('/dashboard/api/assistant/chats/:id/rename', controlled(async (ctx) => {
    await actionSession(ctx, d);
    const id = chatIdOf(ctx);
    const body = await readBody(ctx);
    const title = cleanTitle(typeof body === 'object' && body !== null ? (body as Record<string, unknown>).title : undefined);
    if (title === undefined) throw new ControlError(422, 'A chat name is 1 to 80 characters', 'title');
    if (!(await renameChat(d.db, id, title, at()))) throw new ControlError(404, GONE);
    sendJson(ctx.res, 200, { ok: true, chat: { id, title } });
  }));

  // Deleting a chat deletes its messages; an answer still running there is stopped first.
  router.post('/dashboard/api/assistant/chats/:id/delete', controlled(async (ctx) => {
    await actionSession(ctx, d);
    const id = chatIdOf(ctx);
    d.assistant.stop(id);
    if (!(await deleteChat(d.db, id))) throw new ControlError(404, GONE);
    sendJson(ctx.res, 200, { ok: true });
  }));

  router.post('/dashboard/api/assistant/chats/:id/stop', controlled(async (ctx) => {
    await actionSession(ctx, d);
    const chat = await chatOf(chatIdOf(ctx));
    sendJson(ctx.res, 200, { ok: true, stopped: d.assistant.stop(chat.id) });
  }));

  router.post('/dashboard/api/assistant/confirm', controlled(async (ctx) => {
    const s = await actionSession(ctx, d);
    const body = await readBody(ctx);
    const id = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).id : undefined;
    const p = d.pending.take(id, ownerOf(s).key);
    const done = await runProposal(p.action, {
      db: d.db, clock: d.clock, settings: d.settings, actor: s.email,
      audit: (q, e) => d.audit.record({ ...e, actor: s.email, requestId: ctx.requestId }, q),
    });
    if (p.messageId !== undefined) await setCardState(d.db, p.messageId, p.card.id, 'confirmed', typeof done.message === 'string' ? done.message : undefined, at());
    sendJson(ctx.res, 200, { ok: true, ...done });
  }));

  router.post('/dashboard/api/assistant/cancel', controlled(async (ctx) => {
    const s = await actionSession(ctx, d);
    const body = await readBody(ctx);
    const p = d.pending.drop(typeof body === 'object' && body !== null ? (body as Record<string, unknown>).id : undefined, ownerOf(s).key);
    if (p?.messageId !== undefined) await setCardState(d.db, p.messageId, p.card.id, 'cancelled', undefined, at());
    sendJson(ctx.res, 200, { ok: true });
  }));
}
