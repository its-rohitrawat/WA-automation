import Anthropic from '@anthropic-ai/sdk';
import { mediaForPrompt, mediaPromptTexts, readyPrefix } from '../media/promptText.ts';
import { estimateCostUsd, type Prices } from '../spend/pricing.ts';
import type { SpendGuard } from '../spend/spendGuard.ts';
import { finishBatch, startBatch } from '../store/batches.ts';
import { getClient, setPhase, setStatus, type ClientRow } from '../store/clients.ts';
import { tx, type Db } from '../store/db.ts';
import { mediaForMessages } from '../store/media.ts';
import {
  clearTouches, flagRevokedSources, listRecentProcessed, listUnprocessed, markProcessedIfUnchanged, reactionsFor, type MessageRow, type StoredReactionRow,
} from '../store/messages.ts';
import { listPeople, setRole } from '../store/people.ts';
import {
  addDecision, createTask, decisionSourceIds, getTaskByCode, listDecisions, listTasks, logReminder, recordEvent, reminderSourceIds, setTaskStatus, taskSourceIds, TASK_FIELDS, updateTaskFields, type TaskField,
} from '../store/tasks.ts';
import type { Clock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';
import { istDate } from '../util/time.ts';
import { AiInvalidOutputError, AiRefusalError, MAX_OUTPUT_TOKENS, type AiCallResult, type AiClient } from './claudeClient.ts';
import { SpendCapReachedError, settleFailedCall } from './paidCall.ts';
import { buildUserContent, SYSTEM_PROMPT } from './prompt.ts';
import type { AiOp, AiOutput } from './schema.ts';
import { validateOps, type Rejection, type ValidationState } from './validator.ts';

/**
 * noop: nothing to do. waiting: messages are queued, but the first one's file is still being read (no AI call, no spend);
 * it is not a success and not a failure, so the debouncer keeps its failure count and Health ignores it.
 * paused: today's spend leaves no room for the run (the daily cap is the reason).
 * busy: the run fits under the cap, but not next to the holds of paid calls still in flight, such as a scanned PDF
 * being read. Like waiting, the debouncer keeps its failure count and Health ignores it; the debouncer tries again
 * after BUSY_RETRY_MS, not after the hour a pause waits (Task 15 review round 3).
 */
export type ReconcileOutcome =
  | { status: 'noop' }
  | { status: 'waiting' }
  | { status: 'paused' }
  | { status: 'busy' }
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
  /**
   * When the service started. A file still being read holds up its message for 30 minutes counted from its arrival or
   * from this time, whichever is later. Default: the clock's time when the Reconciler is made.
   */
  startedAt?: Date;
}

/** Re-exported for existing importers; it lives in paidCall.ts with the other spend helpers. */
export { SpendCapReachedError } from './paidCall.ts';

/**
 * When a message became evidence, for the human status-lock check: a reaction re-check counts from its latest reaction,
 * an edit re-check from its edit, anything else from when it was sent. That includes a "file now read" re-check
 * (amendment 12h): a file is evidence of what the client sent at that moment, so a human close or reopen made after it
 * wins, however late the file was read. A file re-check that is also an edit or reaction re-check counts from the edit
 * or reaction.
 */
function evidenceTs(m: MessageRow, reactions: StoredReactionRow[]): string {
  if (m.requeueReason === 'edit') return m.editedAt ?? m.ts;
  if (m.requeueReason === 'reaction') {
    const latest = reactions.filter((r) => r.targetWaId === m.waId).reduce<string | null>((max, r) => (max === null || r.ts > max ? r.ts : max), null);
    return latest ?? m.ts;
  }
  return m.ts;
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
  readonly #startedAt: Date;
  /** Clients whose last run was 'waiting', so a wait is logged at info only when it starts. */
  readonly #waiting = new Set<number>();

  constructor(o: ReconcilerOptions) {
    this.#o = o;
    this.#startedAt = o.startedAt ?? o.clock.now();
  }

  async run(clientId: number): Promise<ReconcileOutcome> {
    const { db, spend, prices, clock, log } = this.#o;
    // Any outcome but 'waiting' ends a wait (it is added back below), including a run that throws.
    const wasWaiting = this.#waiting.delete(clientId);
    const client = getClient(db, clientId);
    if (!client.active) return { status: 'noop' };
    const queued = listUnprocessed(db, clientId);
    if (queued.length === 0) return { status: 'noop' };
    const now = clock.now();
    // §6.1: a shared file is read before the AI sees its message. Messages from the first file still being read onward
    // wait for a later run; the media queue tells the debouncer when that file is done, or the app tick re-runs it once
    // the wait runs out. Blocking needs no text (maxChars 0).
    const queuedMedia = mediaForMessages(db, queued.map((m) => m.id), 0);
    const batch = readyPrefix(queued, queuedMedia, now, this.#startedAt);
    if (batch.length === 0) {
      this.#waiting.add(clientId);
      // The app tick re-runs a waiting client every few minutes, so only the start of a wait is worth an info line.
      const fields = { clientId, waiting: queued.length };
      if (wasWaiting) log.debug(fields, 'waiting for shared files to be read');
      else log.info(fields, 'waiting for shared files to be read');
      return { status: 'waiting' };
    }

    // Amendment 12h: a message whose file was read after the message was processed is back as a "file now read"
    // re-check. Its evidence time and dates are still the message's own (evidenceTs, #apply).
    const fileRechecks = new Set(batch.filter((m) => queuedMedia.get(m.id)?.requeuedForText === true).map((m) => m.id));
    const isRecheck = (m: MessageRow): boolean => m.requeueReason !== null || fileRechecks.has(m.id);

    // Context comes from before the first new or reprocessed message, so a reprocess window does not see later chat.
    // Re-checks (edits, reactions, files read late) of old messages are skipped here: they must not pull the context back in time.
    const firstNew = batch.find((m) => !isRecheck(m));
    const recent = listRecentProcessed(db, clientId, 30, firstNew?.ts);
    const people = listPeople(db, clientId);
    const openTasks = listTasks(db, clientId, ['open', 'maybe_done']);
    const decisions = listDecisions(db, clientId, 20);
    const reactions = reactionsFor(db, clientId, [...recent, ...batch].map((m) => m.waId));
    const mediaText = mediaPromptTexts(mediaForPrompt(db, batch, recent), batch, recent);
    const user = buildUserContent({
      client, people, openTasks, decisions, recent, batch, reactions, today: istDate(now), mediaText, fileRechecks,
    });

    // Known and accepted: a call that falls back can cost up to about 2.25x this reservation (a declined primary
    // attempt, then a full fallback attempt at 1.25x rates). settle() books the true cost, so the books stay right;
    // the cap can be overshot only by that gap per call in flight.
    const estimate = estimateCostUsd(SYSTEM_PROMPT.length + user.length, prices, MAX_OUTPUT_TOKENS);
    if (!spend.canSpend(estimate)) return this.#spendBlocked(clientId, estimate);

    // Job C, P2: only an edit or a reaction made during the call may label a message queued again, never one from before
    // this run. Nothing has awaited since the batch was listed, and the version check keeps any touch made since.
    clearTouches(db, batch.map((m) => ({ id: m.id, version: m.version })));
    const batchId = startBatch(db, clientId, batch.length, now.toISOString());
    let result: { output: AiOutput; invalidOps: number };
    try {
      result = await this.#callWithRetry(user, batchId, estimate);
    } catch (e) {
      // A retry that cannot reserve is not an AI error: a pause when the cap is the reason, busy when holds are.
      const blocked = e instanceof SpendCapReachedError ? this.#spendBlocked(clientId, estimate) : undefined;
      const errorCode = blocked?.status === 'busy' ? 'spend_busy' : errorCodeOf(e);
      finishBatch(db, batchId, { status: 'failed', errorCode, accepted: null, rejected: null, at: clock.now().toISOString() });
      if (blocked) return blocked;
      log.warn({ clientId, batchId, errorCode }, 'reconcile failed; messages stay queued');
      return { status: 'failed', errorCode };
    }
    if (result.invalidOps > 0) log.warn({ clientId, batchId, invalidOps: result.invalidOps }, 'model returned invalid operations');

    // Message ids and times come from the rows the AI saw.
    const byWaId = new Map([...recent, ...batch].map((m) => [m.waId, m]));
    const batchIds = new Set(batch.map((m) => m.waId));
    const contextIds = new Set(recent.map((m) => m.waId));
    const messageTs = new Map([...byWaId].map(([id, m]) => [id, evidenceTs(m, reactions)]));

    const appliedAt = clock.now();
    let applied: { accepted: AiOp[]; rejected: Rejection[]; requeued: number };
    try {
      applied = tx(db, () => {
        // The call can take minutes and a human can correct the tracker meanwhile, so validate against the
        // client, tasks and people as they are now. Nothing can interleave inside this synchronous transaction.
        const fresh = getClient(db, clientId);
        const state: ValidationState = {
          clientCode: fresh.code,
          phases: fresh.phases,
          phaseLocked: fresh.phaseLocked,
          tasksByCode: new Map(listTasks(db, clientId, ['open', 'maybe_done']).map((t) => [t.code, t])),
          batchIds,
          contextIds,
          messageTs,
          peopleByJid: new Map(listPeople(db, clientId).map((p) => [p.jid, p])),
          taskSourceIds: taskSourceIds(db, clientId),
          reminderSourceIds: reminderSourceIds(db, clientId),
          decisionSourceIds: decisionSourceIds(db, clientId),
          editedIds: new Set(batch.filter((m) => m.requeueReason === 'edit').map((m) => m.waId)),
        };
        const { accepted, rejected } = validateOps(result.output.ops, state);
        for (const op of accepted) this.#apply(fresh, op, byWaId, appliedAt);
        // fileUnread: the prompt showed the file as still being read. If it was read during the call, the message stays
        // queued as a "file now read" re-check. fileShown: the prompt showed the file's text as a "file now read"
        // re-check, so a message queued again for an edit or a reaction does not show it as one again (amendment 12h).
        const seen = batch.map((m) => ({
          id: m.id, version: m.version, fileUnread: queuedMedia.get(m.id)?.status === 'pending', fileShown: fileRechecks.has(m.id),
        }));
        const requeued = markProcessedIfUnchanged(db, seen, appliedAt.toISOString());
        flagRevokedSources(db, clientId); // a source message deleted during the call
        finishBatch(db, batchId, { status: 'ok', errorCode: null, accepted: accepted.length, rejected: rejected.length, at: appliedAt.toISOString() });
        return { accepted, rejected, requeued };
      });
    } catch (err) {
      // The transaction rolled back: nothing was applied and the messages stay queued.
      finishBatch(db, batchId, { status: 'failed', errorCode: 'apply_failed', accepted: null, rejected: null, at: clock.now().toISOString() });
      log.error({ clientId, batchId, err }, 'applying operations failed; messages stay queued');
      return { status: 'failed', errorCode: 'apply_failed' };
    }
    const { accepted, rejected, requeued } = applied;
    for (const r of rejected) log.info({ clientId, batchId, op: r.op.op, why: r.reason }, 'operation rejected');
    if (requeued > 0) log.info({ clientId, batchId, requeued }, 'messages changed during the AI call; queued again');
    this.#o.onChanged();
    return { status: 'ok', accepted: accepted.length, rejected: rejected.length };
  }

  /**
   * The estimate could not be reserved. Paused only when today's spend leaves no room for it. Otherwise holds of paid
   * calls still in flight are in the way and clear within minutes, so the run is busy: Health must not say the cap is
   * reached, and the retry must not wait the hour a pause waits (Task 15 review round 3).
   */
  #spendBlocked(clientId: number, estimate: number): { status: 'paused' } | { status: 'busy' } {
    const { spend, log } = this.#o;
    if (spend.fitsIgnoringHolds(estimate)) {
      log.info({ clientId }, 'other paid calls in flight: run deferred');
      return { status: 'busy' };
    }
    log.info({ clientId }, 'spend cap: run paused');
    return { status: 'paused' };
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
        settleFailedCall(spend, rid, e, estimate, `batch ${batchId}`);
        if (e instanceof AiInvalidOutputError && attempt === 0) continue;
        throw e;
      }
      spend.settle(rid, 'ai', r.costUsd, `batch ${batchId}${r.fallbackUsed ? ' (fallback)' : ''}`);
      return { output: r.output, invalidOps: r.invalidOps };
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
    // A message re-checked for a new reaction or an edit is evidence from today, not from the day it was first sent. A
    // "file now read" re-check alone is not (amendment 12h): the file is dated like the message that shared it.
    const lastDate = sources.some((m) => m.requeueReason !== null) ? istDate(at) : dateOf(last);
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
          sourceQuote: first?.text ? [...first.text].slice(0, 120).join('') : null,
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
        // A task cannot close before it was raised. A file-only re-check dates the close by the day its message was sent
        // (amendment 12h), which can be before the day a later message raised the task. logReminder clamps the same way:
        // the last reminder date never moves back.
        setTaskStatus(db, t.id, 'done', lastDate < t.raisedOn ? t.raisedOn : lastDate, nowIso, 'ai');
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
