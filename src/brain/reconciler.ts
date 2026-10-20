import Anthropic from '@anthropic-ai/sdk';
import { estimateCostUsd, type Prices } from '../spend/pricing.ts';
import type { SpendGuard } from '../spend/spendGuard.ts';
import { finishBatch, startBatch } from '../store/batches.ts';
import { getClient, setPhase, setStatus, type ClientRow } from '../store/clients.ts';
import { tx, type Db } from '../store/db.ts';
import { listRecentProcessed, listUnprocessed, markProcessed, reactionsFor, type MessageRow } from '../store/messages.ts';
import { listPeople, setRole } from '../store/people.ts';
import {
  addDecision, createTask, getTaskByCode, listDecisions, listTasks, logReminder, recordEvent, setTaskStatus, TASK_FIELDS, updateTaskFields, type TaskField,
} from '../store/tasks.ts';
import type { Clock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';
import { istDate } from '../util/time.ts';
import { AiInvalidOutputError, AiRefusalError, MAX_OUTPUT_TOKENS, SDK_MAX_RETRIES, type AiCallResult, type AiClient } from './claudeClient.ts';
import { buildUserContent, SYSTEM_PROMPT } from './prompt.ts';
import type { AiOp, AiOutput } from './schema.ts';
import { validateOps, type ValidationState } from './validator.ts';

export type ReconcileOutcome =
  | { status: 'noop' }
  | { status: 'paused' }
  | { status: 'ok'; accepted: number; rejected: number }
  | { status: 'failed'; errorCode: string };

export interface ReconcilerOptions {
  db: Db;
  ai: AiClient;
  spend: SpendGuard;
  prices: Prices;
  clock: Clock;
  log: Logger;
  onChanged: () => void;
}

/** A paid attempt could not reserve its estimate under the daily cap. */
export class SpendCapReachedError extends Error {
  constructor() {
    super('Daily spend cap reached');
    this.name = 'SpendCapReachedError';
  }
}

/** Socket error codes that mean the request never left this machine, so nothing was billed. */
const NEVER_SENT = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH']);

/** Node's fetch nests the socket error: APIConnectionError -> TypeError('fetch failed') -> { code }. */
function neverSent(e: Error): boolean {
  let c: unknown = e.cause;
  for (let depth = 0; depth < 4 && typeof c === 'object' && c !== null; depth++) {
    const code = (c as { code?: unknown }).code;
    if (typeof code === 'string' && NEVER_SENT.has(code)) return true;
    c = (c as { cause?: unknown }).cause;
  }
  return false;
}

function errorCodeOf(e: unknown): string {
  if (e instanceof SpendCapReachedError) return 'spend_cap';
  if (e instanceof AiRefusalError) return 'refusal';
  if (e instanceof AiInvalidOutputError) return 'invalid_output';
  if (e instanceof Anthropic.APIConnectionTimeoutError) return 'timeout';
  if (e instanceof Anthropic.APIConnectionError) return 'network';
  if (e instanceof Anthropic.APIError) return `api_${e.status ?? 'error'}`;
  return 'unknown';
}

export class Reconciler {
  readonly #o: ReconcilerOptions;

  constructor(o: ReconcilerOptions) {
    this.#o = o;
  }

  async run(clientId: number): Promise<ReconcileOutcome> {
    const { db, spend, prices, clock, log } = this.#o;
    const client = getClient(db, clientId);
    const batch = listUnprocessed(db, clientId);
    if (batch.length === 0) return { status: 'noop' };

    const recent = listRecentProcessed(db, clientId);
    const people = listPeople(db, clientId);
    const openTasks = listTasks(db, clientId, ['open', 'maybe_done']);
    const decisions = listDecisions(db, clientId, 20);
    const reactions = reactionsFor(db, clientId, [...recent, ...batch].map((m) => m.waId));
    const now = clock.now();
    const user = buildUserContent({ client, people, openTasks, decisions, recent, batch, reactions, today: istDate(now) });

    // Known and accepted: a call that falls back can cost up to about 2.25x this reservation (a declined primary
    // attempt, then a full fallback attempt at 1.25x rates). settle() books the true cost, so the books stay right;
    // the cap can be overshot only by that gap per call in flight.
    const estimate = estimateCostUsd(SYSTEM_PROMPT.length + user.length, prices, MAX_OUTPUT_TOKENS);
    if (!spend.canSpend(estimate)) return { status: 'paused' };

    const batchId = startBatch(db, clientId, batch.length, now.toISOString());
    let result: { output: AiOutput; invalidOps: number };
    try {
      result = await this.#callWithRetry(user, batchId, estimate);
    } catch (e) {
      const errorCode = errorCodeOf(e);
      finishBatch(db, batchId, { status: 'failed', errorCode, accepted: null, rejected: null, at: clock.now().toISOString() });
      log.warn({ clientId, batchId, errorCode }, 'reconcile failed; messages stay queued');
      // Hitting the cap mid-run is a pause, not an AI error.
      return e instanceof SpendCapReachedError ? { status: 'paused' } : { status: 'failed', errorCode };
    }
    if (result.invalidOps > 0) log.warn({ clientId, batchId, invalidOps: result.invalidOps }, 'model returned invalid operations');

    const byWaId = new Map([...recent, ...batch].map((m) => [m.waId, m]));
    const state: ValidationState = {
      clientCode: client.code,
      phases: client.phases,
      phaseLocked: client.phaseLocked,
      tasksByCode: new Map(openTasks.map((t) => [t.code, t])),
      batchIds: new Set(batch.map((m) => m.waId)),
      contextIds: new Set(recent.map((m) => m.waId)),
      messageTs: new Map([...byWaId].map(([id, m]) => [id, m.ts])),
      peopleByJid: new Map(people.map((p) => [p.jid, p])),
    };
    const { accepted, rejected } = validateOps(result.output.ops, state);

    const appliedAt = clock.now();
    try {
      tx(db, () => {
        for (const op of accepted) this.#apply(client, op, byWaId, appliedAt);
        markProcessed(db, batch.map((m) => m.id), appliedAt.toISOString());
        finishBatch(db, batchId, { status: 'ok', errorCode: null, accepted: accepted.length, rejected: rejected.length, at: appliedAt.toISOString() });
      });
    } catch (err) {
      // The transaction rolled back: nothing was applied and the messages stay queued.
      finishBatch(db, batchId, { status: 'failed', errorCode: 'apply_failed', accepted: null, rejected: null, at: clock.now().toISOString() });
      log.error({ clientId, batchId, err }, 'applying operations failed; messages stay queued');
      return { status: 'failed', errorCode: 'apply_failed' };
    }
    for (const r of rejected) log.info({ clientId, batchId, op: r.op.op, why: r.reason }, 'operation rejected');
    this.#o.onChanged();
    return { status: 'ok', accepted: accepted.length, rejected: rejected.length };
  }

  /** Every attempt reserves its estimate first, and every outcome settles or releases that reservation. */
  async #callWithRetry(user: string, batchId: number, estimate: number): Promise<{ output: AiOutput; invalidOps: number }> {
    const { ai, spend } = this.#o;
    for (let attempt = 0; ; attempt++) {
      const rid = spend.reserve(estimate);
      if (rid === null) throw new SpendCapReachedError();
      let r: AiCallResult;
      try {
        r = await ai.reconcile(SYSTEM_PROMPT, user);
      } catch (e) {
        this.#settleFailed(rid, e, batchId, estimate);
        if (e instanceof AiInvalidOutputError && attempt === 0) continue;
        throw e;
      }
      spend.settle(rid, 'ai', r.costUsd, `batch ${batchId}${r.fallbackUsed ? ' (fallback)' : ''}`);
      return { output: r.output, invalidOps: r.invalidOps };
    }
  }

  #settleFailed(rid: number, e: unknown, batchId: number, estimate: number): void {
    const { spend } = this.#o;
    if (e instanceof AiRefusalError || e instanceof AiInvalidOutputError) {
      spend.settle(rid, 'ai', e.costUsd ?? estimate, `batch ${batchId} (failed)`);
    } else if (e instanceof Anthropic.APIConnectionError) {
      // Checked before APIError, its parent class. A timeout or a reset after sending may have been billed,
      // once per SDK attempt.
      if (neverSent(e)) spend.release(rid);
      else spend.settle(rid, 'ai', estimate * (SDK_MAX_RETRIES + 1), `batch ${batchId} (connection lost, estimated)`);
    } else if (e instanceof Anthropic.APIError) {
      spend.release(rid); // the server answered with an error status: not billed
    } else {
      spend.settle(rid, 'ai', estimate, `batch ${batchId} (unknown, estimated)`);
    }
  }

  #apply(client: ClientRow, op: AiOp, byWaId: Map<string, MessageRow>, at: Date): void {
    const { db } = this.#o;
    const nowIso = at.toISOString();
    const sources = op.sourceMessageIds
      .map((id) => byWaId.get(id))
      .filter((m): m is MessageRow => m !== undefined)
      .sort((a, b) => a.ts.localeCompare(b.ts));
    const first = sources[0];
    const last = sources[sources.length - 1];
    const dateOf = (m: MessageRow | undefined) => istDate(m ? new Date(m.ts) : at);
    // A re-queued message (new reaction or edit) is evidence from today, not from the day it was first sent.
    const lastDate = last?.requeueReason ? istDate(at) : dateOf(last);
    const event = (taskId: number | null, detail: object) =>
      recordEvent(db, { taskId, clientId: client.id, actor: 'ai', op: op.op, detail, reason: op.reason, sourceIds: op.sourceMessageIds, at: nowIso });
    const taskFor = (code: string | null) => {
      const t = code ? getTaskByCode(db, code) : undefined;
      if (!t) throw new Error('validated task disappeared'); // cannot happen inside the transaction
      return t;
    };

    switch (op.op) {
      case 'add_task': {
        const t = createTask(db, {
          clientId: client.id,
          side: op.side!,
          title: op.title!,
          category: op.category!,
          priority: op.priority!,
          assignedTo: op.assignedTo,
          askedBy: op.askedBy ?? first?.senderName ?? null,
          raisedOn: dateOf(first),
          deadline: op.deadline,
          latestProgress: op.latestProgress,
          sourceQuote: first?.text ? first.text.slice(0, 120) : null,
          sourceDate: first ? dateOf(first) : null,
          sourceWaId: first?.waId ?? null,
          origin: 'whatsapp',
        }, nowIso);
        if (op.status) setTaskStatus(db, t.id, op.status, lastDate, nowIso, 'ai');
        event(t.id, { code: t.code, title: t.title, side: t.side, status: op.status ?? 'open' });
        return;
      }
      case 'update_task': {
        const t = taskFor(op.taskCode);
        const fields: Partial<Record<TaskField, string | null>> = {};
        for (const f of TASK_FIELDS) {
          const v = op[f];
          if (v !== null) fields[f] = v;
        }
        updateTaskFields(db, t.id, fields, nowIso, 'ai');
        event(t.id, fields);
        return;
      }
      case 'close_task': {
        const t = taskFor(op.taskCode);
        setTaskStatus(db, t.id, 'done', lastDate, nowIso, 'ai');
        event(t.id, { status: 'done' });
        return;
      }
      case 'mark_maybe_done': {
        const t = taskFor(op.taskCode);
        setTaskStatus(db, t.id, 'maybe_done', lastDate, nowIso, 'ai');
        event(t.id, { status: 'maybe_done' });
        return;
      }
      case 'reopen_task': {
        const t = taskFor(op.taskCode);
        setTaskStatus(db, t.id, 'open', lastDate, nowIso, 'ai');
        event(t.id, { status: 'open' });
        return;
      }
      case 'log_reminder': {
        const t = taskFor(op.taskCode);
        logReminder(db, t.id, lastDate, nowIso);
        event(t.id, { reminder: lastDate });
        return;
      }
      case 'add_decision':
        addDecision(db, { clientId: client.id, text: op.text!, decidedOn: dateOf(first), source: 'whatsapp', sourceWaId: first?.waId ?? null }, nowIso);
        event(null, { decision: op.text });
        return;
      case 'set_phase':
        setPhase(db, client.id, op.phase!, 'ai');
        event(null, { phase: op.phase });
        return;
      case 'set_status':
        setStatus(db, client.id, op.text!, nowIso);
        event(null, { status: op.text });
        return;
      case 'set_person_role':
        setRole(db, client.id, op.personJid!, op.role!, 'ai');
        event(null, { personJid: op.personJid, role: op.role });
        return;
    }
  }
}
