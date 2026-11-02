import { afterEach, describe, expect, it } from 'vitest';
import { Assistant, type AssistantAi, type AssistantBlock, type AssistantEvent, type AssistantMessage, type AssistantTurn } from '../../src/assistant/assistant.ts';
import { PendingActions } from '../../src/assistant/proposals.ts';
import { parseEnv } from '../../src/config/env.ts';
import { SettingsStore } from '../../src/config/settingsStore.ts';
import type { AgentStatus } from '../../src/control/agentControl.ts';
import { SpendGuard } from '../../src/spend/spendGuard.ts';
import { chatMessages, listChats } from '../../src/store/assistantChats.ts';
import { syncClients } from '../../src/store/clients.ts';
import type { Db } from '../../src/store/db.ts';
import { createTask, getTaskByCode } from '../../src/store/tasks.ts';
import { manualClock } from '../../src/util/clock.ts';
import { silentLogger } from '../../src/util/logger.ts';
import { AuditLog } from '../../src/web/audit.ts';
import { registerAssistantApi } from '../../src/web/routes/assistant.ts';
import { idOf, SHARMA } from '../helpers/db.ts';
import { onPg, openTestTenantDb } from '../helpers/pg.ts';
import { bootDashboard, OWNER } from '../helpers/web.ts';

// A customer's assistant reads and changes only its own workspace (November release, piece 3), on a real Postgres under
// row-level security. Two customers, A and B, each with the same client code (SHA) and the same task code (SHA-001) but
// their own titles; each with its own Assistant as its runtime wires it: its own Db, SpendGuard and daily limit,
// PendingActions and customer settings store, and `customer` (no Connections or AI usage). A scripted Claude (no call
// reaches Anthropic) asks the read tools and drafts a change; everything it is handed, and every change, stays in A.

const NOW = '2026-11-02T08:00:00.000Z';
const PRICES = { inputPerMTok: 4, outputPerMTok: 20, cacheWritePerMTok: 5, cacheReadPerMTok: 0.4 };
const text = (s: string): AssistantBlock => ({ type: 'text', text: s, citations: null }) as AssistantBlock;
let n = 0;
const use = (name: string, input: unknown): AssistantBlock => ({ type: 'tool_use', id: `toolu_${++n}`, name, input }) as AssistantBlock;

/** Plays a script of turns; records the system prompt, the tools and every tool result it was handed. */
class ScriptAi implements AssistantAi {
  readonly attempts = 1;
  calls = 0;
  readonly systems: string[] = [];
  readonly tools: { name: string; input_schema: unknown }[][] = [];
  readonly results: string[] = [];
  readonly script: AssistantBlock[][];
  constructor(script: AssistantBlock[][]) {
    this.script = script;
  }
  async turn(req: { system: string; tools: { name: string; input_schema: unknown }[]; messages: AssistantMessage[] }, onText: (d: string) => void): Promise<AssistantTurn> {
    this.calls++;
    this.systems.push(req.system);
    this.tools.push(req.tools);
    const last = req.messages.at(-1)!;
    if (Array.isArray(last.content)) {
      for (const b of last.content as { type: string; content?: unknown }[]) if (b.type === 'tool_result') this.results.push(String(b.content));
    }
    const content = this.script[this.calls - 1] ?? [text('Done.')];
    for (const b of content) if (b.type === 'text') onText(b.text);
    return { content, stopReason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', costUsd: 0.05, fallbackUsed: false };
  }
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

/** One customer, wired as its runtime wires its assistant. */
async function customer(name: string, title: string, ai: AssistantAi, capUsd = 5) {
  const db = await openTestTenantDb(name);
  const clock = manualClock(NOW);
  await syncClients(db, [SHARMA]);
  await createTask(db, {
    clientId: await idOf(db, 'SHA'), side: 'us', title, category: 'design', priority: 'medium', assignedTo: null, askedBy: null,
    raisedOn: '2026-11-01', deadline: null, latestProgress: null, sourceQuote: null, sourceDate: null, sourceWaId: null, origin: 'whatsapp',
  }, NOW);
  const spend = new SpendGuard({ db, clock, capUsd });
  const settings = new SettingsStore({ db, env: parseEnv({}), clock, customer: true });
  const pending = new PendingActions(clock);
  const status: AgentStatus = { at: NOW, up: true, line: { ok: true, text: 'ok' }, parts: [], lastMessageAt: null, spentToday: 0, capUsd };
  const assistant = new Assistant({
    ai, paid: spend, prices: PRICES, pending, settings, log: silentLogger(), clock, db, control: { status: async () => status }, spend, voiceLocal: false, customer: true,
  });
  const ask = async (question: string, chatId?: number) => {
    const events: AssistantEvent[] = [];
    let chat = 0;
    await assistant.ask({ key: `${name}-session`.padEnd(64, 'x'), email: OWNER }, { question, ...(chatId ? { chatId } : {}) }, (c) => {
      chat = c.id;
    }, (e) => events.push(e));
    return { events, chat };
  };
  return { db, clock, spend, settings, pending, assistant, ask };
}

const titleOf = async (db: Db) => (await getTaskByCode(db, 'SHA-001'))?.title;

describe.runIf(onPg)('a customer\'s assistant stays in its own workspace (Postgres, row-level security)', () => {
  it('reads only its own tasks and client, and is never offered, told of or linked to Connections or AI usage', async () => {
    const aiA = new ScriptAi([
      [use('list_tasks', {}), use('get_client', { code: 'SHA' }), use('get_task', { code: 'SHA-001' })],
      [use('open_screen', { screen: 'usage' }), use('open_screen', { screen: 'connections' }), use('open_screen', { screen: 'tasks', status: 'open' })],
      [text('Here you are.')],
    ]);
    const a = await customer('a', 'Alpha only: the banner', aiA);
    const b = await customer('b', 'Bravo only: the secret plan', new ScriptAi([]));
    const { events } = await a.ask('What is open?');
    const seen = aiA.results.join('\n');
    expect(seen).toContain('Alpha only: the banner');
    expect(seen).not.toContain('Bravo only');
    // Not offered: the open_screen tool names neither screen; not told of them: the prompt says they are not there.
    const screens = (aiA.tools[0]!.find((t) => t.name === 'open_screen')!.input_schema as { properties: { screen: { enum: string[] } } }).properties.screen.enum;
    expect(screens).not.toContain('usage');
    expect(screens).not.toContain('connections');
    expect(screens).toContain('tasks');
    expect(aiA.systems[0]).toContain('It has no Connections or AI usage screen: never mention, offer or point to them.');
    // Not linked: only the Tasks link was made; the other two were refused as screens not in this workspace.
    expect(events.filter((e) => e.type === 'navigate').map((e) => (e as { screen: string }).screen)).toEqual(['tasks']);
    expect(aiA.results.filter((r) => r === 'That screen is not in this workspace.')).toHaveLength(2);
    expect(await titleOf(b.db)).toBe('Bravo only: the secret plan');
  });

  it('a change it drafts and A confirms changes A\'s task only, audited in A\'s log only; A\'s chats are not B\'s', async () => {
    const aiA = new ScriptAi([[use('propose_task_change', { code: 'SHA-1', status: 'done' })], [text('Waiting for your Confirm.')]]);
    const a = await customer('a', 'Alpha task', aiA);
    const b = await customer('b', 'Bravo task', new ScriptAi([]));
    const audit = new AuditLog(a.db, a.clock);
    const h = await bootDashboard({
      db: a.db, clock: a.clock,
      mount: (router, x) => registerAssistantApi(router, { guard: x.guard, actions: x.actions, db: a.db, clock: a.clock, assistant: a.assistant, pending: a.pending, settings: a.settings, audit }),
    });
    closers.push(() => h.close());
    const asked = String((await h.post('/dashboard/api/assistant/ask', { body: { question: 'Mark SHA-1 done' } })).json).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    const chatId = asked[0]!.id as number;
    const card = asked.find((e) => e.type === 'proposal')!.card as { id: string };
    expect(await h.post('/dashboard/api/assistant/confirm', { body: { id: card.id } })).toMatchObject({ status: 200, json: { ok: true } });
    expect((await getTaskByCode(a.db, 'SHA-001'))?.status).toBe('done');
    expect((await getTaskByCode(b.db, 'SHA-001'))?.status).toBe('open');
    expect((await a.db.get<{ n: number }>("SELECT COUNT(*)::int AS n FROM audit_log WHERE detail LIKE '%via assistant%'"))?.n).toBe(1);
    expect((await b.db.get<{ n: number }>('SELECT COUNT(*)::int AS n FROM audit_log'))?.n).toBe(0);
    // B never sees A's chat, and cannot reach it through its own assistant either.
    expect((await listChats(a.db)).map((c) => c.id)).toEqual([chatId]);
    expect(await listChats(b.db)).toEqual([]);
    expect(await chatMessages(b.db, chatId)).toEqual([]);
    await expect(b.assistant.ask({ key: 'b'.repeat(64), email: OWNER }, { chatId, question: 'hi' }, () => {}, () => {})).rejects.toMatchObject({ status: 404 });
  });

  it('A\'s spend is booked in A\'s rows only, its AI usage tool reads only its own, and its limit stops it while B still asks', async () => {
    const aiA = new ScriptAi([[use('get_ai_usage', {})], [text('That is your spend.')]]);
    const a = await customer('a', 'Alpha task', aiA, 1);
    const aiB = new ScriptAi([[text('Fine.')]]);
    const b = await customer('b', 'Bravo task', aiB, 5);
    await a.ask('What did I spend?');
    await a.spend.flushed();
    await b.spend.flushed();
    const spent = async (db: Db) => (await db.get<{ usd: number }>('SELECT COALESCE(SUM(usd), 0)::float AS usd FROM spend'))!.usd;
    expect(await spent(a.db)).toBeCloseTo(0.1, 6); // two calls of $0.05, on A's own key and rows
    expect(await spent(b.db)).toBe(0);
    // Its usage tool was handed A's own figures: A's limit of $1, never B's or the founder's.
    expect(aiA.results.join('\n')).toContain('"capUsd":1');

    // A reaches its own limit: its next question makes no call and says so; B, on its own limit, still asks.
    a.spend.record('ai', 1, 'test: A at its limit');
    await a.spend.flushed();
    const callsBefore = aiA.calls;
    const stopped = await a.ask('Anything else?');
    expect(aiA.calls).toBe(callsBefore);
    expect(stopped.events.at(-1)).toMatchObject({ type: 'done', status: 'failed', note: "Today's AI spend cap is reached, so the assistant is paused until tomorrow." });
    const fine = await b.ask('Hello');
    expect(aiB.calls).toBe(1);
    expect(fine.events.at(-1)).toMatchObject({ type: 'done', status: 'done' });
    expect(await spent(b.db)).toBeCloseTo(0.05, 6);
  });
});
