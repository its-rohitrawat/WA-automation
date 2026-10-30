import { describe, expect, it, vi } from 'vitest';
import { Reconciler } from '../../src/brain/reconciler.ts';
import { SENTIMENT_RULES, SYSTEM_PROMPT } from '../../src/brain/prompt.ts';
import { NO_KEYWORDS, type PriorityKeywords } from '../../src/brain/priorityKeywords.ts';
import type { PriorityConfig } from '../../src/config/prioritySettings.ts';
import type { Prices } from '../../src/spend/pricing.ts';
import { SpendGuard } from '../../src/spend/spendGuard.ts';
import { getClient } from '../../src/store/clients.ts';
import type { Db } from '../../src/store/db.ts';
import { insertMessage } from '../../src/store/messages.ts';
import { upsertPerson } from '../../src/store/people.ts';
import { createTask, getTaskByCode, updateTaskFields, type Priority } from '../../src/store/tasks.ts';
import { manualClock } from '../../src/util/clock.ts';
import { silentLogger } from '../../src/util/logger.ts';
import { FakeAi, op, type FakeResponse } from '../helpers/ai.ts';
import { NOW, seededDb } from '../helpers/db.ts';
import { SHARMA_PN } from '../helpers/wa.ts';
import { rawOf } from '../../src/store/engine/sqlite.ts';

const P: Prices = { inputPerMTok: 4, outputPerMTok: 20, cacheWritePerMTok: 5, cacheReadPerMTok: 0.2 };
const KEYWORDS: PriorityKeywords = { ...NO_KEYWORDS, critical: ['urgent', 'site down'], major: ['important'], low: ['no rush'] };

async function setup(responses: FakeResponse[], config: PriorityConfig | (() => PriorityConfig) = { keywords: KEYWORDS, sentimentEnabled: false }) {
  const db = await seededDb();
  const clock = manualClock('2026-10-19T08:00:00Z');
  const spend = new SpendGuard({ db, clock, capUsd: 15 });
  const ai = new FakeAi(responses);
  const log = silentLogger();
  const r = new Reconciler({
    db, ai, spend, prices: P, clock, log, onChanged: vi.fn(), priority: typeof config === 'function' ? config : () => config,
  });
  return { db, ai, r, log };
}

async function store(db: Db, waId: string, text: string, ts = '2026-10-19T07:00:00.000Z'): Promise<void> {
  await insertMessage(db, { waId, clientId: 1, senderJid: SHARMA_PN, senderNumber: '919800000001', senderName: 'Mr. Sharma', fromMe: false, ts, text, quotedWaId: null, mediaType: null });
  await upsertPerson(db, { clientId: 1, jid: SHARMA_PN, number: '919800000001', name: 'Mr. Sharma', fromMe: false });
}

/** SHA-001, made before this batch with the given level (null: made before priority levels). */
async function banner(db: Db, priority: Priority | null = 'medium', source: 'ai' | 'keyword' = 'ai'): Promise<void> {
  await createTask(db, { clientId: 1, side: 'us', title: 'Banner', category: 'design', priority: priority ?? 'medium', prioritySource: source, assignedTo: null, askedBy: null,
    raisedOn: '2026-10-10', deadline: null, latestProgress: null, sourceQuote: null, sourceDate: null, sourceWaId: null, origin: 'whatsapp' }, NOW);
  if (priority === null) rawOf(db).prepare("UPDATE tasks SET priority_level = NULL, priority_source = NULL, priority = 'high' WHERE code = 'SHA-001'").run();
}

const add = (ids: string[], priority: Priority = 'medium', extra: Partial<Parameters<typeof op>[0]> = {}) =>
  op({ op: 'add_task', sourceMessageIds: ids, side: 'us', title: 'Fix footer', category: 'development', priority, ...extra });
const row = (db: Db, code: string) =>
  rawOf(db).prepare('SELECT priority, priority_level AS level, priority_source AS source, priority_keyword AS keyword, sentiment FROM tasks WHERE code = ?').get(code);

describe('Reconciler: priority keywords', () => {
  it('a keyword in a new task\'s message wins over the AI\'s guess, even a more urgent guess, and is recorded', async () => {
    const { db, r } = await setup([{ ops: [add(['A1'], 'low'), add(['A2'], 'critical', { title: 'Logo' })] }]);
    await store(db, 'A1', 'Footer theek karo, URGENT hai');
    await store(db, 'A2', 'Logo, no rush');
    await r.run(1);
    expect(row(db, 'SHA-001')).toEqual({ priority: 'high', level: 'critical', source: 'keyword', keyword: 'urgent', sentiment: null });
    expect(row(db, 'SHA-002')).toEqual({ priority: 'low', level: 'low', source: 'keyword', keyword: 'no rush', sentiment: null });
  });

  it('without a keyword the AI\'s level is kept, with the old column in step', async () => {
    const { db, r } = await setup([{ ops: [add(['A1'], 'major')] }]);
    await store(db, 'A1', 'Footer ka kaam');
    await r.run(1);
    expect(row(db, 'SHA-001')).toEqual({ priority: 'high', level: 'major', source: 'ai', keyword: null, sentiment: null });
  });

  it('matches the keyword in a cited context message as well', async () => {
    const { db, r } = await setup([{ ops: [add(['A2', 'A1'])] }]);
    await store(db, 'A1', 'site down hai', '2026-10-19T06:00:00.000Z');
    rawOf(db).prepare("UPDATE messages SET processed_at = ? WHERE wa_id = 'A1'").run(NOW);
    await store(db, 'A2', 'please fix');
    await r.run(1);
    expect(row(db, 'SHA-001')).toMatchObject({ level: 'critical', keyword: 'site down' });
  });

  it('after a task is made, a keyword only raises its priority, on an update and on a reminder', async () => {
    const { db, r } = await setup([
      { ops: [op({ op: 'log_reminder', taskCode: 'SHA-001', sourceMessageIds: ['A1'] })] },
      { ops: [op({ op: 'update_task', taskCode: 'SHA-001', sourceMessageIds: ['A2'], latestProgress: 'v2 sent' })] },
    ]);
    await banner(db, 'medium');
    await store(db, 'A1', 'Banner ka kya hua? important hai');
    await r.run(1);
    expect(row(db, 'SHA-001')).toMatchObject({ level: 'major', source: 'keyword', keyword: 'important' });
    const events = rawOf(db).prepare("SELECT op, detail, reason FROM task_events WHERE task_id = 1 ORDER BY id").all();
    expect(events).toEqual([
      { op: 'log_reminder', detail: JSON.stringify({ reminder: '2026-10-19' }), reason: 'test' },
      { op: 'update_task', detail: JSON.stringify({ priority: 'major' }), reason: 'priority keyword' },
    ]);
    // A less urgent keyword later never lowers it.
    await store(db, 'A2', 'no rush on the banner now', '2026-10-19T07:30:00.000Z');
    await r.run(1);
    expect(row(db, 'SHA-001')).toMatchObject({ level: 'major', source: 'keyword', keyword: 'important' });
    expect((await getTaskByCode(db, 'SHA-001'))!.latestProgress).toBe('v2 sent');
  });

  it('gives a task from before priority levels its first level from a keyword', async () => {
    const { db, r } = await setup([{ ops: [op({ op: 'log_reminder', taskCode: 'SHA-001', sourceMessageIds: ['A1'] })] }]);
    await banner(db, null);
    expect(row(db, 'SHA-001')).toMatchObject({ level: null, priority: 'high' });
    await store(db, 'A1', 'no rush, but banner?');
    await r.run(1);
    expect(row(db, 'SHA-001')).toEqual({ priority: 'low', level: 'low', source: 'keyword', keyword: 'no rush', sentiment: null });
  });

  it('never lowers a keyword\'s priority on the AI\'s guess, but lets the AI raise it', async () => {
    const { db, r } = await setup([
      { ops: [op({ op: 'update_task', taskCode: 'SHA-001', sourceMessageIds: ['A1'], priority: 'low', latestProgress: 'started' })] },
      { ops: [op({ op: 'update_task', taskCode: 'SHA-001', sourceMessageIds: ['A2'], priority: 'critical' })] },
    ]);
    await banner(db, 'major', 'keyword');
    await store(db, 'A1', 'started on it');
    await r.run(1);
    expect(row(db, 'SHA-001')).toMatchObject({ level: 'major', source: 'keyword' });
    expect((await getTaskByCode(db, 'SHA-001'))!.latestProgress).toBe('started');
    await store(db, 'A2', 'client is waiting', '2026-10-19T07:30:00.000Z');
    await r.run(1);
    expect(row(db, 'SHA-001')).toMatchObject({ level: 'critical', source: 'ai', keyword: null, priority: 'high' });
  });

  it('never changes a priority the owner set, keyword or not', async () => {
    const { db, r } = await setup([{ ops: [op({ op: 'log_reminder', taskCode: 'SHA-001', sourceMessageIds: ['A1'] })] }]);
    await banner(db, 'medium');
    await updateTaskFields(db, 1, { priority: 'low' }, NOW, 'human');
    await store(db, 'A1', 'URGENT: banner?');
    await r.run(1);
    expect(row(db, 'SHA-001')).toEqual({ priority: 'low', level: 'low', source: 'human', keyword: null, sentiment: null });
  });

  it('runs without keywords when the settings cannot be read', async () => {
    const { db, r } = await setup([{ ops: [add(['A1'], 'medium')] }], () => {
      throw new Error('settings table locked');
    });
    await store(db, 'A1', 'urgent footer');
    expect(await r.run(1)).toMatchObject({ status: 'ok', accepted: 1 });
    expect(row(db, 'SHA-001')).toMatchObject({ level: 'medium', source: 'ai' });
  });
});

describe('Reconciler: sentiment', () => {
  it('switched off: the read asks for none, the prompt has no sentiment rules, and a stray mood is not stored', async () => {
    const { db, ai, r } = await setup([{ ops: [add(['A1'], 'medium', { sentiment: 'frustrated' }), op({ op: 'set_status', sourceMessageIds: ['A1'], text: 'Footer in progress.', sentiment: 'negative' })] }]);
    await store(db, 'A1', 'footer abhi tak nahi hua?!');
    await r.run(1);
    expect(ai.options).toEqual([{ sentiment: false }]);
    expect(ai.calls[0]!.system).toBe(SYSTEM_PROMPT);
    expect(row(db, 'SHA-001')).toMatchObject({ sentiment: null });
    expect(await getClient(db, 1)).toMatchObject({ sentiment: null, sentimentAt: null });
  });

  it('switched on: the read asks for it, the task keeps its mood and set_status gives the client\'s', async () => {
    const { db, ai, r } = await setup([{
      ops: [add(['A1'], 'medium', { sentiment: 'frustrated' }), op({ op: 'set_status', sourceMessageIds: ['A1'], text: 'Footer late.', sentiment: 'negative' })],
    }], { keywords: NO_KEYWORDS, sentimentEnabled: true });
    await store(db, 'A1', 'footer abhi tak nahi hua?!');
    await r.run(1);
    expect(ai.options).toEqual([{ sentiment: true }]);
    expect(ai.calls[0]!.system).toBe(`${SYSTEM_PROMPT}${SENTIMENT_RULES}`);
    expect(row(db, 'SHA-001')).toMatchObject({ sentiment: 'frustrated' });
    expect(await getClient(db, 1)).toMatchObject({ sentiment: 'negative', sentimentAt: '2026-10-19T08:00:00.000Z' });
  });

  it('switched on: an update with only a new mood is applied, and a mood left empty changes nothing', async () => {
    const { db, r } = await setup([
      { ops: [op({ op: 'update_task', taskCode: 'SHA-001', sourceMessageIds: ['A1'], sentiment: 'positive' })] },
      { ops: [op({ op: 'update_task', taskCode: 'SHA-001', sourceMessageIds: ['A2'], latestProgress: 'v3', sentiment: null })] },
    ], { keywords: NO_KEYWORDS, sentimentEnabled: true });
    await banner(db);
    await store(db, 'A1', 'perfect, thanks!');
    expect(await r.run(1)).toMatchObject({ status: 'ok', accepted: 1, rejected: 0 });
    expect(row(db, 'SHA-001')).toMatchObject({ sentiment: 'positive' });
    await store(db, 'A2', 'v3 shared', '2026-10-19T07:30:00.000Z');
    await r.run(1);
    expect(row(db, 'SHA-001')).toMatchObject({ sentiment: 'positive' });
  });

  it('a change of the switch applies to the next batch', async () => {
    let on = false;
    const { db, ai, r } = await setup([{ ops: [] }, { ops: [] }], () => ({ keywords: NO_KEYWORDS, sentimentEnabled: on }));
    await store(db, 'A1', 'hello');
    await r.run(1);
    on = true;
    await store(db, 'A2', 'hello again', '2026-10-19T07:30:00.000Z');
    await r.run(1);
    expect(ai.options).toEqual([{ sentiment: false }, { sentiment: true }]);
  });
});
