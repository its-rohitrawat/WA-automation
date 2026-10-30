import { afterEach, describe, expect, it } from 'vitest';
import { Assistant, type AssistantAi, type AssistantBlock, type AssistantTurn } from '../../src/assistant/assistant.ts';
import { PendingActions } from '../../src/assistant/proposals.ts';
import { parseEnv } from '../../src/config/env.ts';
import { SettingsStore } from '../../src/config/settingsStore.ts';
import type { AgentStatus } from '../../src/control/agentControl.ts';
import type { Db } from '../../src/store/db.ts';
import { SpendGuard } from '../../src/spend/spendGuard.ts';
import { createTask, getTaskByCode } from '../../src/store/tasks.ts';
import { manualClock } from '../../src/util/clock.ts';
import { silentLogger } from '../../src/util/logger.ts';
import { AuditLog } from '../../src/web/audit.ts';
import { RateLimiter } from '../../src/web/guard.ts';
import { registerAssistantApi } from '../../src/web/routes/assistant.ts';
import { NOW, seededDb } from '../helpers/db.ts';
import { bootDashboard, OWNER } from '../helpers/web.ts';
import { rawOf } from '../../src/store/engine/sqlite.ts';

// The assistant's routes on the real dashboard server, with a fake Claude (no real API call): the owner's guard, CSRF,
// the question limit, the streamed answer, and Confirm running a card once.

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

const PRICES = { inputPerMTok: 4, outputPerMTok: 20, cacheWritePerMTok: 5, cacheReadPerMTok: 0.4 };

/** Proposes marking SHA-001 done, then says so. */
class ProposingAi implements AssistantAi {
  readonly attempts = 1;
  calls = 0;
  async turn(_req: unknown, onText: (d: string) => void): Promise<AssistantTurn> {
    this.calls++;
    if (this.calls % 2 === 1) {
      return { content: [{ type: 'tool_use', id: `t${this.calls}`, name: 'propose_task_change', input: { code: 'SHA-1', status: 'done' } } as AssistantBlock], stopReason: 'tool_use', costUsd: 0.01, fallbackUsed: false };
    }
    onText('It is waiting for your Confirm.');
    return { content: [{ type: 'text', text: 'It is waiting for your Confirm.', citations: null } as AssistantBlock], stopReason: 'end_turn', costUsd: 0.01, fallbackUsed: false };
  }
}

async function boot(o: { askCapacity?: number } = {}) {
  const db = await seededDb();
  const clock = manualClock(NOW);
  await createTask(db, {
    clientId: 1, side: 'us', title: 'Send the revised quote', category: 'design', priority: 'medium', assignedTo: null, askedBy: null,
    raisedOn: '2026-10-18', deadline: null, latestProgress: null, sourceQuote: null, sourceDate: null, sourceWaId: null, origin: 'whatsapp',
  }, NOW);
  const spend = new SpendGuard({ db, clock, capUsd: 10 });
  const settings = new SettingsStore({ db, env: parseEnv({}), clock });
  const pending = new PendingActions(clock);
  const ai = new ProposingAi();
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
  return { db, h, ai, pending };
}

/** The answer's events, one JSON object per line. */
const lines = (raw: unknown) => String(raw).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
const auditRows = (db: Db) => rawOf(db).prepare('SELECT actor, event, detail, request_id AS requestId FROM audit_log ORDER BY id').all() as Record<string, string | null>[];

describe('assistant API', () => {
  it('needs the signed-in owner, and CSRF for anything that asks or changes', async () => {
    const { h, ai } = await boot();
    expect((await h.get('/dashboard/api/assistant', { cookie: null })).status).toBe(401);
    expect(await h.get('/dashboard/api/assistant')).toMatchObject({ status: 200, json: { suggestions: expect.arrayContaining(['Summarise today']), questionMax: 2000 } });
    for (const path of ['ask', 'confirm', 'cancel', 'reset']) {
      const body = { question: 'hi', id: 'x' };
      expect((await h.post(`/dashboard/api/assistant/${path}`, { body, cookie: null })).status, path).toBe(401);
      expect((await h.post(`/dashboard/api/assistant/${path}`, { body, csrf: null })).status, path).toBe(403);
      expect((await h.post(`/dashboard/api/assistant/${path}`, { body, origin: 'https://evil.example' })).status, path).toBe(403);
    }
    expect(ai.calls).toBe(0);
  });

  it('caps the question and its length, and limits questions per client', async () => {
    const { h, ai } = await boot({ askCapacity: 2 });
    expect(await h.post('/dashboard/api/assistant/ask', { body: { question: '   ' } })).toMatchObject({ status: 422, json: { error: { field: 'question' } } });
    expect((await h.post('/dashboard/api/assistant/ask', { body: { question: 'x'.repeat(2001) } })).status).toBe(422);
    expect((await h.post('/dashboard/api/assistant/ask', { body: { question: 'x' } })).status).toBe(429); // the third question
    expect(ai.calls).toBe(0);
  });

  it('streams the answer as JSON lines; Confirm runs the card once and audits it via assistant', async () => {
    const { db, h, pending } = await boot();
    const r = await h.post('/dashboard/api/assistant/ask', { body: { question: 'Mark SHA-1 done' } });
    expect(r.status).toBe(200);
    expect(String(r.headers['content-type'])).toMatch(/^application\/x-ndjson/);
    const events = lines(r.json);
    expect(events.map((e) => e.type)).toEqual(['tool', 'proposal', 'text', 'done']);
    const card = events[1]!.card as { id: string };
    expect((await getTaskByCode(db, 'SHA-001'))?.status).toBe('open'); // nothing changes before Confirm
    expect(auditRows(db)).toEqual([]);

    expect(await h.post('/dashboard/api/assistant/confirm', { body: { id: card.id } })).toMatchObject({ status: 200, json: { ok: true, message: 'SHA-001 updated.', task: 'SHA-001' } });
    expect((await getTaskByCode(db, 'SHA-001'))?.status).toBe('done');
    expect(auditRows(db)).toEqual([{ actor: OWNER, event: 'task.done', detail: 'Task SHA-001 marked done · via assistant', requestId: expect.any(String) }]);
    // A replayed Confirm is refused and changes nothing more.
    expect(await h.post('/dashboard/api/assistant/confirm', { body: { id: card.id } })).toMatchObject({ status: 404, json: { error: { field: 'id' } } });
    expect(auditRows(db)).toHaveLength(1);
    expect(pending.size()).toBe(0);
  });

  it('Cancel drops a card; signing out drops the chat and every card', async () => {
    const { h, pending } = await boot();
    const first = lines((await h.post('/dashboard/api/assistant/ask', { body: { question: 'a' } })).json)[1]!.card as { id: string };
    expect(await h.post('/dashboard/api/assistant/cancel', { body: { id: first.id } })).toMatchObject({ status: 200 });
    expect((await h.post('/dashboard/api/assistant/confirm', { body: { id: first.id } })).status).toBe(404);
    lines((await h.post('/dashboard/api/assistant/ask', { body: { question: 'b' } })).json);
    expect(pending.size()).toBe(1);
    await h.sessions.destroyAllFor(OWNER);
    expect(pending.size()).toBe(0);
  });
});
