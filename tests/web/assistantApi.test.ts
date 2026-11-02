import { afterEach, describe, expect, it } from 'vitest';
import { Assistant, type AssistantAi, type AssistantBlock, type AssistantTurn } from '../../src/assistant/assistant.ts';
import { PendingActions } from '../../src/assistant/proposals.ts';
import { parseEnv } from '../../src/config/env.ts';
import { SettingsStore } from '../../src/config/settingsStore.ts';
import type { AgentStatus } from '../../src/control/agentControl.ts';
import { chatMessages } from '../../src/store/assistantChats.ts';
import type { Db } from '../../src/store/db.ts';
import { SpendGuard } from '../../src/spend/spendGuard.ts';
import { createTask, getTaskByCode } from '../../src/store/tasks.ts';
import { manualClock } from '../../src/util/clock.ts';
import { silentLogger } from '../../src/util/logger.ts';
import { AuditLog } from '../../src/web/audit.ts';
import { RateLimiter } from '../../src/web/guard.ts';
import { registerAssistantApi } from '../../src/web/routes/assistant.ts';
import { NOW, rows, seeded } from '../helpers/db.ts';
import { bootDashboard, OWNER } from '../helpers/web.ts';

// The assistant's routes on the real dashboard server, with a fake Claude (no real API call): the owner's guard, CSRF,
// the question limit, the streamed answer, Confirm running a card once, and the chats kept for the workspace (list,
// open, rename, delete, Stop), including an answer that goes on after the browser stops reading.

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

const PRICES = { inputPerMTok: 4, outputPerMTok: 20, cacheWritePerMTok: 5, cacheReadPerMTok: 0.4 };

/** Proposes marking SHA-001 done, then says so. */
class ProposingAi implements AssistantAi {
  readonly attempts = 1;
  calls = 0;
  readonly sent: unknown[] = [];
  async turn(req: { messages: unknown[] }, onText: (d: string) => void): Promise<AssistantTurn> {
    this.calls++;
    this.sent.push(structuredClone(req.messages));
    if (this.calls % 2 === 1) {
      return { content: [{ type: 'tool_use', id: `t${this.calls}`, name: 'propose_task_change', input: { code: 'SHA-1', status: 'done' } } as AssistantBlock], stopReason: 'tool_use', costUsd: 0.01, fallbackUsed: false };
    }
    onText('It is waiting for your Confirm.');
    return { content: [{ type: 'text', text: 'It is waiting for your Confirm.', citations: null } as AssistantBlock], stopReason: 'end_turn', costUsd: 0.01, fallbackUsed: false };
  }
}

/** Streams a first part, then waits for open() before the rest: an answer still running. */
class GatedAi implements AssistantAi {
  readonly attempts = 1;
  #open!: () => void;
  readonly #gate = new Promise<void>((r) => {
    this.#open = r;
  });
  #started!: () => void;
  readonly started = new Promise<void>((r) => {
    this.#started = r;
  });
  open(): void {
    this.#open();
  }
  async turn(_req: unknown, onText: (d: string) => void): Promise<AssistantTurn> {
    onText('Part one. ');
    this.#started();
    await this.#gate;
    onText('Part two.');
    return { content: [{ type: 'text', text: 'Part one. Part two.', citations: null } as AssistantBlock], stopReason: 'end_turn', costUsd: 0.01, fallbackUsed: false };
  }
}

async function boot(o: { askCapacity?: number; ai?: AssistantAi } = {}) {
  const { db, ids } = await seeded();
  const clock = manualClock(NOW);
  await createTask(db, {
    clientId: ids.sharma, side: 'us', title: 'Send the revised quote', category: 'design', priority: 'medium', assignedTo: null, askedBy: null,
    raisedOn: '2026-10-18', deadline: null, latestProgress: null, sourceQuote: null, sourceDate: null, sourceWaId: null, origin: 'whatsapp',
  }, NOW);
  const spend = new SpendGuard({ db, clock, capUsd: 10 });
  const settings = new SettingsStore({ db, env: parseEnv({}), clock });
  const pending = new PendingActions(clock);
  const ai = o.ai ?? new ProposingAi();
  const status: AgentStatus = { at: NOW, up: true, line: { ok: true, text: 'ok' }, parts: [], lastMessageAt: null, spentToday: 0, capUsd: 10 };
  const assistant = new Assistant({ ai, paid: spend, prices: PRICES, pending, settings, log: silentLogger(), clock, db, control: { status: async () => status }, spend, voiceLocal: false });
  const audit = new AuditLog(db, clock);
  const h = await bootDashboard({
    db, clock,
    mount: (router, x) => {
      x.sessions.onEnd((e) => assistant.forget(e));
      registerAssistantApi(router, {
        guard: x.guard, actions: x.actions, db, clock, assistant, pending, settings, audit,
        ...(o.askCapacity ? { asks: new RateLimiter({ capacity: o.askCapacity, refillPerSec: 1 / 3600, clock }) } : {}),
      });
    },
  });
  closers.push(() => h.close());
  return { db, h, ai, pending, assistant };
}

/** The answer's events, one JSON object per line. */
const lines = (raw: unknown) => String(raw).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
const auditRows = (db: Db) => rows<Record<string, string | null>>(db, 'SELECT actor, event, detail, request_id AS requestId FROM audit_log ORDER BY id');

describe('assistant API', () => {
  it('needs the signed-in owner, and CSRF for anything that asks or changes', async () => {
    const { h, ai } = await boot();
    for (const path of ['/dashboard/api/assistant', '/dashboard/api/assistant/chats', '/dashboard/api/assistant/chats/1']) {
      expect((await h.get(path, { cookie: null })).status, path).toBe(401);
    }
    expect(await h.get('/dashboard/api/assistant')).toMatchObject({ status: 200, json: { suggestions: expect.arrayContaining(['Summarise today']), questionMax: 2000 } });
    for (const path of ['ask', 'confirm', 'cancel', 'chats/1/rename', 'chats/1/delete', 'chats/1/stop']) {
      const body = { question: 'hi', id: 'x', title: 'x' };
      expect((await h.post(`/dashboard/api/assistant/${path}`, { body, cookie: null })).status, path).toBe(401);
      expect((await h.post(`/dashboard/api/assistant/${path}`, { body, csrf: null })).status, path).toBe(403);
      expect((await h.post(`/dashboard/api/assistant/${path}`, { body, origin: 'https://evil.example' })).status, path).toBe(403);
    }
    expect((await h.post('/dashboard/api/assistant/reset', { body: {} })).status).toBe(404); // New chat needs no route now
    expect(ai.calls).toBe(0);
  });

  it('caps the question and its length, and limits questions per client', async () => {
    const { h, ai } = await boot({ askCapacity: 2 });
    expect(await h.post('/dashboard/api/assistant/ask', { body: { question: '   ' } })).toMatchObject({ status: 422, json: { error: { field: 'question' } } });
    expect((await h.post('/dashboard/api/assistant/ask', { body: { question: 'x'.repeat(2001) } })).status).toBe(422);
    expect((await h.post('/dashboard/api/assistant/ask', { body: { question: 'x' } })).status).toBe(429); // the third question
    expect(ai.calls).toBe(0);
  });

  it('streams the answer as JSON lines, the chat first; Confirm runs the card once, audits it, and the chat records it', async () => {
    const { db, h, pending } = await boot();
    const r = await h.post('/dashboard/api/assistant/ask', { body: { question: 'Mark SHA-1 done' } });
    expect(r.status).toBe(200);
    expect(String(r.headers['content-type'])).toMatch(/^application\/x-ndjson/);
    const events = lines(r.json);
    expect(events.map((e) => e.type)).toEqual(['chat', 'tool', 'proposal', 'text', 'done']);
    expect(events[0]).toEqual({ type: 'chat', id: expect.any(Number), title: 'Mark SHA-1 done' });
    const chatId = events[0]!.id as number;
    const card = events[2]!.card as { id: string };
    expect((await getTaskByCode(db, 'SHA-001'))?.status).toBe('open'); // nothing changes before Confirm
    expect(await auditRows(db)).toEqual([]);
    expect((await h.get(`/dashboard/api/assistant/chats/${chatId}`)).json).toMatchObject({ messages: [{ role: 'user' }, { role: 'assistant', cards: [{ id: card.id, state: 'waiting', live: true }] }] });

    expect(await h.post('/dashboard/api/assistant/confirm', { body: { id: card.id } })).toMatchObject({ status: 200, json: { ok: true, message: 'SHA-001 updated.', task: 'SHA-001' } });
    expect((await getTaskByCode(db, 'SHA-001'))?.status).toBe('done');
    expect(await auditRows(db)).toEqual([{ actor: OWNER, event: 'task.done', detail: 'Task SHA-001 marked done · via assistant', requestId: expect.any(String) }]);
    expect((await h.get(`/dashboard/api/assistant/chats/${chatId}`)).json).toMatchObject({
      messages: [{}, { cards: [{ id: card.id, state: 'confirmed', said: 'SHA-001 updated.', live: false }] }],
    });
    // A replayed Confirm is refused and changes nothing more.
    expect(await h.post('/dashboard/api/assistant/confirm', { body: { id: card.id } })).toMatchObject({ status: 404, json: { error: { field: 'id' } } });
    expect(await auditRows(db)).toHaveLength(1);
    expect(pending.size()).toBe(0);
  });

  it('Cancel drops a card and the chat records it; signing out drops every card, and the chats stay', async () => {
    const { h, pending } = await boot();
    const asked = lines((await h.post('/dashboard/api/assistant/ask', { body: { question: 'a' } })).json);
    const first = asked[2]!.card as { id: string };
    expect(await h.post('/dashboard/api/assistant/cancel', { body: { id: first.id } })).toMatchObject({ status: 200 });
    expect((await h.post('/dashboard/api/assistant/confirm', { body: { id: first.id } })).status).toBe(404);
    expect((await h.get(`/dashboard/api/assistant/chats/${asked[0]!.id}`)).json).toMatchObject({ messages: [{}, { cards: [{ state: 'cancelled', live: false }] }] });
    lines((await h.post('/dashboard/api/assistant/ask', { body: { question: 'b' } })).json);
    expect(pending.size()).toBe(1);
    await h.sessions.destroyAllFor(OWNER);
    expect(pending.size()).toBe(0);
    const s = await h.sessions.create(OWNER);
    expect(((await h.get('/dashboard/api/assistant/chats', { cookie: s.id })).json as { chats: unknown[] }).chats).toHaveLength(2);
  });

  it('lists, opens, continues, renames and deletes the workspace\'s chats', async () => {
    const { h, ai } = await boot();
    const a = lines((await h.post('/dashboard/api/assistant/ask', { body: { question: 'First chat' } })).json)[0]!.id as number;
    const b = lines((await h.post('/dashboard/api/assistant/ask', { body: { question: 'Second chat' } })).json)[0]!.id as number;
    const list = (await h.get('/dashboard/api/assistant/chats')).json as { chats: { id: number; title: string; running: boolean }[] };
    expect(list.chats.map((c) => [c.title, c.running]).sort()).toEqual([['First chat', false], ['Second chat', false]]);

    // A question in chat a goes on from its earlier turns.
    const more = lines((await h.post('/dashboard/api/assistant/ask', { body: { chatId: a, question: 'And then?' } })).json);
    expect(more[0]).toMatchObject({ type: 'chat', id: a, title: 'First chat' });
    expect(ai instanceof ProposingAi && (ai.sent.at(-2) as { role: string }[]).slice(0, 2).map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(((await h.get(`/dashboard/api/assistant/chats/${a}`)).json as { messages: unknown[] }).messages).toHaveLength(4);

    expect(await h.post(`/dashboard/api/assistant/chats/${a}/rename`, { body: { title: '  Acme   plan ' } })).toMatchObject({ status: 200, json: { chat: { id: a, title: 'Acme plan' } } });
    expect(await h.post(`/dashboard/api/assistant/chats/${a}/rename`, { body: { title: '' } })).toMatchObject({ status: 422, json: { error: { field: 'title' } } });
    expect((await h.post(`/dashboard/api/assistant/chats/${a}/rename`, { body: { title: 'x'.repeat(81) } })).status).toBe(422);
    expect((await h.get(`/dashboard/api/assistant/chats/${a}`)).json).toMatchObject({ chat: { title: 'Acme plan' }, running: false });
    expect(await h.post(`/dashboard/api/assistant/chats/${a}/stop`, { body: {} })).toMatchObject({ status: 200, json: { stopped: false } });

    expect((await h.post(`/dashboard/api/assistant/chats/${b}/delete`, { body: {} })).status).toBe(200);
    expect((await h.get(`/dashboard/api/assistant/chats/${b}`)).status).toBe(404);
    expect((await h.post(`/dashboard/api/assistant/chats/${b}/delete`, { body: {} })).status).toBe(404);
    expect(((await h.get('/dashboard/api/assistant/chats')).json as { chats: { id: number }[] }).chats.map((c) => c.id)).toEqual([a]);
  });

  it('a chat id that is malformed, unknown or another workspace\'s is a 404 everywhere, and nothing is asked', async () => {
    const one = await boot();
    const theirs = lines((await one.h.post('/dashboard/api/assistant/ask', { body: { question: 'Theirs' } })).json)[0]!.id as number;
    const { h, ai } = await boot(); // another workspace: on Postgres a customer of its own; on SQLite a database of its own
    const calls = ai instanceof ProposingAi ? ai.calls : 0;
    for (const id of [String(theirs), '0', 'abc', '1e3', '99999999999999999']) {
      expect((await h.get(`/dashboard/api/assistant/chats/${id}`)).status, id).toBe(404);
      for (const action of ['rename', 'delete', 'stop']) expect((await h.post(`/dashboard/api/assistant/chats/${id}/${action}`, { body: { title: 'mine' } })).status, `${action} ${id}`).toBe(404);
    }
    for (const chatId of [theirs, 0, -1, 'x', 1.5]) expect((await h.post('/dashboard/api/assistant/ask', { body: { chatId, question: 'hi' } })).status, String(chatId)).toBe(404);
    expect(ai instanceof ProposingAi ? ai.calls : 0).toBe(calls);
    expect((await one.h.get(`/dashboard/api/assistant/chats/${theirs}`)).json).toMatchObject({ chat: { title: 'Theirs' } });
  });

  it('an answer goes on and is saved after the browser stops reading; Stop on another visit ends it', async () => {
    const ai = new GatedAi();
    const { db, h, assistant } = await boot({ ai });
    const s = await h.sessions.create(OWNER);
    const leaving = new AbortController();
    const res = await fetch(`http://127.0.0.1:${h.port}/dashboard/api/assistant/ask`, {
      method: 'POST', signal: leaving.signal,
      headers: { cookie: `wa_session=${s.id}`, 'x-csrf-token': s.csrf, origin: `http://127.0.0.1:${h.port}`, 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'a long one' }),
    });
    const reader = res.body!.getReader();
    const first = JSON.parse(new TextDecoder().decode((await reader.read()).value).split('\n')[0]!) as { id: number };
    await ai.started;
    leaving.abort(); // the owner opened another screen
    await reader.cancel().catch(() => undefined);
    expect((await h.get('/dashboard/api/assistant/chats')).json).toMatchObject({ chats: [{ id: first.id, running: true }] });
    expect((await h.get(`/dashboard/api/assistant/chats/${first.id}`)).json).toMatchObject({ running: true, messages: [{}, { status: 'running' }] });
    ai.open();
    await expect.poll(() => assistant.running(first.id)).toBe(false);
    expect((await chatMessages(db, first.id))[1]).toMatchObject({ status: 'done', body: 'Part one. Part two.' });
    expect((await h.get(`/dashboard/api/assistant/chats/${first.id}`)).json).toMatchObject({ running: false, messages: [{}, { status: 'done' }] });
  });

  it('Stop through the API ends a running answer, keeps its text and marks it stopped', async () => {
    const ai = new GatedAi();
    const { h, assistant } = await boot({ ai });
    const asking = h.post('/dashboard/api/assistant/ask', { body: { question: 'stop me' } });
    await ai.started;
    const id = ((await h.get('/dashboard/api/assistant/chats')).json as { chats: { id: number }[] }).chats[0]!.id;
    expect(await h.post(`/dashboard/api/assistant/chats/${id}/stop`, { body: {} })).toMatchObject({ status: 200, json: { stopped: true } });
    ai.open();
    const events = lines((await asking).json);
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'stopped', note: 'Stopped.' });
    expect(assistant.running(id)).toBe(false);
    expect((await h.get(`/dashboard/api/assistant/chats/${id}`)).json).toMatchObject({ messages: [{}, { status: 'stopped', body: 'Part one.', note: 'Stopped.' }] });
  });
});
