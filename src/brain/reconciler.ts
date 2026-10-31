import Anthropic from '@anthropic-ai/sdk';
import { mediaForPrompt, mediaPromptTexts, readyPrefix } from '../media/promptText.ts';
import { MeetingDeferral } from '../meetings/audio.ts';
import { estimateCostUsd, type Prices } from '../spend/pricing.ts';
import type { SpendGuard } from '../spend/spendGuard.ts';
import { finishBatch, startBatch } from '../store/batches.ts';
import type { PriorityConfig } from '../config/prioritySettings.ts';
import { getClient, setClientSentiment, setPhase, setStatus, type ClientRow } from '../store/clients.ts';
import type { Db, Sql } from '../store/db.ts';
import { mediaForMessages } from '../store/media.ts';
import { finishMeeting } from '../store/meetings.ts';
import {
  clearTouches, flagRevokedSources, listRecentProcessed, listUnprocessed, markProcessedIfUnchanged, reactionsFor, type MessageRow, type StoredReactionRow,
} from '../store/messages.ts';
import { listPeople, setRole } from '../store/people.ts';
import {
  addDecision, createTask, decisionSourceIds, getTaskByCode, listDecisions, listTasks, logReminder, PRIORITIES, recordEvent, reminderSourceIds, setTaskSentiment,
  setTaskStatus, taskSourceIds, TASK_FIELDS, updateTaskFields, type Priority, type TaskField, type TaskRow,
} from '../store/tasks.ts';
import type { Segment } from '../stt/types.ts';
import type { Clock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';
import { istDate } from '../util/time.ts';
import { AiInvalidOutputError, AiRefusalError, MAX_OUTPUT_TOKENS, type AiCallResult, type AiClient } from './claudeClient.ts';
import type { MeetingSummary } from './meetingSchema.ts';
import { MEETING_ITEM_MAX_QUOTE, MEETING_TRACKER_PROMPT, meetingItemLines, meetingItems, type MeetingItem } from './meetingTracker.ts';
import { SpendCapReachedError, settleFailedCall } from './paidCall.ts';
import { keywordMatcher, NO_KEYWORDS, type KeywordMatch } from './priorityKeywords.ts';
import { buildUserContent, systemPromptFor } from './prompt.ts';
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
  /**
   * Holds the client's run flag for a meeting run (GroupDebouncer.runExclusive), so a WhatsApp run of the same client
   * cannot interleave with it and add the same task twice. Returns 'busy' when the client is running. Default: no lock.
   */
  exclusive?: <T>(clientId: number, fn: () => Promise<T>) => Promise<T | 'busy'>;
  /**
   * Whether voice notes are transcribed (Phase 2b final review): true when a voice transcriber is set up (src/app.ts).
   * When false (VOICE_STT_PROVIDER none, or the local engine not set up), a pending voice note or audio file holds up
   * nothing, as in 2a: no transcript is coming. Images and documents are unchanged. Default true, the safe side.
   */
  voiceTranscriptionOn?: boolean;
  /**
   * The owner's priority keywords and the sentiment switch (src/config/prioritySettings.ts), read at the start of every
   * run so a change from the dashboard applies to the next batch. Default: no keywords, sentiment off.
   */
  priority?: () => PriorityConfig;
}

/** What one run applies with: the keyword matcher and whether this read asked for sentiment. */
interface RunRules {
  match: (texts: readonly string[]) => KeywordMatch | null;
  sentiment: boolean;
}

const rank = (p: Priority): number => PRIORITIES.indexOf(p);

/** A meeting at stage doc, as the tracker step needs it. */
export interface MeetingForTracker {
  id: number;
  /** When the meeting started (ISO): the evidence time of every item. */
  startedAt: string;
  title?: string | null;
  summary: MeetingSummary;
  segments: readonly Segment[];
}

/**
 * The tracker step of a meeting finished, and the meeting is done (stage tracked). note: client_inactive when the client
 * was inactive and nothing was sent. Spend and a busy client throw MeetingDeferral; any other failure is rethrown.
 */
export interface MeetingTrackOutcome {
  status: 'done';
  accepted: number;
  rejected: number;
  note?: 'client_inactive';
}

/** What every piece of evidence has: two times, which differ for a message re-checked for an edit or a reaction. */
interface EvidenceTimes {
  /** A message's send time; a meeting item's meeting start. Task and decision dates come from this. */
  dateTs: string;
  /** What the owner's priority keywords are matched in: a message's text and its voice note's transcript, an item's text. */
  text: string;
  /** When it became evidence, for the human status lock (ValidationState.messageTs): evidenceTs for a message, the meeting start for an item. */
  lockTs: string;
}

/** A WhatsApp message, from the batch or the context. */
interface MessageEvidence extends EvidenceTimes {
  kind: 'message';
  /**
   * What a new task keeps as its source quote: the text's first MESSAGE_QUOTE_MAX code points, or for a voice note or
   * audio file sent without text, its transcript's first MEETING_ITEM_MAX_QUOTE.
   */
  quote: string | null;
  waId: string;
  senderName: string | null;
  /** A message re-checked for an edit or a reaction: evidence from today, not from the day it was sent. */
  recheck: boolean;
}

/** A meeting item: no sender and no WhatsApp id. */
interface MeetingEvidence extends EvidenceTimes {
  kind: 'meeting';
  /** The first cited segment's words, already cut to MEETING_ITEM_MAX_QUOTE (meetingTracker.ts). */
  quote: string | null;
  meetingId: number;
}

/** What an op cites, for #apply and the validator. Shared by WhatsApp and meeting runs; a WhatsApp run only ever has messages. */
type Evidence = MessageEvidence | MeetingEvidence;

/**
 * Longest source quote a task keeps from a WhatsApp message (code points), as before meetings. A meeting item keeps up
 * to MEETING_ITEM_MAX_QUOTE (200) instead: its quote is a transcript segment, spoken words that run longer than a
 * typical chat line. A voice note sent without text keeps the same 200 of its transcript, for the same reason.
 */
const MESSAGE_QUOTE_MAX = 120;

/** transcript: the stored transcript of the message's voice note or audio file, if it has one. The typed text wins. */
function messageEvidence(m: MessageRow, reactions: StoredReactionRow[], transcript?: string): MessageEvidence {
  const quote = m.text
    ? [...m.text].slice(0, MESSAGE_QUOTE_MAX).join('')
    : transcript
      ? [...transcript].slice(0, MEETING_ITEM_MAX_QUOTE).join('')
      : null;
  return {
    kind: 'message',
    dateTs: m.ts,
    text: [m.text ?? '', transcript ?? ''].filter(Boolean).join('\n'),
    lockTs: evidenceTs(m, reactions),
    quote,
    waId: m.waId,
    senderName: m.senderName,
    recheck: m.requeueReason !== null,
  };
}

function itemEvidence(meetingId: number, it: MeetingItem): MeetingEvidence {
  return { kind: 'meeting', dateTs: it.ts, lockTs: it.ts, text: it.text, quote: it.quote, meetingId };
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

  /** This run's rules. A meeting run never asks for sentiment: its prompt has no sentiment rules. */
  #rules(o: { meeting: boolean }): RunRules {
    let c: PriorityConfig = { keywords: NO_KEYWORDS, sentimentEnabled: false };
    try {
      if (this.#o.priority) c = this.#o.priority();
    } catch (err) {
      // The settings could not be read: this run goes on without keywords or sentiment, as before they existed.
      this.#o.log.error({ err }, 'priority settings could not be read');
    }
    return { match: keywordMatcher(c.keywords), sentiment: c.sentimentEnabled && !o.meeting };
  }

  async run(clientId: number): Promise<ReconcileOutcome> {
    const { db, spend, prices, clock, log } = this.#o;
    // Any outcome but 'waiting' ends a wait (it is added back below), including a run that throws.
    const wasWaiting = this.#waiting.delete(clientId);
    const client = await getClient(db, clientId);
    if (!client.active) return { status: 'noop' };
    const queued = await listUnprocessed(db, clientId);
    if (queued.length === 0) return { status: 'noop' };
    const now = clock.now();
    // §6.1: a shared file is read before the AI sees its message. Messages from the first file still being read onward
    // wait for a later run; the media queue tells the debouncer when that file is done, or the app tick re-runs it once
    // the wait runs out. Blocking needs no text (maxChars 0).
    const queuedMedia = await mediaForMessages(db, queued.map((m) => m.id), 0);
    const batch = readyPrefix(queued, queuedMedia, now, this.#startedAt, { voiceOn: this.#o.voiceTranscriptionOn ?? true });
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
    const recent = await listRecentProcessed(db, clientId, 30, firstNew?.ts);
    const people = await listPeople(db, clientId);
    const openTasks = await listTasks(db, clientId, ['open', 'maybe_done']);
    const decisions = await listDecisions(db, clientId, 20);
    const reactions = await reactionsFor(db, clientId, [...recent, ...batch].map((m) => m.waId));
    const media = await mediaForPrompt(db, batch, recent);
    const mediaText = mediaPromptTexts(media, batch, recent);
    const user = buildUserContent({
      client, people, openTasks, decisions, recent, batch, reactions, today: istDate(now), mediaText, fileRechecks,
    });
    const rules = this.#rules({ meeting: false });
    const system = systemPromptFor({ sentiment: rules.sentiment });

    // Known and accepted: a call that falls back can cost up to about 2.25x this reservation (a declined primary
    // attempt, then a full fallback attempt at 1.25x rates). settle() books the true cost, so the books stay right;
    // the cap can be overshot only by that gap per call in flight.
    const estimate = estimateCostUsd(system.length + user.length, prices, MAX_OUTPUT_TOKENS);
    if (!spend.canSpend(estimate)) return this.#spendBlocked(clientId, estimate);

    // Job C, P2: only an edit or a reaction made during the call may label a message queued again, never one from before
    // this run. The version check keeps any touch made since the batch was listed (the media reads above await).
    await clearTouches(db, batch.map((m) => ({ id: m.id, version: m.version })));
    const batchId = await startBatch(db, clientId, batch.length, now.toISOString());
    let result: { output: AiOutput; invalidOps: number };
    try {
      result = await this.#callWithRetry(system, user, `batch ${batchId}`, estimate, { sentiment: rules.sentiment });
    } catch (e) {
      // A retry that cannot reserve is not an AI error: a pause when the cap is the reason, busy when holds are.
      const blocked = e instanceof SpendCapReachedError ? this.#spendBlocked(clientId, estimate) : undefined;
      const errorCode = blocked?.status === 'busy' ? 'spend_busy' : errorCodeOf(e);
      await finishBatch(db, batchId, { status: 'failed', errorCode, accepted: null, rejected: null, at: clock.now().toISOString() });
      if (blocked) return blocked;
      log.warn({ clientId, batchId, errorCode }, 'reconcile failed; messages stay queued');
      return { status: 'failed', errorCode };
    }
    if (result.invalidOps > 0) log.warn({ clientId, batchId, invalidOps: result.invalidOps }, 'model returned invalid operations');

    // Message ids and times come from the rows the AI saw.
    // A voice note's transcript can be a task's source quote; the rows were loaded with enough text for it above.
    const transcripts = new Map<number, string>();
    for (const [id, f] of media) if ((f.kind === 'voice' || f.kind === 'audio') && f.text) transcripts.set(id, f.text);
    const { evidence, messageTs } = this.#evidenceMaps([...recent, ...batch], reactions, undefined, transcripts);
    const batchIds = new Set(batch.map((m) => m.waId));
    const contextIds = new Set(recent.map((m) => m.waId));
    const editedIds = new Set(batch.filter((m) => m.requeueReason === 'edit').map((m) => m.waId));

    const appliedAt = clock.now();
    let applied: { accepted: AiOp[]; rejected: Rejection[]; requeued: number };
    try {
      applied = await db.tx(async (q) => {
        // The call can take minutes and a human can correct the tracker meanwhile, so validate against the
        // client, tasks and people as they are now. Nothing else runs on the database inside this transaction.
        const fresh = await getClient(q, clientId);
        const state = await this.#validationState(q, fresh, clientId, { batchIds, contextIds, messageTs, editedIds, source: 'whatsapp' });
        const { accepted, rejected } = validateOps(result.output.ops, state);
        for (const op of accepted) await this.#apply(q, fresh, op, evidence, appliedAt, rules);
        // fileUnread: the prompt showed the file as still being read. If it was read during the call, the message stays
        // queued as a "file now read" re-check. fileShown: the prompt showed the file's text as a "file now read"
        // re-check, so a message queued again for an edit or a reaction does not show it as one again (amendment 12h).
        const seen = batch.map((m) => ({
          id: m.id, version: m.version, fileUnread: queuedMedia.get(m.id)?.status === 'pending', fileShown: fileRechecks.has(m.id),
        }));
        const requeued = await markProcessedIfUnchanged(q, seen, appliedAt.toISOString());
        await flagRevokedSources(q, clientId); // a source message deleted during the call
        await finishBatch(q, batchId, { status: 'ok', errorCode: null, accepted: accepted.length, rejected: rejected.length, at: appliedAt.toISOString() });
        return { accepted, rejected, requeued };
      });
    } catch (err) {
      // The transaction rolled back: nothing was applied and the messages stay queued.
      await finishBatch(db, batchId, { status: 'failed', errorCode: 'apply_failed', accepted: null, rejected: null, at: clock.now().toISOString() });
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
   * A meeting's tracker step (M5 B): its action items and decisions are evidence items, applied with the chat rules
   * except roles, and the meeting is finished (done, stage tracked) in the same transaction as the ops. No items, or an
   * inactive client, finish it without an AI call. Spend that does not fit throws MeetingDeferral spend_cap or
   * spend_busy, a client whose WhatsApp run is in flight throws MeetingDeferral client_busy, and any other failure is
   * rethrown with nothing applied.
   */
  async runMeeting(clientId: number, meeting: MeetingForTracker): Promise<MeetingTrackOutcome> {
    const { db, clock } = this.#o;
    const items = meetingItems(meeting.id, meeting.summary, meeting.segments, meeting.startedAt);
    if (items.length === 0) {
      await finishMeeting(db, meeting.id, { at: clock.now().toISOString() });
      return { status: 'done', accepted: 0, rejected: 0 };
    }
    if (!(await getClient(db, clientId)).active) {
      await finishMeeting(db, meeting.id, { note: 'client_inactive', at: clock.now().toISOString() });
      return { status: 'done', accepted: 0, rejected: 0, note: 'client_inactive' };
    }
    const exclusive = this.#o.exclusive ?? (<T>(_id: number, fn: () => Promise<T>): Promise<T | 'busy'> => fn());
    const r = await exclusive(clientId, () => this.#trackMeeting(clientId, meeting, items));
    if (r === 'busy') {
      this.#o.log.info({ clientId, meetingId: meeting.id }, 'client run in flight: meeting deferred');
      throw new MeetingDeferral('client_busy');
    }
    return r;
  }

  async #trackMeeting(clientId: number, meeting: MeetingForTracker, items: MeetingItem[]): Promise<MeetingTrackOutcome> {
    const { db, spend, prices, clock, log } = this.#o;
    const client = await getClient(db, clientId);
    const now = clock.now();
    // Only processed messages: one still queued is the next WhatsApp run's evidence, and that run sees this one's tasks.
    const recent = await listRecentProcessed(db, clientId, 30);
    const reactions = await reactionsFor(db, clientId, recent.map((m) => m.waId));
    const user = buildUserContent({
      client,
      people: await listPeople(db, clientId),
      openTasks: await listTasks(db, clientId, ['open', 'maybe_done']),
      decisions: await listDecisions(db, clientId, 20),
      recent,
      batch: [],
      reactions,
      today: istDate(now),
      mediaText: mediaPromptTexts(await mediaForPrompt(db, [], recent), [], recent),
      meetingLines: meetingItemLines(items, meeting.startedAt, meeting.title),
    });

    const rules = this.#rules({ meeting: true });
    const estimate = estimateCostUsd(MEETING_TRACKER_PROMPT.length + user.length, prices, MAX_OUTPUT_TOKENS);
    const deferral = (): MeetingDeferral =>
      new MeetingDeferral(this.#spendBlocked(clientId, estimate, meeting.id).status === 'busy' ? 'spend_busy' : 'spend_cap');
    if (!spend.canSpend(estimate)) throw deferral();
    let result: { output: AiOutput; invalidOps: number };
    try {
      result = await this.#callWithRetry(MEETING_TRACKER_PROMPT, user, `meeting ${meeting.id}`, estimate);
    } catch (e) {
      if (e instanceof SpendCapReachedError) throw deferral();
      log.warn({ clientId, meetingId: meeting.id, errorCode: errorCodeOf(e) }, 'meeting tracker step failed');
      throw e;
    }
    if (result.invalidOps > 0) log.warn({ clientId, meetingId: meeting.id, invalidOps: result.invalidOps }, 'model returned invalid operations');

    // Every item's evidence time is the meeting's start, so a task a human reopened after it started is not closed.
    const { evidence, messageTs } = this.#evidenceMaps(recent, reactions, { id: meeting.id, items });
    const appliedAt = clock.now();
    let applied: { accepted: AiOp[]; rejected: Rejection[] };
    try {
      applied = await db.tx(async (q) => {
        const fresh = await getClient(q, clientId);
        const state = await this.#validationState(q, fresh, clientId, {
          batchIds: new Set(items.map((it) => it.id)),
          contextIds: new Set(recent.map((m) => m.waId)),
          messageTs,
          editedIds: new Set(),
          source: 'meeting',
        });
        const { accepted, rejected } = validateOps(result.output.ops, state);
        for (const op of accepted) await this.#apply(q, fresh, op, evidence, appliedAt, rules);
        await finishMeeting(q, meeting.id, { at: appliedAt.toISOString() });
        return { accepted, rejected };
      });
    } catch (err) {
      // The transaction rolled back: nothing was applied and the meeting stays at stage doc.
      log.error({ clientId, meetingId: meeting.id, err }, 'applying meeting operations failed');
      throw err;
    }
    for (const r of applied.rejected) log.info({ clientId, meetingId: meeting.id, op: r.op.op, why: r.reason }, 'operation rejected');
    this.#o.onChanged();
    return { status: 'done', accepted: applied.accepted.length, rejected: applied.rejected.length };
  }

  /**
   * The estimate could not be reserved. Paused only when today's spend leaves no room for it. Otherwise holds of paid
   * calls still in flight are in the way and clear within minutes, so the run is busy: Health must not say the cap is
   * reached, and the retry must not wait the hour a pause waits (Task 15 review round 3).
   */
  #spendBlocked(clientId: number, estimate: number, meetingId?: number): { status: 'paused' } | { status: 'busy' } {
    const { spend, log } = this.#o;
    const busy = spend.fitsIgnoringHolds(estimate);
    // A meeting's tracker step logs its meeting id, and a meeting is deferred (MeetingDeferral), never paused. A
    // WhatsApp run's lines stay as they were; its batch id, once there is one, is on the batch row (errorCode spend_*).
    if (meetingId !== undefined) {
      log.info({ clientId, meetingId }, busy ? 'other paid calls in flight: meeting deferred' : 'spend cap: meeting deferred');
    } else {
      log.info({ clientId }, busy ? 'other paid calls in flight: run deferred' : 'spend cap: run paused');
    }
    return busy ? { status: 'busy' } : { status: 'paused' };
  }

  /**
   * The validator's view, read inside the apply transaction: the client, its open tasks, people and replay sources as
   * they are now, plus what this run's AI saw. Shared by WhatsApp and meeting runs.
   */
  async #validationState(
    q: Sql,
    fresh: ClientRow,
    clientId: number,
    run: Pick<ValidationState, 'batchIds' | 'contextIds' | 'messageTs' | 'editedIds' | 'source'>,
  ): Promise<ValidationState> {
    return {
      clientCode: fresh.code,
      phases: fresh.phases,
      phaseLocked: fresh.phaseLocked,
      tasksByCode: new Map((await listTasks(q, clientId, ['open', 'maybe_done'])).map((t) => [t.code, t])),
      batchIds: run.batchIds,
      contextIds: run.contextIds,
      messageTs: run.messageTs,
      peopleByJid: new Map((await listPeople(q, clientId)).map((p) => [p.jid, p])),
      taskSourceIds: await taskSourceIds(q, clientId),
      reminderSourceIds: await reminderSourceIds(q, clientId),
      decisionSourceIds: await decisionSourceIds(q, clientId),
      editedIds: run.editedIds,
      source: run.source,
    };
  }

  /**
   * Evidence by id for #apply, and each id's lock time for the validator (messageTs), from the messages the AI saw and,
   * for a meeting run, its items. A later entry with the same id wins, as before (a batch message over a context one).
   * transcripts: voice note and audio file transcripts by message row id, for the source quote.
   */
  #evidenceMaps(
    messages: readonly MessageRow[],
    reactions: StoredReactionRow[],
    meeting?: { id: number; items: readonly MeetingItem[] },
    transcripts?: ReadonlyMap<number, string>,
  ): { evidence: Map<string, Evidence>; messageTs: Map<string, string> } {
    const evidence = new Map<string, Evidence>(messages.map((m) => [m.waId, messageEvidence(m, reactions, transcripts?.get(m.id))]));
    for (const it of meeting?.items ?? []) evidence.set(it.id, itemEvidence(meeting!.id, it));
    const messageTs = new Map([...evidence].map(([id, e]) => [id, e.lockTs]));
    return { evidence, messageTs };
  }

  /** Every attempt reserves its estimate first, and every outcome settles or releases that reservation. */
  async #callWithRetry(
    system: string, user: string, label: string, estimate: number, opts: { sentiment?: boolean } = {},
  ): Promise<{ output: AiOutput; invalidOps: number }> {
    const { ai, spend } = this.#o;
    for (let attempt = 0; ; attempt++) {
      const rid = spend.reserve(estimate);
      if (rid === null) throw new SpendCapReachedError();
      let r: AiCallResult;
      try {
        r = await ai.reconcile(system, user, opts);
      } catch (e) {
        settleFailedCall(spend, rid, e, estimate, label);
        if (e instanceof AiInvalidOutputError && attempt === 0) continue;
        throw e;
      }
      spend.settle(rid, 'ai', r.costUsd, `${label}${r.fallbackUsed ? ' (fallback)' : ''}`);
      return { output: r.output, invalidOps: r.invalidOps };
    }
  }

  /**
   * The priority an op on an existing task leaves it with, when that is a change. A keyword in the op's own messages only
   * raises the priority after the task was made, and a priority a keyword set is never lowered by the AI's guess. A
   * person's priority (locked) is never changed.
   */
  #priorityChange(t: TaskRow, aiGuess: Priority | null, kw: KeywordMatch | null): { level: Priority; keyword?: string } | null {
    if (t.lockedFields.includes('priority')) return null;
    let next: { level: Priority; keyword?: string } | null = aiGuess === null ? null : { level: aiGuess };
    if (next && t.prioritySource === 'keyword' && t.priority !== null && rank(next.level) > rank(t.priority)) next = null;
    const current = next?.level ?? t.priority;
    if (kw && (current === null || rank(kw.level) < rank(current))) next = { level: kw.level, keyword: kw.keyword };
    return next && next.level !== t.priority ? next : null;
  }

  /** Applies one validated op on the run's transaction handle q. */
  async #apply(q: Sql, client: ClientRow, op: AiOp, evidence: Map<string, Evidence>, at: Date, rules: RunRules): Promise<void> {
    const { db } = this.#o;
    const nowIso = at.toISOString();
    const cited = op.sourceMessageIds.map((id) => evidence.get(id)).filter((e): e is Evidence => e !== undefined);
    // The owner's keywords, in the op's own messages (new and context alike): the most urgent level found, or null.
    const kw = rules.match(cited.map((e) => e.text));
    const sentiment = rules.sentiment ? (op.sentiment ?? null) : null;
    // An op of a meeting run that also cites WhatsApp context is sourced and dated by its first cited meeting item.
    const item = cited.find((e): e is MeetingEvidence => e.kind === 'meeting');
    const sources = item ? [item] : cited.sort((a, b) => a.dateTs.localeCompare(b.dateTs));
    const first = sources[0];
    const last = sources[sources.length - 1];
    // Sender and message id come only from a message: an op sourced by a meeting item has neither.
    const firstMessage = first?.kind === 'message' ? first : undefined;
    const dateOf = (e: Evidence | undefined) => istDate(e ? new Date(e.dateTs) : at);
    // A message re-checked for a new reaction or an edit is evidence from today, not from the day it was first sent. A
    // "file now read" re-check alone is not (amendment 12h): the file is dated like the message that shared it.
    const lastDate = sources.some((e) => e.kind === 'message' && e.recheck) ? istDate(at) : dateOf(last);
    const event = (taskId: number | null, detail: object) =>
      recordEvent(q, { taskId, clientId: client.id, actor: 'ai', op: op.op, detail, reason: op.reason, sourceIds: op.sourceMessageIds, at: nowIso });
    const taskFor = async (code: string | null) => {
      const t = code ? await getTaskByCode(q, code) : undefined;
      if (!t) throw new Error('validated task disappeared'); // cannot happen inside the transaction
      return t;
    };

    switch (op.op) {
      case 'add_task': {
        const t = await createTask(q, {
          clientId: client.id,
          side: op.side!,
          title: op.title!,
          category: op.category!,
          // A keyword in the task's messages wins over the AI's guess.
          priority: kw?.level ?? op.priority!,
          prioritySource: kw ? 'keyword' : 'ai',
          priorityKeyword: kw?.keyword ?? null,
          sentiment,
          assignedTo: op.assignedTo,
          askedBy: op.askedBy ?? firstMessage?.senderName ?? null,
          raisedOn: dateOf(first),
          deadline: op.deadline,
          latestProgress: op.latestProgress,
          sourceQuote: first?.quote ?? null,
          sourceDate: first ? dateOf(first) : null,
          sourceWaId: firstMessage?.waId ?? null,
          origin: item ? 'meeting' : 'whatsapp',
          meetingId: item?.meetingId ?? null,
        }, nowIso);
        if (op.status) await setTaskStatus(q, t.id, op.status, lastDate, nowIso, 'ai');
        await event(t.id, { code: t.code, title: t.title, side: t.side, status: op.status ?? 'open' });
        return;
      }
      case 'update_task': {
        const t = await taskFor(op.taskCode);
        const fields: Partial<Record<TaskField, string | null>> = {};
        for (const f of TASK_FIELDS) {
          const v = op[f];
          if (v !== null && f !== 'priority') fields[f] = v;
        }
        const change = this.#priorityChange(t, op.priority, kw);
        if (change) fields.priority = change.level;
        await updateTaskFields(q, t.id, fields, nowIso, 'ai', change?.keyword);
        if (sentiment) await setTaskSentiment(q, t.id, sentiment, nowIso);
        await event(t.id, sentiment ? { ...fields, sentiment } : fields);
        return;
      }
      case 'close_task': {
        const t = await taskFor(op.taskCode);
        // A task cannot close before it was raised. A file-only re-check dates the close by the day its message was sent
        // (amendment 12h), which can be before the day a later message raised the task. logReminder clamps the same way:
        // the last reminder date never moves back.
        await setTaskStatus(q, t.id, 'done', lastDate < t.raisedOn ? t.raisedOn : lastDate, nowIso, 'ai');
        await event(t.id, { status: 'done' });
        return;
      }
      case 'mark_maybe_done': {
        const t = await taskFor(op.taskCode);
        await setTaskStatus(q, t.id, 'maybe_done', lastDate, nowIso, 'ai');
        await event(t.id, { status: 'maybe_done' });
        return;
      }
      case 'reopen_task': {
        const t = await taskFor(op.taskCode);
        await setTaskStatus(q, t.id, 'open', lastDate, nowIso, 'ai');
        await event(t.id, { status: 'open' });
        return;
      }
      case 'log_reminder': {
        const t = await taskFor(op.taskCode);
        await logReminder(q, t.id, lastDate, nowIso);
        await event(t.id, { reminder: lastDate });
        // A chase with a keyword in it raises the task's priority, as a separate change in its history.
        const change = this.#priorityChange(t, null, kw);
        if (change) {
          await updateTaskFields(q, t.id, { priority: change.level }, nowIso, 'ai', change.keyword);
          await recordEvent(q, {
            taskId: t.id, clientId: client.id, actor: 'ai', op: 'update_task', detail: { priority: change.level }, reason: 'priority keyword',
            sourceIds: op.sourceMessageIds, at: nowIso,
          });
        }
        return;
      }
      case 'add_decision':
        await addDecision(q, {
          clientId: client.id, text: op.text!, decidedOn: dateOf(first), source: item ? 'meeting' : 'whatsapp', sourceWaId: firstMessage?.waId ?? null,
          meetingId: item?.meetingId ?? null,
        }, nowIso);
        await event(null, { decision: op.text });
        return;
      case 'set_phase':
        await setPhase(q, client.id, op.phase!, 'ai');
        await event(null, { phase: op.phase });
        return;
      case 'set_status':
        await setStatus(q, client.id, op.text!, nowIso);
        if (sentiment) await setClientSentiment(q, client.id, sentiment, nowIso);
        await event(null, sentiment ? { status: op.text, sentiment } : { status: op.text });
        return;
      case 'set_person_role':
        await setRole(q, client.id, op.personJid!, op.role!, 'ai');
        await event(null, { personJid: op.personJid, role: op.role });
        return;
    }
  }
}
