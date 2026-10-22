import { costUsd, modelFor } from '../prices.ts';
import { formatClock } from '../segments.ts';
import type { ProviderId } from '../types.ts';
import type { SlotState } from './ledger.ts';
import type { Sample } from './samples.ts';

/** send: a new paid request. resume: wait on a saved provider job (no new charge). skip: nothing. */
export type Action = 'send' | 'resume' | 'skip';

export interface PlanItem {
  sample: Sample;
  /** Length of the original recording. */
  seconds: number;
  provider: ProviderId;
  model: string;
  diarize: boolean;
  parts: number;
  state: SlotState;
  action: Action;
  /** List-price estimate of what this run would send; 0 for skips and resumed jobs. */
  estimateUsd: number;
}

export interface PlanInput {
  samples: readonly { sample: Sample; seconds: number }[];
  providers: readonly { id: ProviderId; maxPartSeconds: number }[];
  stateOf: (sampleId: string, provider: ProviderId) => SlotState;
  /**
   * True when going on with an unanswered slot is free: every part n < parts has a saved provider job id to wait on or
   * a saved answer. Otherwise it is a new send, estimated in full.
   */
  canResume: (sampleId: string, provider: ProviderId, parts: number) => boolean;
  retryFailed: boolean;
  retryUnknown: boolean;
  inrPerUsd: number;
}

function actionFor(state: SlotState, input: PlanInput, sampleId: string, provider: ProviderId, parts: number): Action {
  if (state === 'new' || (state === 'failed' && input.retryFailed)) return 'send';
  if (state === 'unknown' && input.retryUnknown) return input.canResume(sampleId, provider, parts) ? 'resume' : 'send';
  return 'skip';
}

/** One item per sample and provider, in sample order. Meetings are sent with speaker labels on. */
export function buildPlan(input: PlanInput): PlanItem[] {
  const items: PlanItem[] = [];
  for (const { sample, seconds } of input.samples) {
    for (const p of input.providers) {
      const diarize = sample.kind === 'meeting';
      const price = modelFor(p.id, diarize);
      const state = input.stateOf(sample.id, p.id);
      const parts = Math.max(1, Math.ceil(seconds / p.maxPartSeconds));
      const action = actionFor(state, input, sample.id, p.id, parts);
      items.push({
        sample,
        seconds,
        provider: p.id,
        model: price.model,
        diarize,
        parts,
        state,
        action,
        estimateUsd: action === 'send' ? costUsd(price, seconds, input.inrPerUsd) : 0,
      });
    }
  }
  return items;
}

export function planTotalUsd(items: readonly PlanItem[]): number {
  return items.reduce((sum, i) => sum + i.estimateUsd, 0);
}

function actionText(i: PlanItem): string {
  if (i.action === 'skip') return `skip (${i.state})`;
  if (i.action === 'resume') return 'wait for the saved job (no new charge)';
  return i.state === 'unknown' ? 'send again (an earlier attempt may already be billed)' : 'send';
}

/** The dry-run listing: one line per sample and provider, then the files and the total. Never any content. */
export function formatPlan(items: readonly PlanItem[]): string {
  const lines = items.map((i) => {
    const parts = i.parts > 1 ? ` in ${i.parts} parts` : '';
    return `  ${i.sample.id.padEnd(34)} ${formatClock(i.seconds).padStart(8)}  ${i.provider.padEnd(10)} ${i.model}${parts}  $${i.estimateUsd.toFixed(3)}  ${actionText(i)}`;
  });
  const files = [...new Set(items.filter((i) => i.action !== 'skip').map((i) => i.sample.path))];
  const total = planTotalUsd(items);
  return [
    ...lines,
    '',
    `Files whose audio would be uploaded (${files.length}):`,
    ...files.map((f) => `  ${f}`),
    '',
    // Three decimals below $1, so a run of a few voice notes never shows as $0.00.
    `Estimated cost: $${total.toFixed(total < 1 ? 3 : 2)} at list prices.`,
  ].join('\n');
}
