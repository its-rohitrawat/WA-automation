import { AudioError } from '../audio.ts';
import { SttHttpError, SttJobError, SttJobLostError, SttNoAnswerError } from '../http.ts';
import { costUsd, modelFor } from '../prices.ts';
import { formatClock, mergeParts } from '../segments.ts';
import type { AudioPart, ProviderId, ProviderResult, SttProvider } from '../types.ts';
import { LedgerError, type Attempt, type Ledger, type Outcome } from './ledger.ts';
import type { PlanItem } from './plan.ts';

export interface RunDeps {
  providers: ReadonlyMap<ProviderId, SttProvider>;
  ledger: Ledger;
  /** The sample's prepared MP3, cut into parts of at most maxSeconds. Local work, no cost. */
  partsFor: (item: PlanItem, maxSeconds: number) => Promise<AudioPart[]>;
  inrPerUsd: number;
  maxUsd: number;
  /** Delete the provider's own stored copy of each answer once it is saved here (providers that offer forget). */
  forgetRemote: boolean;
  log: (line: string) => void;
  now?: () => number;
}

export interface RunSummary {
  spentUsd: number;
  done: number;
  failed: number;
  unknown: number;
  skipped: number;
  stoppedAtCap: boolean;
  /** Slots still to be sent when the cap stopped the run. */
  unsent: number;
}

/**
 * Statuses that show the key or account cannot be used: that provider gets nothing more in this run. 429 is one: OpenAI
 * answers it for an empty balance (insufficient_quota) as well as for rate limits, and nothing is retried anyway.
 */
const ACCOUNT_REFUSED = new Set([401, 402, 403, 429]);

type SlotResult =
  | { kind: 'done'; outcome: Outcome }
  | { kind: 'failed'; error: string; status: number | null; sentSeconds: number }
  | { kind: 'unknown'; code: string; sentSeconds: number };

/** A short code for a log line. Never the error's message: it can carry provider text. */
function codeOf(e: unknown): string {
  if (e instanceof SttHttpError) return `http_${e.status}`;
  if (e instanceof SttNoAnswerError || e instanceof SttJobError || e instanceof LedgerError || e instanceof AudioError) return e.code;
  return e instanceof Error ? e.name : 'error';
}

/**
 * Sends the plan one slot at a time. No paid request is retried here. Before each slot the cap is checked against what
 * this run has spent plus the slot's estimate. Lines logged carry ids, durations, costs and codes, never transcript text.
 * A LedgerError stops the whole run: without a record on disk, going on could pay twice.
 */
export async function runPlan(items: readonly PlanItem[], deps: RunDeps): Promise<RunSummary> {
  const now = deps.now ?? Date.now;
  const refused = new Set<ProviderId>();
  const sum: RunSummary = { spentUsd: 0, done: 0, failed: 0, unknown: 0, skipped: 0, stoppedAtCap: false, unsent: 0 };
  for (const [index, item] of items.entries()) {
    if (item.action === 'skip') continue;
    const label = `${item.sample.id} ${item.provider}`;
    if (refused.has(item.provider)) {
      sum.skipped++;
      deps.log(`skip     ${label}: the provider refused the key or account earlier in this run`);
      continue;
    }
    // The plan may be out of date (another run, or files moved by hand): a slot is acted on only in the state it was planned in.
    const state = deps.ledger.state(item.sample.id, item.provider);
    if (state !== item.state) {
      sum.skipped++;
      deps.log(`skip     ${label}: its state is now ${state}; make a new plan`);
      continue;
    }
    if (sum.spentUsd + item.estimateUsd > deps.maxUsd) {
      sum.stoppedAtCap = true;
      sum.unsent = items.slice(index).filter((i) => i.action !== 'skip' && !refused.has(i.provider)).length;
      deps.log(`stopped  the next file would pass the $${deps.maxUsd.toFixed(2)} cap; nothing more was sent`);
      break;
    }
    const provider = deps.providers.get(item.provider);
    if (!provider) throw new Error(`No provider set up for ${item.provider}`);
    deps.log(`send     ${label} (${formatClock(item.seconds)}${item.parts > 1 ? `, ${item.parts} parts` : ''})`);
    const r = await runSlot(item, provider, deps, now, label);
    const price = modelFor(item.provider, item.diarize);
    if (r.kind === 'done') {
      sum.done++;
      sum.spentUsd += r.outcome.costUsd;
      deps.log(`done     ${label} in ${r.outcome.processingSeconds.toFixed(1)} s, about $${r.outcome.costUsd.toFixed(3)}`);
    } else if (r.kind === 'failed') {
      sum.failed++;
      sum.spentUsd += costUsd(price, r.sentSeconds, deps.inrPerUsd);
      if (r.status !== null && ACCOUNT_REFUSED.has(r.status)) refused.add(item.provider);
      deps.log(`failed   ${label}: ${r.error}`);
    } else {
      sum.unknown++;
      // Counted as spent: the provider may have done and billed the work.
      sum.spentUsd += costUsd(price, r.sentSeconds, deps.inrPerUsd);
      deps.log(`unknown  ${label}: no answer (${r.code}). Not sent again; check the provider's dashboard, then use --retry-unknown.`);
    }
  }
  return sum;
}

async function runSlot(item: PlanItem, provider: SttProvider, deps: RunDeps, now: () => number, label: string): Promise<SlotResult> {
  const { ledger } = deps;
  const { sample } = item;
  const started = now();
  const base: Omit<Outcome, 'status' | 'processingSeconds' | 'error' | 'finishedAt'> = {
    sampleId: sample.id,
    kind: sample.kind,
    provider: item.provider,
    model: item.model,
    audioSeconds: item.seconds,
    billedSeconds: null,
    costUsd: 0,
    parts: item.parts,
    segments: [],
  };
  const failedOutcome = (error: string): Outcome => ({
    ...base, status: 'failed', processingSeconds: (now() - started) / 1000, error, finishedAt: new Date(now()).toISOString(),
  });
  const failed = (error: string, status: number | null, sentSeconds: number): SlotResult => {
    ledger.finish(failedOutcome(error));
    return { kind: 'failed', error, status, sentSeconds };
  };
  /** Nothing is sent and the slot's record is left exactly as it was: still failed, unknown or new. */
  const unchanged = (code: string): SlotResult =>
    item.state === 'failed' ? { kind: 'failed', error: code, status: null, sentSeconds: 0 } : { kind: 'unknown', code, sentSeconds: 0 };
  /** The audio could not be cut, so nothing is sent for this slot in this run. */
  const noAudio = (code: string): SlotResult => {
    // An unanswered slot may already be billed: it stays unknown, with its attempt and job ids.
    if (item.state === 'unknown') return { kind: 'unknown', code, sentSeconds: 0 };
    // A failed slot gets the new failure, with the earlier one kept aside on disk; it reads failed throughout.
    if (item.state === 'failed') ledger.replaceFailed(failedOutcome(code));
    else ledger.finish(failedOutcome(code));
    return { kind: 'failed', error: code, status: null, sentSeconds: 0 };
  };

  // Local work and checks first, so a slot whose audio cannot be cut, or whose saved answers do not fit the cut, keeps
  // its record as it was until something is really sent.
  let parts: AudioPart[];
  try {
    parts = await deps.partsFor(item, provider.maxPartSeconds);
  } catch (e) {
    return noAudio(e instanceof AudioError ? `audio_${e.code}` : 'audio_error');
  }
  if (parts.length === 0) return noAudio('audio_no_parts');
  // Every saved answer is checked against today's cut before anything is written or sent: a mismatch changes nothing.
  let cached: (ProviderResult | null)[];
  try {
    cached = parts.map((part, n) => ledger.part(sample.id, item.provider, n, part));
  } catch (e) {
    if (e instanceof LedgerError && e.code === 'part_cache_mismatch') return unchanged(e.code);
    throw e;
  }
  // An unanswered slot keeps its attempt, with any saved job ids; anything else starts a fresh one.
  const kept = item.state === 'unknown' ? ledger.attempt(sample.id, item.provider) : null;
  const jobIds = kept?.jobIds ?? {};
  // The plan promised a free resume. If a part would need a new paid request after all, send nothing and say so.
  if (item.action === 'resume' && parts.some((_p, n) => !cached[n] && !jobIds[String(n)])) {
    return { kind: 'unknown', code: 'resume_part_without_job', sentSeconds: 0 };
  }
  if (!kept) {
    const attempt: Attempt = { sampleId: sample.id, provider: item.provider, model: item.model, startedAt: new Date(now()).toISOString(), jobIds: {}, sends: [] };
    // A failed slot is reopened in an order that never lets it read "new" part way (see Ledger.reopen).
    if (item.state === 'failed') ledger.reopen(attempt);
    else ledger.begin(attempt);
  }
  let sentSeconds = 0;
  /** The part whose request is in flight, so a lost job's id can be dropped. */
  let sending = -1;
  /** Answers received in this run, each already saved here. */
  const fresh: ProviderResult[] = [];
  /**
   * Deletes the provider's own copy of each fresh answer, once the slot's record is final: a slow or hanging delete
   * must never hold up the outcome. Warnings only; the answer is safe here, only the provider's copy stays.
   */
  const forgetFresh = async (): Promise<void> => {
    if (!deps.forgetRemote || !provider.forget) return;
    for (const result of fresh) {
      try {
        await provider.forget(result);
      } catch (e) {
        deps.log(`warning  ${label}: could not delete the provider's stored copy (${codeOf(e)})`);
      }
    }
  };
  /** The slot's result for an error from the provider, with its record written. */
  const settle = (e: unknown): SlotResult => {
    if (e instanceof SttJobLostError) {
      // Started, so maybe billed: unknown. Its id is dropped (kept aside as evidence), so the next plan cannot offer a
      // free wait on a job that is gone and shows a new, paid send with its warning instead.
      if (sending >= 0) ledger.dropJobId(sample.id, item.provider, sending);
      return { kind: 'unknown', code: e.code, sentSeconds };
    }
    if (e instanceof SttHttpError) return failed(`http_${e.status}${e.detail ? ` ${e.detail}` : ''}`, e.status, sentSeconds);
    if (e instanceof SttJobError) return failed(`job_${e.code}`, null, sentSeconds);
    return { kind: 'unknown', code: e instanceof SttNoAnswerError ? e.code : e instanceof Error ? e.name : 'error', sentSeconds };
  };
  let outcome: Outcome;
  try {
    const results: ProviderResult[] = [];
    for (const [n, part] of parts.entries()) {
      const saved = cached[n];
      if (saved) {
        results.push(saved);
        continue;
      }
      sending = n;
      const resumeJobId = jobIds[String(n)];
      if (!resumeJobId) {
        // On disk before the paid request leaves, so the attempt lists every send even when its answer is lost.
        ledger.noteSend(sample.id, item.provider, new Date(now()).toISOString());
        sentSeconds += part.seconds;
      }
      const result = await provider.transcribe(part, {
        diarize: item.diarize,
        resumeJobId,
        onJobId: (id) => {
          try {
            ledger.saveJobId(sample.id, item.provider, n, id);
          } catch (e) {
            // The job is accepted and will be billed; giving up now would only lose its answer. Without the saved id a
            // lost answer cannot be fetched for free later, and the next plan shows that slot as a new send.
            deps.log(`warning  ${label}: could not save the job id (${codeOf(e)}); still waiting`);
          }
        },
      });
      ledger.savePart(sample.id, item.provider, n, part, result);
      results.push(result);
      fresh.push(result);
    }
    const billed = results.every((r) => r.billedSeconds !== null) ? results.reduce((t, r) => t + (r.billedSeconds ?? 0), 0) : null;
    outcome = {
      ...base,
      parts: parts.length,
      status: 'done',
      billedSeconds: billed,
      costUsd: costUsd(modelFor(item.provider, item.diarize), billed ?? item.seconds, deps.inrPerUsd),
      processingSeconds: (now() - started) / 1000,
      error: null,
      segments: mergeParts(parts.map((p, i) => ({ offset: p.offset, segments: results[i]!.segments }))),
      finishedAt: new Date(now()).toISOString(),
    };
    ledger.finish(outcome);
  } catch (e) {
    // The ledger is what stops a second payment; when it cannot be written, the run stops (the slot stays unknown on disk).
    if (e instanceof LedgerError) throw e;
    const r = settle(e);
    await forgetFresh();
    return r;
  }
  // Outside the try: nothing that happens now may turn the recorded outcome into a failure.
  await forgetFresh();
  return { kind: 'done', outcome };
}
