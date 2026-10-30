import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { AiInvalidOutputError, AiRefusalError, MAX_OUTPUT_TOKENS, SDK_MAX_RETRIES } from '../../src/brain/claudeClient.ts';
import { Reconciler } from '../../src/brain/reconciler.ts';
import { closeTask, reopenTask, requestReprocess } from '../../src/cli/corrections.ts';
import { estimateCostUsd, type Prices } from '../../src/spend/pricing.ts';
import { SpendGuard } from '../../src/spend/spendGuard.ts';
import { latestBatches } from '../../src/store/batches.ts';
import { getClient } from '../../src/store/clients.ts';
import type { Db } from '../../src/store/db.ts';
import { finishMedia, insertMedia, messageRowId } from '../../src/store/media.ts';
import { applyEdit, applyRevoke, insertMessage, listUnprocessed, markProcessed, upsertReaction } from '../../src/store/messages.ts';
import { listPeople, setRole, upsertPerson } from '../../src/store/people.ts';
import { createTask, getTaskByCode, listDecisions, listTasks, logReminder, setTaskStatus, updateTaskFields } from '../../src/store/tasks.ts';
import { manualClock } from '../../src/util/clock.ts';
import { silentLogger, type Logger } from '../../src/util/logger.ts';
import { FAKE_USAGE, FakeAi, op, type FakeResponse } from '../helpers/ai.ts';
import { LATER, NOW, seededDb } from '../helpers/db.ts';
import { SHARMA_PN } from '../helpers/wa.ts';

const P: Prices = { inputPerMTok: 4, outputPerMTok: 20, cacheWritePerMTok: 5, cacheReadPerMTok: 0.2 };
/** The output part of every estimate; the prompt part is far smaller. */
const OUTPUT_ESTIMATE = (MAX_OUTPUT_TOKENS * P.outputPerMTok) / 1_000_000;

async function setup(responses: FakeResponse[], capUsd = 15, log: Logger = silentLogger()) {
  const db = await seededDb();
  const clock = manualClock('2026-10-19T08:00:00Z');
  const spend = new SpendGuard({ db, clock, capUsd });
  const ai = new FakeAi(responses);
  const onChanged = vi.fn();
  const r = new Reconciler({ db, ai, spend, prices: P, clock, log, onChanged });
  return { db, spend, ai, onChanged, r };
}

async function store(db: Db, waId: string, text: string | null, ts = '2026-10-19T07:00:00.000Z', clientId = 1, mediaType: string | null = null): Promise<void> {
  await insertMessage(db, { waId, clientId, senderJid: SHARMA_PN, senderNumber: '919800000001', senderName: 'Mr. Sharma', fromMe: false, ts, text, quotedWaId: null, mediaType });
  await upsertPerson(db, { clientId, jid: SHARMA_PN, number: '919800000001', name: 'Mr. Sharma', fromMe: false });
}

async function banner(db: Db): Promise<void> {
  await createTask(db, { clientId: 1, side: 'us', title: 'Banner', category: 'design', priority: 'major', assignedTo: null, askedBy: null, raisedOn: '2026-10-10',
    deadline: null, latestProgress: null, sourceQuote: null, sourceDate: null, sourceWaId: null, origin: 'whatsapp' }, NOW);
}

/** The reservation the reconciler made for the call the fake AI saw. */
function estimateOf(ai: FakeAi): number {
  const c = ai.calls[0]!;
  return estimateCostUsd(c.system.length + c.user.length, P, MAX_OUTPUT_TOKENS);
}

/** Holds the fake AI call open until the returned function is called; run() has read its batch by then. */
/** Holds the next AI call until the returned function is called. started() resolves once that call is in flight. */
function hold(ai: FakeAi): (() => void) & { started: () => Promise<void> } {
  let open!: () => void;
  const before = ai.calls.length;
  ai.gate = new Promise<void>((resolve) => { open = resolve; });
  return Object.assign(() => open(), { started: () => vi.waitFor(() => expect(ai.calls.length).toBeGreaterThan(before)) });
}

function processedAt(db: Db, waId: string): string | null {
  return (db.raw.prepare('SELECT processed_at AS p FROM messages WHERE wa_id = ?').get(waId) as { p: string | null }).p;
}

/** Every reservation was settled or released: the whole rest of the cap can be reserved (1e-9 absorbs float rounding). */
function expectNoReservation(spend: SpendGuard): void {
  expect(spend.reserve(spend.capUsd - spend.spentToday() - 1e-9)).not.toBeNull();
}

describe('Reconciler', () => {
  it('skips an inactive client without calling the AI', async () => {
    const { db, ai, r } = await setup([]);
    await store(db, 'A1', 'hello');
    db.raw.prepare('UPDATE clients SET active = 0 WHERE id = 1').run();
    expect(await r.run(1)).toEqual({ status: 'noop' });
    expect(ai.calls).toHaveLength(0);
  });

  it('does nothing when there are no new messages', async () => {
    const { ai, r } = await setup([]);
    expect(await r.run(1)).toEqual({ status: 'noop' });
    expect(ai.calls).toHaveLength(0);
  });

  it('applies accepted operations in one go and marks the batch processed', async () => {
    const { db, ai, r, onChanged, spend } = await setup([{ ops: [
      op({ op: 'add_task', side: 'us', title: 'Revise homepage banner', category: 'design', priority: 'major', assignedTo: 'Rahul', deadline: '2026-10-18', sourceMessageIds: ['m1'] }),
      op({ op: 'add_decision', text: 'Blue theme chosen', sourceMessageIds: ['m2'] }),
      op({ op: 'set_status', text: 'Homepage banner is being revised.', sourceMessageIds: ['m1'] }),
      op({ op: 'set_person_role', personJid: SHARMA_PN, role: 'client', sourceMessageIds: ['m1'] }),
      op({ op: 'close_task', taskCode: 'SHA-404', sourceMessageIds: ['m1'] }),
    ] }]);
    await store(db, 'm1', 'Rahul, homepage banner thoda bright karo. 18 tak chahiye.');
    await store(db, 'm2', 'Blue theme final karte hain', '2026-10-19T07:30:00.000Z');

    expect(await r.run(1)).toEqual({ status: 'ok', accepted: 4, rejected: 1 });
    expect((await listTasks(db, 1))[0]).toMatchObject({
      code: 'SHA-001', title: 'Revise homepage banner', side: 'us', assignedTo: 'Rahul', askedBy: 'Mr. Sharma', raisedOn: '2026-10-19',
      deadline: '2026-10-18', sourceQuote: 'Rahul, homepage banner thoda bright karo. 18 tak chahiye.', sourceWaId: 'm1', status: 'open',
    });
    expect((await listDecisions(db, 1))[0]).toMatchObject({ text: 'Blue theme chosen', decidedOn: '2026-10-19', source: 'whatsapp' });
    expect(getClient(db, 1).statusText).toBe('Homepage banner is being revised.');
    expect((await listPeople(db, 1))[0]).toMatchObject({ role: 'client', roleSetBy: 'ai' });
    expect(await listUnprocessed(db, 1)).toHaveLength(0);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM task_events').get()).toEqual({ n: 4 });
    expect((await latestBatches(db))[0]).toMatchObject({ status: 'ok' });
    expect(spend.spentToday()).toBeCloseTo(0.01, 9);
    expectNoReservation(spend);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(ai.calls[0]!.user).toContain('[m1]');
  });

  it('updates, reminds about and closes existing tasks', async () => {
    const { db, r } = await setup([{ ops: [
      op({ op: 'update_task', taskCode: 'SHA-001', latestProgress: 'v2 shared', sourceMessageIds: ['m3'] }),
      op({ op: 'log_reminder', taskCode: 'SHA-001', sourceMessageIds: ['m3'] }),
      op({ op: 'close_task', taskCode: 'SHA-001', sourceMessageIds: ['m4'] }),
    ] }]);
    await banner(db);
    await store(db, 'm3', 'Banner ka update?', '2026-10-18T05:00:00.000Z');
    await store(db, 'm4', 'Perfect, approved 👍', '2026-10-18T19:00:00.000Z');
    await r.run(1);
    expect(await getTaskByCode(db, 'SHA-001')).toMatchObject({ latestProgress: 'v2 shared', reminderCount: 1, lastReminderOn: '2026-10-18', status: 'done', closedOn: '2026-10-19' });
  });

  it('creates a task that is already done, closed on the date of its last source message', async () => {
    const { db, ai, r } = await setup([{ ops: [
      op({ op: 'add_task', side: 'client', title: 'Send logo files', category: 'content', priority: 'medium', status: 'done', sourceMessageIds: ['m1', 'm2'] }),
    ] }]);
    await store(db, 'm1', 'Logo files bhej dijiye', '2026-10-17T05:00:00.000Z');
    await store(db, 'm2', null, '2026-10-18T05:00:00.000Z', 1, 'document');
    expect(await r.run(1)).toEqual({ status: 'ok', accepted: 1, rejected: 0 });
    expect(ai.calls[0]!.user).toMatch(/^\[m2\] .*\]: \{document\}$/m);
    expect(await getTaskByCode(db, 'SHA-001')).toMatchObject({ status: 'done', raisedOn: '2026-10-17', closedOn: '2026-10-18' });
    const ev = db.raw.prepare('SELECT detail FROM task_events').get() as { detail: string };
    expect(JSON.parse(ev.detail)).toMatchObject({ code: 'SHA-001', status: 'done' });
  });

  it('reopens a maybe-done task', async () => {
    const { db, r } = await setup([{ ops: [op({ op: 'reopen_task', taskCode: 'SHA-001', sourceMessageIds: ['m1'] })] }]);
    await banner(db);
    await setTaskStatus(db, (await getTaskByCode(db, 'SHA-001'))!.id, 'maybe_done', '2026-10-18', NOW, 'ai');
    await store(db, 'm1', 'abhi bhi dark hai');
    expect(await r.run(1)).toEqual({ status: 'ok', accepted: 1, rejected: 0 });
    expect(await getTaskByCode(db, 'SHA-001')).toMatchObject({ status: 'open', closedOn: null });
  });

  it('closes a task on the processing date when the evidence is a new reaction to an old message', async () => {
    const { db, r } = await setup([{ ops: [op({ op: 'close_task', taskCode: 'SHA-001', sourceMessageIds: ['m1'] })] }]);
    await banner(db);
    await store(db, 'm1', 'Banner v3 attached', '2026-10-12T05:00:00.000Z');
    await markProcessed(db, (await listUnprocessed(db, 1)).map((m) => m.id), '2026-10-12T06:00:00.000Z');
    await upsertReaction(db, { clientId: 1, targetWaId: 'm1', reactorJid: SHARMA_PN, emoji: '✅', ts: '2026-10-19T07:55:00.000Z' });
    expect((await listUnprocessed(db, 1))[0]).toMatchObject({ waId: 'm1', requeueReason: 'reaction' });

    expect(await r.run(1)).toEqual({ status: 'ok', accepted: 1, rejected: 0 });
    expect(await getTaskByCode(db, 'SHA-001')).toMatchObject({ status: 'done', closedOn: '2026-10-19' });
  });

  it('logs how many operations the model got wrong, never their content', async () => {
    const log = silentLogger();
    const warn = vi.spyOn(log, 'warn');
    const { db, r } = await setup([{ output: { ops: [] }, invalidOps: 2 }], 15, log);
    await store(db, 'm1', 'hello');
    expect(await r.run(1)).toEqual({ status: 'ok', accepted: 0, rejected: 0 });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ clientId: 1, invalidOps: 2 }), 'model returned invalid operations');
    expect(warn.mock.calls[0]![0]).not.toHaveProperty('text');
  });

  it('applies nothing and keeps the messages queued when applying fails part-way', async () => {
    const { db, r, onChanged } = await setup([{ ops: [
      op({ op: 'add_task', side: 'us', title: 'Revise banner', category: 'design', priority: 'major', sourceMessageIds: ['m1'] }),
      op({ op: 'add_decision', text: 'Blue theme chosen', sourceMessageIds: ['m1'] }),
    ] }]);
    await store(db, 'm1', 'Banner bright karo, blue theme final');
    db.raw.exec("CREATE TRIGGER fail_decisions BEFORE INSERT ON decisions BEGIN SELECT RAISE(ABORT, 'test failure'); END");

    expect(await r.run(1)).toEqual({ status: 'failed', errorCode: 'apply_failed' });
    expect(await listTasks(db, 1)).toHaveLength(0);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM task_events').get()).toEqual({ n: 0 });
    expect(await listUnprocessed(db, 1)).toHaveLength(1);
    expect((await latestBatches(db))[0]).toMatchObject({ status: 'failed', errorCode: 'apply_failed' });
    expect(onChanged).not.toHaveBeenCalled();
    await banner(db);
    expect((await listTasks(db, 1))[0]!.code).toBe('SHA-001'); // the task-code counter rolled back too
  });

  it('retries once on unparseable output, then fails and leaves messages queued', async () => {
    const { db, ai, r, spend } = await setup([new AiInvalidOutputError('bad', null), new AiInvalidOutputError('bad', null)]);
    await store(db, 'm1', 'hello');
    expect(await r.run(1)).toEqual({ status: 'failed', errorCode: 'invalid_output' });
    expect(ai.calls).toHaveLength(2);
    expect(await listUnprocessed(db, 1)).toHaveLength(1);
    expect((await latestBatches(db))[0]).toMatchObject({ status: 'failed', errorCode: 'invalid_output' });
    expect(spend.spentToday()).toBeCloseTo(2 * estimateOf(ai), 9); // no cost on the errors, so each attempt is booked at the estimate
    expectNoReservation(spend);
  });

  it('does not retry a refusal, and still records what it cost', async () => {
    const { db, ai, r, spend } = await setup([new AiRefusalError('cyber', FAKE_USAGE, 0.02)]);
    await store(db, 'm1', 'hello');
    expect(await r.run(1)).toEqual({ status: 'failed', errorCode: 'refusal' });
    expect(ai.calls).toHaveLength(1);
    expect(spend.spentToday()).toBeCloseTo(0.02, 9);
    expectNoReservation(spend);
  });

  it('pauses without calling the AI when the spend cap would be exceeded', async () => {
    const log = silentLogger();
    const info = vi.spyOn(log, 'info');
    const { db, ai, r } = await setup([], 0.0001, log);
    await store(db, 'm1', 'hello');
    expect(await r.run(1)).toEqual({ status: 'paused' });
    expect(ai.calls).toHaveLength(0);
    expect(await listUnprocessed(db, 1)).toHaveLength(1);
    expect(info).toHaveBeenCalledWith({ clientId: 1 }, 'spend cap: run paused');
  });

  it("keeps other clients' chat out of the prompt", async () => {
    const { db, ai, r } = await setup([]);
    await store(db, 'm1', 'hello from Sharma');
    await store(db, 'z1', 'Mehta private pricing', '2026-10-19T07:00:00.000Z', 2);
    await r.run(1);
    expect(ai.calls[0]!.user).toContain('hello from Sharma');
    expect(ai.calls[0]!.user).not.toContain('Mehta private pricing');
  });

  it('lets only one of two parallel runs reserve when the cap fits one estimate', async () => {
    const { db, ai, r } = await setup([], OUTPUT_ESTIMATE * 1.5);
    const open = hold(ai);
    await store(db, 'm1', 'hello from Sharma');
    await store(db, 'z1', 'hello from Mehta', '2026-10-19T07:00:00.000Z', 2);

    const first = r.run(1);
    await open.started(); // the first run holds its reservation during its AI call
    const second = r.run(2);
    // Only the first run's hold keeps the second out, not the cap itself: busy, not paused (Task 15 review round 3).
    expect(await second).toEqual({ status: 'busy' });
    open();
    expect(await first).toEqual({ status: 'ok', accepted: 0, rejected: 0 });
    expect(ai.calls).toHaveLength(1);
    expect(await listUnprocessed(db, 2)).toHaveLength(1);
  });

  describe('another paid call holding the budget (Task 15 review round 3)', () => {
    it('is busy, not paused, when only a hold of a call in flight keeps it out', async () => {
      const log = silentLogger();
      const info = vi.spyOn(log, 'info');
      const { db, ai, r, spend } = await setup([], 15, log);
      spend.record('ai', 10, 'earlier runs');
      const scan = spend.reserve(4.9)!; // a scanned PDF being read
      await store(db, 'm1', 'hello');
      expect(await r.run(1)).toEqual({ status: 'busy' });
      expect(ai.calls).toHaveLength(0);
      expect(await latestBatches(db)).toEqual([]);
      expect(await listUnprocessed(db, 1)).toHaveLength(1);
      expect(info).toHaveBeenCalledWith({ clientId: 1 }, 'other paid calls in flight: run deferred');
      expect(info).not.toHaveBeenCalledWith({ clientId: 1 }, 'spend cap: run paused');
      spend.release(scan);
      expect(await r.run(1)).toEqual({ status: 'ok', accepted: 0, rejected: 0 });
    });

    it('is paused when what is spent today leaves no room for it, hold or not', async () => {
      const { db, ai, r, spend } = await setup([], 15);
      spend.record('ai', 14.8, 'earlier runs');
      spend.reserve(0.1);
      await store(db, 'm1', 'hello');
      expect(await r.run(1)).toEqual({ status: 'paused' });
      expect(ai.calls).toHaveLength(0);
    });

    it('a retry kept out only by a hold is busy, and its batch says so', async () => {
      const log = silentLogger();
      const info = vi.spyOn(log, 'info');
      // The invalid first answer costs about what it reserved, so the retry needs a fresh reservation.
      const { db, ai, r, spend } = await setup([new AiInvalidOutputError('bad', FAKE_USAGE, OUTPUT_ESTIMATE)], 5, log);
      await store(db, 'm1', 'hello');
      const open = hold(ai);
      const run = r.run(1);
      await open.started();
      expect(ai.calls).toHaveLength(1);
      // A scanned PDF read starts during the call. It fits next to this call's hold, but not next to the retry's.
      expect(spend.reserve(5 - estimateOf(ai) - OUTPUT_ESTIMATE / 2)).not.toBeNull();
      open();
      expect(await run).toEqual({ status: 'busy' });
      expect(spend.isPaused()).toBe(false);
      expect(ai.calls).toHaveLength(1);
      expect((await latestBatches(db))[0]).toMatchObject({ status: 'failed', errorCode: 'spend_busy' });
      expect(await listUnprocessed(db, 1)).toHaveLength(1);
      expect(info).toHaveBeenCalledWith({ clientId: 1 }, 'other paid calls in flight: run deferred');
    });
  });

  it('pauses when the retry no longer fits under the cap', async () => {
    const log = silentLogger();
    const info = vi.spyOn(log, 'info');
    const { db, ai, r } = await setup([new AiInvalidOutputError('bad', FAKE_USAGE, 14.9)], 15, log);
    await store(db, 'm1', 'hello');
    expect(await r.run(1)).toEqual({ status: 'paused' });
    expect(info).toHaveBeenCalledWith({ clientId: 1 }, 'spend cap: run paused');
    expect(ai.calls).toHaveLength(1);
    expect((await latestBatches(db))[0]).toMatchObject({ status: 'failed', errorCode: 'spend_cap' });
    expect(await listUnprocessed(db, 1)).toHaveLength(1);
  });

  it('books a timeout at the estimate for every SDK attempt', async () => {
    const { db, ai, r, spend } = await setup([new Anthropic.APIConnectionTimeoutError()]);
    await store(db, 'm1', 'hello');
    expect(await r.run(1)).toEqual({ status: 'failed', errorCode: 'timeout' });
    expect(spend.spentToday()).toBeCloseTo(estimateOf(ai) * (SDK_MAX_RETRIES + 1), 9);
    expectNoReservation(spend);
  });

  it('books a connection reset at the estimate for every SDK attempt', async () => {
    const reset = new Anthropic.APIConnectionError({ message: 'Connection error.', cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
    const { db, ai, r, spend } = await setup([reset]);
    await store(db, 'm1', 'hello');
    expect(await r.run(1)).toEqual({ status: 'failed', errorCode: 'network' });
    expect(spend.spentToday()).toBeCloseTo(estimateOf(ai) * 3, 9);
    expectNoReservation(spend);
  });

  it('books nothing when the request never left the machine', async () => {
    const dns = new Anthropic.APIConnectionError({ message: 'Connection error.', cause: new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }) });
    const { db, r, spend } = await setup([dns]);
    await store(db, 'm1', 'hello');
    expect(await r.run(1)).toEqual({ status: 'failed', errorCode: 'network' });
    expect(spend.spentToday()).toBe(0);
    expectNoReservation(spend);
  });

  it('books nothing when the server answers with an error status', async () => {
    const { db, r, spend } = await setup([new Anthropic.APIError(500, undefined, 'server error', new Headers())]);
    await store(db, 'm1', 'hello');
    expect(await r.run(1)).toEqual({ status: 'failed', errorCode: 'api_500' });
    expect(spend.spentToday()).toBe(0);
    expectNoReservation(spend);
  });

  it('marks a fallback answer in the spend record', async () => {
    const { db, r, spend } = await setup([{ output: { ops: [] }, costUsd: 0.05, fallbackUsed: true }]);
    await store(db, 'm1', 'hello');
    await r.run(1);
    const rows = db.raw.prepare('SELECT usd, detail FROM spend').all() as { usd: number; detail: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.usd).toBeCloseTo(0.05, 9);
    expect(rows[0]!.detail).toMatch(/\(fallback\)$/);
    expectNoReservation(spend);
  });

  it('books an unexpected error at the estimate', async () => {
    const { db, ai, r, spend } = await setup([new Error('boom')]);
    await store(db, 'm1', 'hello');
    expect(await r.run(1)).toEqual({ status: 'failed', errorCode: 'unknown' });
    expect(spend.spentToday()).toBeCloseTo(estimateOf(ai), 9);
    const row = db.raw.prepare('SELECT detail FROM spend').get() as { detail: string };
    expect(row.detail).toMatch(/^batch \d+ \(unknown, estimated\)$/);
    expectNoReservation(spend);
  });

  it('uses the processing date when any source is a re-checked message', async () => {
    const { db, r } = await setup([{ ops: [op({ op: 'close_task', taskCode: 'SHA-001', sourceMessageIds: ['m1', 'm2'] })] }]);
    await banner(db);
    await store(db, 'm1', 'Banner v3 attached', '2026-10-12T05:00:00.000Z');
    await markProcessed(db, (await listUnprocessed(db, 1)).map((m) => m.id), '2026-10-12T06:00:00.000Z');
    await upsertReaction(db, { clientId: 1, targetWaId: 'm1', reactorJid: SHARMA_PN, emoji: '✅', ts: '2026-10-19T07:55:00.000Z' });
    await store(db, 'm2', 'Thanks team', '2026-10-18T05:00:00.000Z'); // the latest source is a fresh message from yesterday
    expect(await r.run(1)).toEqual({ status: 'ok', accepted: 1, rejected: 0 });
    expect(await getTaskByCode(db, 'SHA-001')).toMatchObject({ status: 'done', closedOn: '2026-10-19' });
  });

  describe('human status lock and re-checked evidence', () => {
    const close = () => op({ op: 'close_task', taskCode: 'SHA-001', sourceMessageIds: ['m1'] });
    /** SHA-001 reopened by a human at 06:00Z; m1 is an old delivery message (sent before that) that was already processed. */
    async function reopenedWithOldDelivery(db: Db): Promise<void> {
      await banner(db);
      await store(db, 'm1', 'Banner v3 attached', '2026-10-12T05:00:00.000Z');
      await markProcessed(db, (await listUnprocessed(db, 1)).map((m) => m.id), '2026-10-12T06:00:00.000Z');
      await closeTask(db, 'SHA-001', new Date('2026-10-19T05:00:00Z'));
      await reopenTask(db, 'SHA-001', new Date('2026-10-19T06:00:00Z'));
    }

    it('accepts a close backed by a ✅ reaction made after the human reopened the task', async () => {
      const { db, r } = await setup([{ ops: [close()] }]);
      await reopenedWithOldDelivery(db);
      await upsertReaction(db, { clientId: 1, targetWaId: 'm1', reactorJid: SHARMA_PN, emoji: '✅', ts: '2026-10-19T07:00:00.000Z' });
      expect(await r.run(1)).toEqual({ status: 'ok', accepted: 1, rejected: 0 });
      expect(await getTaskByCode(db, 'SHA-001')).toMatchObject({ status: 'done' });
    });

    it('still rejects a close backed by a reaction made before the human reopened the task', async () => {
      const { db, r } = await setup([{ ops: [close()] }]);
      await banner(db);
      await store(db, 'm1', 'Banner v3 attached', '2026-10-12T05:00:00.000Z');
      await markProcessed(db, (await listUnprocessed(db, 1)).map((m) => m.id), '2026-10-12T06:00:00.000Z');
      await upsertReaction(db, { clientId: 1, targetWaId: 'm1', reactorJid: SHARMA_PN, emoji: '✅', ts: '2026-10-19T04:00:00.000Z' });
      await closeTask(db, 'SHA-001', new Date('2026-10-19T05:00:00Z'));
      await reopenTask(db, 'SHA-001', new Date('2026-10-19T06:00:00Z'));
      expect(await r.run(1)).toEqual({ status: 'ok', accepted: 0, rejected: 1 });
      expect(await getTaskByCode(db, 'SHA-001')).toMatchObject({ status: 'open' });
    });

    it('accepts a close backed by an edit made after the human reopened the task', async () => {
      const { db, r } = await setup([{ ops: [close()] }]);
      await reopenedWithOldDelivery(db);
      await applyEdit(db, 1, 'm1', 'Banner v4 attached, final', '2026-10-19T07:00:00.000Z');
      expect(await r.run(1)).toEqual({ status: 'ok', accepted: 1, rejected: 0 });
      expect(await getTaskByCode(db, 'SHA-001')).toMatchObject({ status: 'done' });
    });

    /** A shared image of m1, still pending. */
    const fileOf = async (db: Db): Promise<number> => insertMedia(db, {
      messageId: (await messageRowId(db, 1, 'm1'))!, clientId: 1, kind: 'image', status: 'pending', mimeType: 'image/jpeg', fileName: null, fileSize: 1000, seconds: null,
      forwarded: false, refEnc: null, errorCode: null, createdAt: '2026-10-12T05:00:00.000Z',
    });
    const readAt = (db: Db, id: number, at: string) => finishMedia(db, id, { textKind: 'description', text: 'Banner v3, final colours', pageCount: null, note: null, at });

    it('rejects a close backed by a file read after the human reopened the task, when the message was sent before (12h, I2)', async () => {
      const { db, r } = await setup([{ ops: [close()] }]);
      await reopenedWithOldDelivery(db);
      await readAt(db, await fileOf(db), '2026-10-19T07:00:00.000Z');
      expect(await listUnprocessed(db, 1)).toEqual([expect.objectContaining({ waId: 'm1', requeueReason: null })]);
      expect(await r.run(1)).toEqual({ status: 'ok', accepted: 0, rejected: 1 });
      expect(await getTaskByCode(db, 'SHA-001')).toMatchObject({ status: 'open' });
    });

    it('accepts a close backed by a file sent after the human reopened the task and read later, closed on the day it was sent (12h, I2)', async () => {
      const { db, r } = await setup([{ ops: [close()] }]);
      await banner(db);
      await closeTask(db, 'SHA-001', new Date('2026-10-17T05:00:00Z'));
      await reopenTask(db, 'SHA-001', new Date('2026-10-17T06:00:00Z'));
      await store(db, 'm1', 'Banner v3 attached', '2026-10-18T05:00:00.000Z');
      const id = await fileOf(db);
      await markProcessed(db, (await listUnprocessed(db, 1)).map((m) => m.id), '2026-10-18T06:00:00.000Z'); // the file was still being read
      await readAt(db, id, '2026-10-19T07:00:00.000Z');
      expect(await r.run(1)).toEqual({ status: 'ok', accepted: 1, rejected: 0 });
      expect(await getTaskByCode(db, 'SHA-001')).toMatchObject({ status: 'done', closedOn: '2026-10-18' });
    });

    it('closes on the day the message was sent, not the processing date, when its only re-check is a file read late (12h, I2)', async () => {
      const { db, r } = await setup([{ ops: [close()] }]);
      await banner(db);
      await store(db, 'm1', 'Banner v3 attached', '2026-10-12T05:00:00.000Z');
      const id = await fileOf(db);
      await markProcessed(db, (await listUnprocessed(db, 1)).map((m) => m.id), '2026-10-12T06:00:00.000Z');
      await readAt(db, id, '2026-10-19T07:00:00.000Z');
      expect(await r.run(1)).toEqual({ status: 'ok', accepted: 1, rejected: 0 });
      expect(await getTaskByCode(db, 'SHA-001')).toMatchObject({ status: 'done', closedOn: '2026-10-12' });
    });

    it('never closes a task before the day it was raised: a file re-check of an earlier message closes a task raised later on its raised day (12h)', async () => {
      const { db, r } = await setup([{ ops: [close()] }]);
      await store(db, 'm1', 'Banner v3 attached', '2026-10-12T05:00:00.000Z');
      const id = await fileOf(db);
      await store(db, 'm2', 'Homepage banner bhi chahiye', '2026-10-15T05:00:00.000Z');
      await markProcessed(db, (await listUnprocessed(db, 1)).map((m) => m.id), '2026-10-15T06:00:00.000Z'); // m1's file was still being read
      await createTask(db, { clientId: 1, side: 'us', title: 'Homepage banner', category: 'design', priority: 'major', assignedTo: null, askedBy: null, raisedOn: '2026-10-15',
        deadline: null, latestProgress: null, sourceQuote: null, sourceDate: '2026-10-15', sourceWaId: 'm2', origin: 'whatsapp' }, NOW); // raised by the later m2
      await readAt(db, id, '2026-10-19T07:00:00.000Z');
      expect(await listUnprocessed(db, 1)).toEqual([expect.objectContaining({ waId: 'm1', requeueReason: null })]);
      expect(await r.run(1)).toEqual({ status: 'ok', accepted: 1, rejected: 0 });
      expect(await getTaskByCode(db, 'SHA-001')).toMatchObject({ status: 'done', raisedOn: '2026-10-15', closedOn: '2026-10-15' });
    });

    it('a reminder in a file read late counts, but never moves the last reminder date back (12h, final review)', async () => {
      const { db, r } = await setup([{ ops: [op({ op: 'log_reminder', taskCode: 'SHA-001', sourceMessageIds: ['m1'] })] }]);
      await banner(db);
      await store(db, 'm1', 'Banner ka kya hua?', '2026-10-12T05:00:00.000Z');
      const id = await fileOf(db);
      await markProcessed(db, (await listUnprocessed(db, 1)).map((m) => m.id), '2026-10-12T06:00:00.000Z'); // the file was still being read
      await logReminder(db, (await getTaskByCode(db, 'SHA-001'))!.id, '2026-10-15', NOW); // a later chase, in text
      await readAt(db, id, '2026-10-19T07:00:00.000Z');
      expect(await listUnprocessed(db, 1)).toEqual([expect.objectContaining({ waId: 'm1', requeueReason: null })]);
      expect(await r.run(1)).toEqual({ status: 'ok', accepted: 1, rejected: 0 });
      expect(await getTaskByCode(db, 'SHA-001')).toMatchObject({ reminderCount: 2, lastReminderOn: '2026-10-15' });
    });

    it('still rejects a close backed by a file read before the human reopened the task (12h)', async () => {
      const { db, r } = await setup([{ ops: [close()] }]);
      await banner(db);
      await store(db, 'm1', 'Banner v3 attached', '2026-10-12T05:00:00.000Z');
      const id = await fileOf(db);
      await markProcessed(db, (await listUnprocessed(db, 1)).map((m) => m.id), '2026-10-12T06:00:00.000Z');
      await readAt(db, id, '2026-10-19T04:00:00.000Z');
      await closeTask(db, 'SHA-001', new Date('2026-10-19T05:00:00Z'));
      await reopenTask(db, 'SHA-001', new Date('2026-10-19T06:00:00Z'));
      expect(await r.run(1)).toEqual({ status: 'ok', accepted: 0, rejected: 1 });
      expect(await getTaskByCode(db, 'SHA-001')).toMatchObject({ status: 'open' });
    });

    it.each([
      { fileRead: '2026-10-19T05:30:00.000Z', reacted: '2026-10-19T07:00:00.000Z', accepted: 1 },
      { fileRead: '2026-10-19T07:00:00.000Z', reacted: '2026-10-19T05:30:00.000Z', accepted: 0 },
      { fileRead: '2026-10-19T05:30:00.000Z', reacted: '2026-10-19T05:45:00.000Z', accepted: 0 },
    ])('a file re-check that also got a reaction counts from the reaction, never from the file read (file $fileRead, reaction $reacted) (12h, I2)', async ({ fileRead, reacted, accepted }) => {
      const { db, r } = await setup([{ ops: [close()] }]);
      await reopenedWithOldDelivery(db); // reopened by a human at 06:00Z
      await readAt(db, await fileOf(db), fileRead);
      await upsertReaction(db, { clientId: 1, targetWaId: 'm1', reactorJid: SHARMA_PN, emoji: '✅', ts: reacted });
      expect(await listUnprocessed(db, 1)).toEqual([expect.objectContaining({ waId: 'm1', requeueReason: 'reaction' })]);
      expect(await r.run(1)).toEqual({ status: 'ok', accepted, rejected: 1 - accepted });
      expect(await getTaskByCode(db, 'SHA-001')).toMatchObject(accepted ? { status: 'done', closedOn: '2026-10-19' } : { status: 'open' });
    });

    it.each([
      { fileRead: '2026-10-19T05:30:00.000Z', edited: '2026-10-19T07:00:00.000Z', accepted: 1 },
      { fileRead: '2026-10-19T07:00:00.000Z', edited: '2026-10-19T05:30:00.000Z', accepted: 0 },
    ])('a file re-check that is also an edit re-check counts from the edit, closing on the processing date (file $fileRead, edit $edited) (12h, I2)', async ({ fileRead, edited, accepted }) => {
      const { db, r } = await setup([{ ops: [close()] }]);
      await reopenedWithOldDelivery(db); // reopened by a human at 06:00Z
      await readAt(db, await fileOf(db), fileRead);
      await applyEdit(db, 1, 'm1', 'Banner v4 attached, final', edited);
      expect(await listUnprocessed(db, 1)).toEqual([expect.objectContaining({ waId: 'm1', requeueReason: 'edit' })]);
      expect(await r.run(1)).toEqual({ status: 'ok', accepted, rejected: 1 - accepted });
      expect(await getTaskByCode(db, 'SHA-001')).toMatchObject(accepted ? { status: 'done', closedOn: '2026-10-19' } : { status: 'open' });
    });
  });

  describe('context for the AI', () => {
    /** The <recent_context> section of the prompt the fake AI saw. */
    const contextOf = (ai: FakeAi): string => ai.calls[0]!.user.split('<recent_context>')[1]!.split('</recent_context>')[0]!;

    it('takes the context of a reprocess window from before the window', async () => {
      const { db, ai, r } = await setup([]);
      await store(db, 'p1', 'before one', '2026-10-14T05:00:00.000Z');
      await store(db, 'p2', 'before two', '2026-10-15T05:00:00.000Z');
      await store(db, 'w1', 'inside the window', '2026-10-16T05:00:00.000Z');
      await store(db, 'p3', 'after the window', '2026-10-17T05:00:00.000Z');
      await markProcessed(db, (await listUnprocessed(db, 1)).map((m) => m.id), '2026-10-17T06:00:00.000Z');
      expect(await requestReprocess(db, 'SHA', '2026-10-16', new Date('2026-10-19T07:00:00Z'), '2026-10-16')).toBe(1);

      expect(await r.run(1)).toMatchObject({ status: 'ok' });
      const context = contextOf(ai);
      expect(context).toContain('before one');
      expect(context).toContain('before two');
      expect(context).not.toContain('after the window');
      expect(context).not.toContain('inside the window');
      expect(ai.calls[0]!.user).toContain('inside the window');
    });

    it('keeps the latest context when the batch also holds a reaction re-check of an old message', async () => {
      const { db, ai, r } = await setup([]);
      await store(db, 'o1', 'old delivery', '2026-10-12T05:00:00.000Z');
      await store(db, 'p1', 'recent chat', '2026-10-18T05:00:00.000Z');
      await markProcessed(db, (await listUnprocessed(db, 1)).map((m) => m.id), '2026-10-18T06:00:00.000Z');
      await upsertReaction(db, { clientId: 1, targetWaId: 'o1', reactorJid: SHARMA_PN, emoji: '✅', ts: '2026-10-19T06:00:00.000Z' });
      await store(db, 'n1', 'new message', '2026-10-19T07:00:00.000Z');
      expect((await listUnprocessed(db, 1)).map((m) => m.waId)).toEqual(['o1', 'n1']);

      expect(await r.run(1)).toMatchObject({ status: 'ok' });
      expect(contextOf(ai)).toContain('recent chat');
    });
  });

  it('cuts the source quote by characters, never inside an emoji', async () => {
    const { db, r } = await setup([{ ops: [op({ op: 'add_task', side: 'us', title: 'Banner', category: 'design', priority: 'low', sourceMessageIds: ['m1'] })] }]);
    await store(db, 'm1', '👍'.repeat(130));
    await r.run(1);
    expect((await getTaskByCode(db, 'SHA-001'))!.sourceQuote).toBe('👍'.repeat(120));
  });

  describe('changes that land while the AI call is in flight', () => {
    it('keeps a field a human locked during the call', async () => {
      const { db, ai, r } = await setup([{ ops: [op({ op: 'update_task', taskCode: 'SHA-001', title: 'AI title', sourceMessageIds: ['m1'] })] }]);
      await banner(db);
      await store(db, 'm1', 'Banner ka naam badlo');
      const open = hold(ai);
      const run = r.run(1);
      await open.started();
      await updateTaskFields(db, (await getTaskByCode(db, 'SHA-001'))!.id, { title: 'Human title' }, LATER, 'human');
      open();
      expect(await run).toEqual({ status: 'ok', accepted: 0, rejected: 1 });
      expect(await getTaskByCode(db, 'SHA-001')).toMatchObject({ title: 'Human title', lockedFields: ['title'] });
    });

    it('keeps a role a human set during the call', async () => {
      const { db, ai, r } = await setup([{ ops: [op({ op: 'set_person_role', personJid: SHARMA_PN, role: 'team', sourceMessageIds: ['m1'] })] }]);
      await store(db, 'm1', 'hello');
      const open = hold(ai);
      const run = r.run(1);
      await open.started();
      await setRole(db, 1, SHARMA_PN, 'client', 'human');
      open();
      expect(await run).toEqual({ status: 'ok', accepted: 0, rejected: 1 });
      expect((await listPeople(db, 1))[0]).toMatchObject({ role: 'client', roleSetBy: 'human' });
    });

    it('queues a message edited during the call again, marked as an edit', async () => {
      const log = silentLogger();
      const info = vi.spyOn(log, 'info');
      const { db, ai, r } = await setup([], 15, log);
      await store(db, 'm1', 'Banner bright karo');
      await store(db, 'm2', 'Aur logo bhi', '2026-10-19T07:01:00.000Z');
      const open = hold(ai);
      const run = r.run(1);
      await open.started();
      await applyEdit(db, 1, 'm1', 'Banner dark karo', '2026-10-19T08:00:30.000Z');
      open();
      expect(await run).toEqual({ status: 'ok', accepted: 0, rejected: 0 });
      expect(await listUnprocessed(db, 1)).toEqual([expect.objectContaining({ waId: 'm1', requeueReason: 'edit' })]);
      expect(processedAt(db, 'm2')).not.toBeNull();
      expect(info).toHaveBeenCalledWith(expect.objectContaining({ clientId: 1, requeued: 1 }), 'messages changed during the AI call; queued again');
    });

    it('queues a message that got a reaction during the call again, marked as a reaction', async () => {
      const { db, ai, r } = await setup([]);
      await store(db, 'm1', 'Banner v3 attached');
      await store(db, 'm2', 'Logo bhi bhej diya', '2026-10-19T07:01:00.000Z');
      const open = hold(ai);
      const run = r.run(1);
      await open.started();
      await upsertReaction(db, { clientId: 1, targetWaId: 'm1', reactorJid: SHARMA_PN, emoji: '✅', ts: '2026-10-19T08:00:30.000Z' });
      open();
      expect(await run).toEqual({ status: 'ok', accepted: 0, rejected: 0 });
      expect(await listUnprocessed(db, 1)).toEqual([expect.objectContaining({ waId: 'm1', requeueReason: 'reaction' })]);
      expect(processedAt(db, 'm2')).not.toBeNull();
    });

    it('processes a message edited before the run normally, with no re-check marker left', async () => {
      const { db, r } = await setup([]);
      await store(db, 'm1', 'Banner bright karo');
      await applyEdit(db, 1, 'm1', 'Banner dark karo', '2026-10-19T07:05:00.000Z');
      expect(await r.run(1)).toEqual({ status: 'ok', accepted: 0, rejected: 0 });
      expect(await listUnprocessed(db, 1)).toHaveLength(0);
      expect(db.raw.prepare("SELECT touch_reason AS touch, requeue_reason AS requeue FROM messages WHERE wa_id = 'm1'").get()).toEqual({ touch: null, requeue: null });
    });

    describe('a touch from before the run never labels the message queued again (Job C: P2)', () => {
      const ADD = op({ op: 'add_task', side: 'us', title: 'Print 500 flyers', category: 'design', priority: 'medium', sourceMessageIds: ['m1'] });
      const MORE = op({ op: 'add_task', side: 'us', title: 'Print 600 flyers', category: 'design', priority: 'medium', sourceMessageIds: ['m1'] });
      /** m1's line in the prompt of the given call. */
      const lineOf = (ai: FakeAi, call: number) => ai.calls[call]!.user.split('\n').find((l) => l.startsWith('[m1]')) ?? '';
      const edit = (db: Db, text: string, at: string) => applyEdit(db, 1, 'm1', text, at);
      const react = (db: Db, at: string) => upsertReaction(db, { clientId: 1, targetWaId: 'm1', reactorJid: SHARMA_PN, emoji: '👍', ts: at });

      it.each([
        { why: 'a message edited before its first run', before: (db: Db) => edit(db, 'print 500, A5', '2026-10-19T07:05:00.000Z') },
        {
          why: 'an edit re-check',
          before: async (db: Db) => {
            await markProcessed(db, (await listUnprocessed(db, 1)).map((m) => m.id), '2026-10-19T07:01:00.000Z');
            await edit(db, 'print 500, A5', '2026-10-19T07:05:00.000Z');
          },
        },
      ])('$why that gets a reaction during the call is queued again as a reaction re-check, so its task is not added again', async ({ before }) => {
        const { db, ai, r } = await setup([{ ops: [ADD] }, { ops: [ADD] }]);
        await store(db, 'm1', 'print 500');
        await before(db);
        const open = hold(ai);
        const run = r.run(1);
        await open.started();
        await react(db, '2026-10-19T08:00:10.000Z');
        open();
        expect(await run).toEqual({ status: 'ok', accepted: 1, rejected: 0 });
        expect(await listUnprocessed(db, 1)).toEqual([expect.objectContaining({ waId: 'm1', requeueReason: 'reaction' })]);

        expect(await r.run(1)).toEqual({ status: 'ok', accepted: 0, rejected: 1 }); // the same add_task again
        expect(lineOf(ai, 1)).toContain(' (re-check: new reaction): print 500, A5');
        expect(lineOf(ai, 1)).not.toContain('re-check: edited');
        expect(await getTaskByCode(db, 'SHA-002')).toBeUndefined();
        expect(processedAt(db, 'm1')).not.toBeNull();
      });

      it.each([
        { why: 'nothing before the run', before: (_db: Db) => {} },
        { why: 'an edit before the first run', before: (db: Db) => edit(db, 'print 500, A5', '2026-10-19T07:05:00.000Z') },
        { why: 'a reaction before the first run', before: (db: Db) => react(db, '2026-10-19T07:05:00.000Z') },
      ])('a message edited during the call after $why is queued again as an edit re-check, which may add new work', async ({ before }) => {
        const { db, ai, r } = await setup([{ ops: [ADD] }, { ops: [MORE] }]);
        await store(db, 'm1', 'print 500');
        await before(db);
        const open = hold(ai);
        const run = r.run(1);
        await open.started();
        await edit(db, 'print 600, A5', '2026-10-19T08:00:10.000Z');
        open();
        expect(await run).toEqual({ status: 'ok', accepted: 1, rejected: 0 });
        expect(await listUnprocessed(db, 1)).toEqual([expect.objectContaining({ waId: 'm1', requeueReason: 'edit' })]);

        expect(await r.run(1)).toEqual({ status: 'ok', accepted: 1, rejected: 0 });
        expect(lineOf(ai, 1)).toContain(' (re-check: edited): print 600, A5');
        expect(await getTaskByCode(db, 'SHA-002')).toMatchObject({ title: 'Print 600 flyers' });
      });
    });

    it('flags a new task whose source message was deleted during the call', async () => {
      const { db, ai, r } = await setup([{ ops: [op({ op: 'add_task', side: 'us', title: 'Revise banner', category: 'design', priority: 'major', sourceMessageIds: ['m1'] })] }]);
      await store(db, 'm1', 'Banner bright karo');
      const open = hold(ai);
      const run = r.run(1);
      await open.started();
      await applyRevoke(db, 1, 'm1');
      open();
      expect(await run).toEqual({ status: 'ok', accepted: 1, rejected: 0 });
      expect(await getTaskByCode(db, 'SHA-001')).toMatchObject({ sourceWaId: 'm1', sourceRevoked: true });
    });
  });

  it('does not re-create a task a human closed when the message is reprocessed', async () => {
    const add = op({ op: 'add_task', side: 'us', title: 'Banner', category: 'design', priority: 'major', sourceMessageIds: ['m1'] });
    const { db, r } = await setup([{ ops: [add] }, { ops: [add] }]);
    await store(db, 'm1', 'banner chahiye');
    expect(await r.run(1)).toMatchObject({ status: 'ok', accepted: 1 });
    await closeTask(db, 'SHA-001', new Date('2026-10-19T08:30:00Z'));
    expect(await requestReprocess(db, 'SHA', '2026-10-19', new Date('2026-10-19T08:31:00Z'), undefined)).toBe(1);
    expect(await r.run(1)).toMatchObject({ status: 'ok', accepted: 0, rejected: 1 });
    expect(await getTaskByCode(db, 'SHA-002')).toBeUndefined();
    expect((await getTaskByCode(db, 'SHA-001'))?.status).toBe('done');
  });

  it('does not turn a follow-up that logged a reminder into a new task after the task was closed', async () => {
    const add = op({ op: 'add_task', side: 'us', title: 'Banner', category: 'design', priority: 'major', sourceMessageIds: ['m1'] });
    const remind = op({ op: 'log_reminder', taskCode: 'SHA-001', sourceMessageIds: ['m2'] });
    const replay = op({ op: 'add_task', side: 'us', title: 'Banner update', category: 'design', priority: 'major', sourceMessageIds: ['m2'] });
    const log = silentLogger();
    const info = vi.spyOn(log, 'info');
    const { db, r } = await setup([{ ops: [add] }, { ops: [remind] }, { ops: [replay] }], 15, log);
    await store(db, 'm1', 'banner chahiye', '2026-10-18T05:00:00.000Z');
    expect(await r.run(1)).toMatchObject({ status: 'ok', accepted: 1 });
    await store(db, 'm2', 'banner ka update?', '2026-10-19T05:00:00.000Z');
    expect(await r.run(1)).toMatchObject({ status: 'ok', accepted: 1 });
    expect((await getTaskByCode(db, 'SHA-001'))?.reminderCount).toBe(1);
    await closeTask(db, 'SHA-001', new Date('2026-10-19T08:30:00Z'));
    expect(await requestReprocess(db, 'SHA', '2026-10-19', new Date('2026-10-19T08:31:00Z'))).toBe(1); // m2 only

    expect(await r.run(1)).toMatchObject({ status: 'ok', accepted: 0, rejected: 1 });
    expect(await getTaskByCode(db, 'SHA-002')).toBeUndefined();
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ op: 'add_task', why: 'task already exists for this message' }), 'operation rejected');
  });

  it('does not count a chaser again when it later gets a 👍 reaction', async () => {
    const remind = op({ op: 'log_reminder', taskCode: 'SHA-001', sourceMessageIds: ['m1'] });
    const { db, r } = await setup([{ ops: [remind] }, { ops: [remind] }]);
    await banner(db);
    await store(db, 'm1', 'Banner ka update?', '2026-10-19T05:00:00.000Z');
    expect(await r.run(1)).toMatchObject({ status: 'ok', accepted: 1 });
    await upsertReaction(db, { clientId: 1, targetWaId: 'm1', reactorJid: SHARMA_PN, emoji: '👍', ts: '2026-10-19T07:30:00.000Z' });
    expect(await listUnprocessed(db, 1)).toEqual([expect.objectContaining({ waId: 'm1', requeueReason: 'reaction' })]);

    expect(await r.run(1)).toMatchObject({ status: 'ok', accepted: 0, rejected: 1 });
    expect((await getTaskByCode(db, 'SHA-001'))!.reminderCount).toBe(1);
  });

  it('still creates a task from an edit re-check that adds new work', async () => {
    const banner1 = op({ op: 'add_task', side: 'us', title: 'Banner', category: 'design', priority: 'major', sourceMessageIds: ['m1'] });
    const logo = op({ op: 'add_task', side: 'us', title: 'Logo', category: 'design', priority: 'medium', sourceMessageIds: ['m1'] });
    const { db, r } = await setup([{ ops: [banner1] }, { ops: [logo] }]);
    await store(db, 'm1', 'Banner bright karo', '2026-10-19T05:00:00.000Z');
    expect(await r.run(1)).toMatchObject({ status: 'ok', accepted: 1 });
    await applyEdit(db, 1, 'm1', 'Banner bright karo, aur logo bhi', '2026-10-19T07:30:00.000Z');
    expect(await listUnprocessed(db, 1)).toEqual([expect.objectContaining({ waId: 'm1', requeueReason: 'edit' })]);

    expect(await r.run(1)).toMatchObject({ status: 'ok', accepted: 1, rejected: 0 });
    expect(await getTaskByCode(db, 'SHA-002')).toMatchObject({ title: 'Logo' });
  });

  it('blocks a replay that cites only a later message of the original task (GapB)', async () => {
    const first = op({ op: 'add_task', side: 'us', title: 'Banner', category: 'design', priority: 'major', sourceMessageIds: ['m1', 'm2'] });
    const replay = op({ op: 'add_task', side: 'us', title: 'Banner', category: 'design', priority: 'major', sourceMessageIds: ['m2'] });
    const { db, r } = await setup([{ ops: [first] }, { ops: [replay] }]);
    await store(db, 'm1', 'banner');
    await store(db, 'm2', 'urgent', '2026-10-19T07:10:00.000Z');
    expect(await r.run(1)).toMatchObject({ status: 'ok', accepted: 1 });
    await closeTask(db, 'SHA-001', new Date('2026-10-19T08:30:00Z'));
    expect(await requestReprocess(db, 'SHA', '2026-10-19', new Date('2026-10-19T08:31:00Z'))).toBe(2);
    expect(await r.run(1)).toMatchObject({ status: 'ok', accepted: 0, rejected: 1 });
    expect(await getTaskByCode(db, 'SHA-002')).toBeUndefined();
  });
});
