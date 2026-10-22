import { AudioError } from '../audio.ts';
import { SttHttpError, SttJobError, SttNoAnswerError } from '../http.ts';
import { costUsd, modelFor } from '../prices.ts';
import { formatClock, mergeParts } from '../segments.ts';
import type { AudioPart, ProviderId, ProviderResult, SttProvider } from '../types.ts';
import { LedgerError, type Ledger, type Outcome } from './ledger.ts';
import type { PlanItem } from './plan.ts';

export interface RunDeps {
  providers: ReadonlyMap<ProviderId, SttProvider>;
  ledger: Ledger;
  /** The sample's prepared MP3, cut into parts of at most maxSeconds. Local work, no cost. */
  partsFor: (item: PlanItem, maxSeconds: number) => Promise<AudioPart[]>;
  inrPerUsd: number;
  maxUsd: number;
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
}

/** Statuses that show the key or account cannot be used: that provider gets nothing more in this run. */
const ACCOUNT_REFUSED = new Set([401, 402, 403]);

type SlotResult =
  | { kind: 'done'; outcome: Outcome }
  | { kind: 'failed'; outcome: Outcome; status: number | null; sentSeconds: number }
  | { kind: 'unknown'; code: string; sentSeconds: number };

/**
 * Sends the plan one slot at a time. No paid request is retried here. Before each slot the cap is checked against what
 * this run has spent plus the slot's estimate. Lines logged carry ids, durations, costs and codes, never transcript text.
 */
export async function runPlan(items: readonly PlanItem[], deps: RunDeps): Promise<RunSummary> {
  const now = deps.now ?? Date.now;
  const refused = new Set<ProviderId>();
  const sum: RunSummary = { spentUsd: 0, done: 0, failed: 0, unknown: 0, skipped: 0, stoppedAtCap: false };
  for (const item of items) {
    if (item.action === 'skip') continue;
    const label = `${item.sample.id} ${item.provider}`;
    if (refused.has(item.provider)) {
      sum.skipped++;
      deps.log(`skip     ${label}: the provider refused the key earlier in this run`);
      continue;
    }
    if (sum.spentUsd + item.estimateUsd > deps.maxUsd) {
      sum.stoppedAtCap = true;
      deps.log(`stopped  the next file would pass the $${deps.maxUsd.toFixed(2)} cap; nothing more was sent`);
      break;
    }
    const provider = deps.providers.get(item.provider);
    if (!provider) throw new Error(`No provider set up for ${item.provider}`);
    deps.log(`send     ${label} (${formatClock(item.seconds)}${item.parts > 1 ? `, ${item.parts} parts` : ''})`);
    const r = await runSlot(item, provider, deps, now);
    const price = modelFor(item.provider, item.diarize);
    if (r.kind === 'done') {
      sum.done++;
      sum.spentUsd += r.outcome.costUsd;
      deps.log(`done     ${label} in ${r.outcome.processingSeconds.toFixed(1)} s, about $${r.outcome.costUsd.toFixed(3)}`);
    } else if (r.kind === 'failed') {
      sum.failed++;
      sum.spentUsd += costUsd(price, r.sentSeconds, deps.inrPerUsd);
      if (r.status !== null && ACCOUNT_REFUSED.has(r.status)) refused.add(item.provider);
      deps.log(`failed   ${label}: ${r.outcome.error ?? 'error'}`);
    } else {
      sum.unknown++;
      // Counted as spent: the provider may have done and billed the work.
      sum.spentUsd += costUsd(price, r.sentSeconds, deps.inrPerUsd);
      deps.log(`unknown  ${label}: no answer (${r.code}). Not sent again; check the provider's dashboard, then use --retry-unknown.`);
    }
  }
  return sum;
}

async function runSlot(item: PlanItem, provider: SttProvider, deps: RunDeps, now: () => number): Promise<SlotResult> {
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
  const failed = (error: string, status: number | null, sentSeconds: number): SlotResult => {
    const outcome: Outcome = { ...base, status: 'failed', processingSeconds: (now() - started) / 1000, error, finishedAt: new Date(now()).toISOString() };
    ledger.finish(outcome);
    return { kind: 'failed', outcome, status, sentSeconds };
  };

  if (item.state === 'failed') ledger.reopen(sample.id, item.provider);
  let parts: AudioPart[];
  try {
    parts = await deps.partsFor(item, provider.maxPartSeconds);
  } catch (e) {
    return failed(e instanceof AudioError ? `audio_${e.code}` : 'audio_error', null, 0);
  }
  // An unanswered slot keeps its attempt, with any saved job ids; anything else starts a fresh one.
  if (item.state !== 'unknown' || !ledger.attempt(sample.id, item.provider)) {
    ledger.begin({ sampleId: sample.id, provider: item.provider, model: item.model, startedAt: new Date(now()).toISOString(), jobIds: {} });
  }
  const jobIds = ledger.attempt(sample.id, item.provider)?.jobIds ?? {};
  // Every saved answer is checked against today's cut before anything is sent, so a mismatch sends nothing at all.
  let cached: (ProviderResult | null)[];
  try {
    cached = parts.map((part, n) => ledger.part(sample.id, item.provider, n, part));
  } catch (e) {
    if (e instanceof LedgerError && e.code === 'part_cache_mismatch') return { kind: 'unknown', code: e.code, sentSeconds: 0 };
    throw e;
  }
  let sentSeconds = 0;
  try {
    const results: ProviderResult[] = [];
    for (const [n, part] of parts.entries()) {
      const saved = cached[n];
      if (saved) {
        results.push(saved);
        continue;
      }
      const resumeJobId = jobIds[String(n)];
      if (!resumeJobId) sentSeconds += part.seconds;
      const result = await provider.transcribe(part, {
        diarize: item.diarize,
        resumeJobId,
        onJobId: (id) => ledger.saveJobId(sample.id, item.provider, n, id),
      });
      ledger.savePart(sample.id, item.provider, n, part, result);
      results.push(result);
    }
    const billed = results.every((r) => r.billedSeconds !== null) ? results.reduce((t, r) => t + (r.billedSeconds ?? 0), 0) : null;
    const outcome: Outcome = {
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
    return { kind: 'done', outcome };
  } catch (e) {
    if (e instanceof SttHttpError) return failed(`http_${e.status}${e.detail ? ` ${e.detail}` : ''}`, e.status, sentSeconds);
    if (e instanceof SttJobError) return failed(`job_${e.code}`, null, sentSeconds);
    return { kind: 'unknown', code: e instanceof SttNoAnswerError ? e.code : e instanceof Error ? e.name : 'error', sentSeconds };
  }
}
