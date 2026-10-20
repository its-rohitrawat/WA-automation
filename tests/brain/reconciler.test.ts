import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { AiInvalidOutputError, AiRefusalError, MAX_OUTPUT_TOKENS, SDK_MAX_RETRIES } from '../../src/brain/claudeClient.ts';
import { Reconciler } from '../../src/brain/reconciler.ts';
import { estimateCostUsd, type Prices } from '../../src/spend/pricing.ts';
import { SpendGuard } from '../../src/spend/spendGuard.ts';
import { latestBatches } from '../../src/store/batches.ts';
import { getClient } from '../../src/store/clients.ts';
import type { Db } from '../../src/store/db.ts';
import { insertMessage, listUnprocessed, markProcessed, upsertReaction } from '../../src/store/messages.ts';
import { listPeople, upsertPerson } from '../../src/store/people.ts';
import { createTask, getTaskByCode, listDecisions, listTasks, setTaskStatus } from '../../src/store/tasks.ts';
import { manualClock } from '../../src/util/clock.ts';
import { silentLogger, type Logger } from '../../src/util/logger.ts';
import { FAKE_USAGE, FakeAi, op, type FakeResponse } from '../helpers/ai.ts';
import { NOW, seededDb } from '../helpers/db.ts';
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

/** Every reservation was settled or released: the whole rest of the cap can be reserved (1e-9 absorbs float rounding). */
function expectNoReservation(spend: SpendGuard): void {
  expect(spend.reserve(spend.capUsd - spend.spentToday() - 1e-9)).not.toBeNull();
}

describe('Reconciler', () => {
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
    const { db, ai, r } = setup([], 0.0001);
    store(db, 'm1', 'hello');
    expect(await r.run(1)).toEqual({ status: 'paused' });
    expect(ai.calls).toHaveLength(0);
    expect(listUnprocessed(db, 1)).toHaveLength(1);
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
    let open!: () => void;
    ai.gate = new Promise<void>((resolve) => { open = resolve; });
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
    const { db, ai, r } = setup([new AiInvalidOutputError('bad', FAKE_USAGE, 14.9)]);
    store(db, 'm1', 'hello');
    expect(await r.run(1)).toEqual({ status: 'paused' });
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
});
