import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { AiInvalidOutputError, AiRefusalError, MAX_OUTPUT_TOKENS, SDK_MAX_RETRIES } from '../../src/brain/claudeClient.ts';
import { Reconciler } from '../../src/brain/reconciler.ts';
import { closeTask, requestReprocess } from '../../src/cli/corrections.ts';
import { estimateCostUsd, type Prices } from '../../src/spend/pricing.ts';
import { SpendGuard } from '../../src/spend/spendGuard.ts';
import { latestBatches } from '../../src/store/batches.ts';
import { getClient } from '../../src/store/clients.ts';
import type { Db } from '../../src/store/db.ts';
import { applyEdit, applyRevoke, insertMessage, listUnprocessed, markProcessed, upsertReaction } from '../../src/store/messages.ts';
import { listPeople, setRole, upsertPerson } from '../../src/store/people.ts';
import { createTask, getTaskByCode, listDecisions, listTasks, setTaskStatus, updateTaskFields } from '../../src/store/tasks.ts';
import { manualClock } from '../../src/util/clock.ts';
import { silentLogger, type Logger } from '../../src/util/logger.ts';
import { FAKE_USAGE, FakeAi, op, type FakeResponse } from '../helpers/ai.ts';
import { LATER, NOW, seededDb } from '../helpers/db.ts';
import { SHARMA_PN } from '../helpers/wa.ts';

const P: Prices = { inputPerMTok: 4, outputPerMTok: 20, cacheWritePerMTok: 5, cacheReadPerMTok: 0.2 };
/** The output part of every estimate; the prompt part is far smaller. */
const OUTPUT_ESTIMATE = (MAX_OUTPUT_TOKENS * P.outputPerMTok) / 1_000_000;

function setup(responses: FakeResponse[], capUsd = 15, log: Logger = silentLogger()) {
  const db = seededDb();
  const clock = manualClock('2026-10-19T08:00:00Z');
  const spend = new SpendGuard({ db, clock, capUsd });
  const ai = new FakeAi(responses);
  const onChanged = vi.fn();
  const r = new Reconciler({ db, ai, spend, prices: P, clock, log, onChanged });
  return { db, spend, ai, onChanged, r };
}

function store(db: Db, waId: string, text: string, ts = '2026-10-19T07:00:00.000Z', clientId = 1): void {
  insertMessage(db, { waId, clientId, senderJid: SHARMA_PN, senderNumber: '919800000001', senderName: 'Mr. Sharma', fromMe: false, ts, text, quotedWaId: null, mediaType: null });
  upsertPerson(db, { clientId, jid: SHARMA_PN, number: '919800000001', name: 'Mr. Sharma', fromMe: false });
}

function banner(db: Db): void {
  createTask(db, { clientId: 1, side: 'us', title: 'Banner', category: 'design', priority: 'high', assignedTo: null, askedBy: null, raisedOn: '2026-10-10',
    deadline: null, latestProgress: null, sourceQuote: null, sourceDate: null, sourceWaId: null, origin: 'whatsapp' }, NOW);
}

/** The reservation the reconciler made for the call the fake AI saw. */
function estimateOf(ai: FakeAi): number {
  const c = ai.calls[0]!;
  return estimateCostUsd(c.system.length + c.user.length, P, MAX_OUTPUT_TOKENS);
}

/** Holds the fake AI call open until the returned function is called; run() has read its batch by then. */
function hold(ai: FakeAi): () => void {
  let open!: () => void;
  ai.gate = new Promise<void>((resolve) => { open = resolve; });
  return () => open();
}

function processedAt(db: Db, waId: string): string | null {
  return (db.prepare('SELECT processed_at AS p FROM messages WHERE wa_id = ?').get(waId) as { p: string | null }).p;
}

/** Every reservation was settled or released: the whole rest of the cap can be reserved (1e-9 absorbs float rounding). */
function expectNoReservation(spend: SpendGuard): void {
  expect(spend.reserve(spend.capUsd - spend.spentToday() - 1e-9)).not.toBeNull();
}

describe('Reconciler', () => {
  it('skips an inactive client without calling the AI', async () => {
    const { db, ai, r } = setup([]);
    store(db, 'A1', 'hello');
    db.prepare('UPDATE clients SET active = 0 WHERE id = 1').run();
    expect(await r.run(1)).toEqual({ status: 'noop' });
    expect(ai.calls).toHaveLength(0);
  });

  it('does nothing when there are no new messages', async () => {
    const { ai, r } = setup([]);
    expect(await r.run(1)).toEqual({ status: 'noop' });
    expect(ai.calls).toHaveLength(0);
  });

  it('applies accepted operations in one go and marks the batch processed', async () => {
    const { db, ai, r, onChanged, spend } = setup([{ ops: [
      op({ op: 'add_task', side: 'us', title: 'Revise homepage banner', category: 'design', priority: 'high', assignedTo: 'Rahul', deadline: '2026-10-18', sourceMessageIds: ['m1'] }),
      op({ op: 'add_decision', text: 'Blue theme chosen', sourceMessageIds: ['m2'] }),
      op({ op: 'set_status', text: 'Homepage banner is being revised.', sourceMessageIds: ['m1'] }),
      op({ op: 'set_person_role', personJid: SHARMA_PN, role: 'client', sourceMessageIds: ['m1'] }),
      op({ op: 'close_task', taskCode: 'SHA-404', sourceMessageIds: ['m1'] }),
    ] }]);
    store(db, 'm1', 'Rahul, homepage banner thoda bright karo. 18 tak chahiye.');
    store(db, 'm2', 'Blue theme final karte hain', '2026-10-19T07:30:00.000Z');

    expect(await r.run(1)).toEqual({ status: 'ok', accepted: 4, rejected: 1 });
    expect(listTasks(db, 1)[0]).toMatchObject({
      code: 'SHA-001', title: 'Revise homepage banner', side: 'us', assignedTo: 'Rahul', askedBy: 'Mr. Sharma', raisedOn: '2026-10-19',
      deadline: '2026-10-18', sourceQuote: 'Rahul, homepage banner thoda bright karo. 18 tak chahiye.', sourceWaId: 'm1', status: 'open',
    });
    expect(listDecisions(db, 1)[0]).toMatchObject({ text: 'Blue theme chosen', decidedOn: '2026-10-19', source: 'whatsapp' });
    expect(getClient(db, 1).statusText).toBe('Homepage banner is being revised.');
    expect(listPeople(db, 1)[0]).toMatchObject({ role: 'client', roleSetBy: 'ai' });
    expect(listUnprocessed(db, 1)).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM task_events').get()).toEqual({ n: 4 });
    expect(latestBatches(db)[0]).toMatchObject({ status: 'ok' });
    expect(spend.spentToday()).toBeCloseTo(0.01, 9);
    expectNoReservation(spend);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(ai.calls[0]!.user).toContain('[m1]');
  });

  it('updates, reminds about and closes existing tasks', async () => {
    const { db, r } = setup([{ ops: [
      op({ op: 'update_task', taskCode: 'SHA-001', latestProgress: 'v2 shared', sourceMessageIds: ['m3'] }),
      op({ op: 'log_reminder', taskCode: 'SHA-001', sourceMessageIds: ['m3'] }),
      op({ op: 'close_task', taskCode: 'SHA-001', sourceMessageIds: ['m4'] }),
    ] }]);
    banner(db);
    store(db, 'm3', 'Banner ka update?', '2026-10-18T05:00:00.000Z');
    store(db, 'm4', 'Perfect, approved 👍', '2026-10-18T19:00:00.000Z');
    await r.run(1);
    expect(getTaskByCode(db, 'SHA-001')).toMatchObject({ latestProgress: 'v2 shared', reminderCount: 1, lastReminderOn: '2026-10-18', status: 'done', closedOn: '2026-10-19' });
  });

  it('creates a task that is already done, closed on the date of its last source message', async () => {
    const { db, r } = setup([{ ops: [
      op({ op: 'add_task', side: 'client', title: 'Send logo files', category: 'content', priority: 'medium', status: 'done', sourceMessageIds: ['m1', 'm2'] }),
    ] }]);
    store(db, 'm1', 'Logo files bhej dijiye', '2026-10-17T05:00:00.000Z');
    store(db, 'm2', '[document]', '2026-10-18T05:00:00.000Z');
    expect(await r.run(1)).toEqual({ status: 'ok', accepted: 1, rejected: 0 });
    expect(getTaskByCode(db, 'SHA-001')).toMatchObject({ status: 'done', raisedOn: '2026-10-17', closedOn: '2026-10-18' });
    const ev = db.prepare('SELECT detail FROM task_events').get() as { detail: string };
    expect(JSON.parse(ev.detail)).toMatchObject({ code: 'SHA-001', status: 'done' });
  });

  it('reopens a maybe-done task', async () => {
    const { db, r } = setup([{ ops: [op({ op: 'reopen_task', taskCode: 'SHA-001', sourceMessageIds: ['m1'] })] }]);
    banner(db);
    setTaskStatus(db, getTaskByCode(db, 'SHA-001')!.id, 'maybe_done', '2026-10-18', NOW, 'ai');
    store(db, 'm1', 'abhi bhi dark hai');
    expect(await r.run(1)).toEqual({ status: 'ok', accepted: 1, rejected: 0 });
    expect(getTaskByCode(db, 'SHA-001')).toMatchObject({ status: 'open', closedOn: null });
  });

  it('closes a task on the processing date when the evidence is a new reaction to an old message', async () => {
    const { db, r } = setup([{ ops: [op({ op: 'close_task', taskCode: 'SHA-001', sourceMessageIds: ['m1'] })] }]);
    banner(db);
    store(db, 'm1', 'Banner v3 attached', '2026-10-12T05:00:00.000Z');
    markProcessed(db, listUnprocessed(db, 1).map((m) => m.id), '2026-10-12T06:00:00.000Z');
    upsertReaction(db, { clientId: 1, targetWaId: 'm1', reactorJid: SHARMA_PN, emoji: '✅', ts: '2026-10-19T07:55:00.000Z' });
    expect(listUnprocessed(db, 1)[0]).toMatchObject({ waId: 'm1', requeueReason: 'reaction' });

    expect(await r.run(1)).toEqual({ status: 'ok', accepted: 1, rejected: 0 });
    expect(getTaskByCode(db, 'SHA-001')).toMatchObject({ status: 'done', closedOn: '2026-10-19' });
  });

  it('logs how many operations the model got wrong, never their content', async () => {
    const log = silentLogger();
    const warn = vi.spyOn(log, 'warn');
    const { db, r } = setup([{ output: { ops: [] }, invalidOps: 2 }], 15, log);
    store(db, 'm1', 'hello');
    expect(await r.run(1)).toEqual({ status: 'ok', accepted: 0, rejected: 0 });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ clientId: 1, invalidOps: 2 }), 'model returned invalid operations');
    expect(warn.mock.calls[0]![0]).not.toHaveProperty('text');
  });

  it('applies nothing and keeps the messages queued when applying fails part-way', async () => {
    const { db, r, onChanged } = setup([{ ops: [
      op({ op: 'add_task', side: 'us', title: 'Revise banner', category: 'design', priority: 'high', sourceMessageIds: ['m1'] }),
      op({ op: 'add_decision', text: 'Blue theme chosen', sourceMessageIds: ['m1'] }),
    ] }]);
    store(db, 'm1', 'Banner bright karo, blue theme final');
    db.exec("CREATE TRIGGER fail_decisions BEFORE INSERT ON decisions BEGIN SELECT RAISE(ABORT, 'test failure'); END");

    expect(await r.run(1)).toEqual({ status: 'failed', errorCode: 'apply_failed' });
    expect(listTasks(db, 1)).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM task_events').get()).toEqual({ n: 0 });
    expect(listUnprocessed(db, 1)).toHaveLength(1);
    expect(latestBatches(db)[0]).toMatchObject({ status: 'failed', errorCode: 'apply_failed' });
    expect(onChanged).not.toHaveBeenCalled();
    banner(db);
    expect(listTasks(db, 1)[0]!.code).toBe('SHA-001'); // the task-code counter rolled back too
  });

  it('retries once on unparseable output, then fails and leaves messages queued', async () => {
    const { db, ai, r, spend } = setup([new AiInvalidOutputError('bad', null), new AiInvalidOutputError('bad', null)]);
    store(db, 'm1', 'hello');
    expect(await r.run(1)).toEqual({ status: 'failed', errorCode: 'invalid_output' });
    expect(ai.calls).toHaveLength(2);
    expect(listUnprocessed(db, 1)).toHaveLength(1);
    expect(latestBatches(db)[0]).toMatchObject({ status: 'failed', errorCode: 'invalid_output' });
    expect(spend.spentToday()).toBeCloseTo(2 * estimateOf(ai), 9); // no cost on the errors, so each attempt is booked at the estimate
    expectNoReservation(spend);
  });

  it('does not retry a refusal, and still records what it cost', async () => {
    const { db, ai, r, spend } = setup([new AiRefusalError('cyber', FAKE_USAGE, 0.02)]);
    store(db, 'm1', 'hello');
    expect(await r.run(1)).toEqual({ status: 'failed', errorCode: 'refusal' });
    expect(ai.calls).toHaveLength(1);
    expect(spend.spentToday()).toBeCloseTo(0.02, 9);
    expectNoReservation(spend);
  });

  it('pauses without calling the AI when the spend cap would be exceeded', async () => {
    const log = silentLogger();
    const info = vi.spyOn(log, 'info');
    const { db, ai, r } = setup([], 0.0001, log);
    store(db, 'm1', 'hello');
    expect(await r.run(1)).toEqual({ status: 'paused' });
    expect(ai.calls).toHaveLength(0);
    expect(listUnprocessed(db, 1)).toHaveLength(1);
    expect(info).toHaveBeenCalledWith({ clientId: 1 }, 'spend cap: run paused');
  });

  it("keeps other clients' chat out of the prompt", async () => {
    const { db, ai, r } = setup([]);
    store(db, 'm1', 'hello from Sharma');
    store(db, 'z1', 'Mehta private pricing', '2026-10-19T07:00:00.000Z', 2);
    await r.run(1);
    expect(ai.calls[0]!.user).toContain('hello from Sharma');
    expect(ai.calls[0]!.user).not.toContain('Mehta private pricing');
  });

  it('lets only one of two parallel runs reserve when the cap fits one estimate', async () => {
    const { db, ai, r } = setup([], OUTPUT_ESTIMATE * 1.5);
    const open = hold(ai);
    store(db, 'm1', 'hello from Sharma');
    store(db, 'z1', 'hello from Mehta', '2026-10-19T07:00:00.000Z', 2);

    const first = r.run(1);
    const second = r.run(2);
    expect(await second).toEqual({ status: 'paused' });
    open();
    expect(await first).toEqual({ status: 'ok', accepted: 0, rejected: 0 });
    expect(ai.calls).toHaveLength(1);
    expect(listUnprocessed(db, 2)).toHaveLength(1);
  });

  it('pauses when the retry no longer fits under the cap', async () => {
    const log = silentLogger();
    const info = vi.spyOn(log, 'info');
    const { db, ai, r } = setup([new AiInvalidOutputError('bad', FAKE_USAGE, 14.9)], 15, log);
    store(db, 'm1', 'hello');
    expect(await r.run(1)).toEqual({ status: 'paused' });
    expect(info).toHaveBeenCalledWith({ clientId: 1 }, 'spend cap: run paused');
    expect(ai.calls).toHaveLength(1);
    expect(latestBatches(db)[0]).toMatchObject({ status: 'failed', errorCode: 'spend_cap' });
    expect(listUnprocessed(db, 1)).toHaveLength(1);
  });

  it('books a timeout at the estimate for every SDK attempt', async () => {
    const { db, ai, r, spend } = setup([new Anthropic.APIConnectionTimeoutError()]);
    store(db, 'm1', 'hello');
    expect(await r.run(1)).toEqual({ status: 'failed', errorCode: 'timeout' });
    expect(spend.spentToday()).toBeCloseTo(estimateOf(ai) * (SDK_MAX_RETRIES + 1), 9);
    expectNoReservation(spend);
  });

  it('books a connection reset at the estimate for every SDK attempt', async () => {
    const reset = new Anthropic.APIConnectionError({ message: 'Connection error.', cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
    const { db, ai, r, spend } = setup([reset]);
    store(db, 'm1', 'hello');
    expect(await r.run(1)).toEqual({ status: 'failed', errorCode: 'network' });
    expect(spend.spentToday()).toBeCloseTo(estimateOf(ai) * 3, 9);
    expectNoReservation(spend);
  });

  it('books nothing when the request never left the machine', async () => {
    const dns = new Anthropic.APIConnectionError({ message: 'Connection error.', cause: new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }) });
    const { db, r, spend } = setup([dns]);
    store(db, 'm1', 'hello');
    expect(await r.run(1)).toEqual({ status: 'failed', errorCode: 'network' });
    expect(spend.spentToday()).toBe(0);
    expectNoReservation(spend);
  });

  it('books nothing when the server answers with an error status', async () => {
    const { db, r, spend } = setup([new Anthropic.APIError(500, undefined, 'server error', new Headers())]);
    store(db, 'm1', 'hello');
    expect(await r.run(1)).toEqual({ status: 'failed', errorCode: 'api_500' });
    expect(spend.spentToday()).toBe(0);
    expectNoReservation(spend);
  });

  it('marks a fallback answer in the spend record', async () => {
    const { db, r, spend } = setup([{ output: { ops: [] }, costUsd: 0.05, fallbackUsed: true }]);
    store(db, 'm1', 'hello');
    await r.run(1);
    const rows = db.prepare('SELECT usd, detail FROM spend').all() as { usd: number; detail: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.usd).toBeCloseTo(0.05, 9);
    expect(rows[0]!.detail).toMatch(/\(fallback\)$/);
    expectNoReservation(spend);
  });

  it('books an unexpected error at the estimate', async () => {
    const { db, ai, r, spend } = setup([new Error('boom')]);
    store(db, 'm1', 'hello');
    expect(await r.run(1)).toEqual({ status: 'failed', errorCode: 'unknown' });
    expect(spend.spentToday()).toBeCloseTo(estimateOf(ai), 9);
    const row = db.prepare('SELECT detail FROM spend').get() as { detail: string };
    expect(row.detail).toMatch(/\(unknown, estimated\)$/);
    expectNoReservation(spend);
  });

  it('uses the processing date when any source is a re-checked message', async () => {
    const { db, r } = setup([{ ops: [op({ op: 'close_task', taskCode: 'SHA-001', sourceMessageIds: ['m1', 'm2'] })] }]);
    banner(db);
    store(db, 'm1', 'Banner v3 attached', '2026-10-12T05:00:00.000Z');
    markProcessed(db, listUnprocessed(db, 1).map((m) => m.id), '2026-10-12T06:00:00.000Z');
    upsertReaction(db, { clientId: 1, targetWaId: 'm1', reactorJid: SHARMA_PN, emoji: '✅', ts: '2026-10-19T07:55:00.000Z' });
    store(db, 'm2', 'Thanks team', '2026-10-18T05:00:00.000Z'); // the latest source is a fresh message from yesterday
    expect(await r.run(1)).toEqual({ status: 'ok', accepted: 1, rejected: 0 });
    expect(getTaskByCode(db, 'SHA-001')).toMatchObject({ status: 'done', closedOn: '2026-10-19' });
  });

  it('cuts the source quote by characters, never inside an emoji', async () => {
    const { db, r } = setup([{ ops: [op({ op: 'add_task', side: 'us', title: 'Banner', category: 'design', priority: 'low', sourceMessageIds: ['m1'] })] }]);
    store(db, 'm1', '👍'.repeat(130));
    await r.run(1);
    expect(getTaskByCode(db, 'SHA-001')!.sourceQuote).toBe('👍'.repeat(120));
  });

  describe('changes that land while the AI call is in flight', () => {
    it('keeps a field a human locked during the call', async () => {
      const { db, ai, r } = setup([{ ops: [op({ op: 'update_task', taskCode: 'SHA-001', title: 'AI title', sourceMessageIds: ['m1'] })] }]);
      banner(db);
      store(db, 'm1', 'Banner ka naam badlo');
      const open = hold(ai);
      const run = r.run(1);
      updateTaskFields(db, getTaskByCode(db, 'SHA-001')!.id, { title: 'Human title' }, LATER, 'human');
      open();
      expect(await run).toEqual({ status: 'ok', accepted: 0, rejected: 1 });
      expect(getTaskByCode(db, 'SHA-001')).toMatchObject({ title: 'Human title', lockedFields: ['title'] });
    });

    it('keeps a role a human set during the call', async () => {
      const { db, ai, r } = setup([{ ops: [op({ op: 'set_person_role', personJid: SHARMA_PN, role: 'team', sourceMessageIds: ['m1'] })] }]);
      store(db, 'm1', 'hello');
      const open = hold(ai);
      const run = r.run(1);
      setRole(db, 1, SHARMA_PN, 'client', 'human');
      open();
      expect(await run).toEqual({ status: 'ok', accepted: 0, rejected: 1 });
      expect(listPeople(db, 1)[0]).toMatchObject({ role: 'client', roleSetBy: 'human' });
    });

    it('queues a message edited during the call again, marked as an edit', async () => {
      const log = silentLogger();
      const info = vi.spyOn(log, 'info');
      const { db, ai, r } = setup([], 15, log);
      store(db, 'm1', 'Banner bright karo');
      store(db, 'm2', 'Aur logo bhi', '2026-10-19T07:01:00.000Z');
      const open = hold(ai);
      const run = r.run(1);
      applyEdit(db, 1, 'm1', 'Banner dark karo', '2026-10-19T08:00:30.000Z');
      open();
      expect(await run).toEqual({ status: 'ok', accepted: 0, rejected: 0 });
      expect(listUnprocessed(db, 1)).toEqual([expect.objectContaining({ waId: 'm1', requeueReason: 'edit' })]);
      expect(processedAt(db, 'm2')).not.toBeNull();
      expect(info).toHaveBeenCalledWith(expect.objectContaining({ clientId: 1, requeued: 1 }), 'messages changed during the AI call; queued again');
    });

    it('queues a message that got a reaction during the call again, marked as a reaction', async () => {
      const { db, ai, r } = setup([]);
      store(db, 'm1', 'Banner v3 attached');
      store(db, 'm2', 'Logo bhi bhej diya', '2026-10-19T07:01:00.000Z');
      const open = hold(ai);
      const run = r.run(1);
      upsertReaction(db, { clientId: 1, targetWaId: 'm1', reactorJid: SHARMA_PN, emoji: '✅', ts: '2026-10-19T08:00:30.000Z' });
      open();
      expect(await run).toEqual({ status: 'ok', accepted: 0, rejected: 0 });
      expect(listUnprocessed(db, 1)).toEqual([expect.objectContaining({ waId: 'm1', requeueReason: 'reaction' })]);
      expect(processedAt(db, 'm2')).not.toBeNull();
    });

    it('processes a message edited before the run normally, with no re-check marker left', async () => {
      const { db, r } = setup([]);
      store(db, 'm1', 'Banner bright karo');
      applyEdit(db, 1, 'm1', 'Banner dark karo', '2026-10-19T07:05:00.000Z');
      expect(await r.run(1)).toEqual({ status: 'ok', accepted: 0, rejected: 0 });
      expect(listUnprocessed(db, 1)).toHaveLength(0);
      expect(db.prepare("SELECT touch_reason AS touch, requeue_reason AS requeue FROM messages WHERE wa_id = 'm1'").get()).toEqual({ touch: null, requeue: null });
    });

    it('flags a new task whose source message was deleted during the call', async () => {
      const { db, ai, r } = setup([{ ops: [op({ op: 'add_task', side: 'us', title: 'Revise banner', category: 'design', priority: 'high', sourceMessageIds: ['m1'] })] }]);
      store(db, 'm1', 'Banner bright karo');
      const open = hold(ai);
      const run = r.run(1);
      applyRevoke(db, 1, 'm1');
      open();
      expect(await run).toEqual({ status: 'ok', accepted: 1, rejected: 0 });
      expect(getTaskByCode(db, 'SHA-001')).toMatchObject({ sourceWaId: 'm1', sourceRevoked: true });
    });
  });

  it('does not re-create a task a human closed when the message is reprocessed', async () => {
    const add = op({ op: 'add_task', side: 'us', title: 'Banner', category: 'design', priority: 'high', sourceMessageIds: ['m1'] });
    const { db, r } = setup([{ ops: [add] }, { ops: [add] }]);
    store(db, 'm1', 'banner chahiye');
    expect(await r.run(1)).toMatchObject({ status: 'ok', accepted: 1 });
    closeTask(db, 'SHA-001', new Date('2026-10-19T08:30:00Z'));
    expect(requestReprocess(db, 'SHA', '2026-10-19', new Date('2026-10-19T08:31:00Z'), undefined)).toBe(1);
    expect(await r.run(1)).toMatchObject({ status: 'ok', accepted: 0, rejected: 1 });
    expect(getTaskByCode(db, 'SHA-002')).toBeUndefined();
    expect(getTaskByCode(db, 'SHA-001')?.status).toBe('done');
  });
});
