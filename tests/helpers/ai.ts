import type { AiCallResult, AiClient, ReconcileOptions } from '../../src/brain/claudeClient.ts';
import type { AiOp, AiOutput } from '../../src/brain/schema.ts';

/** A complete AI operation with every unused field null. */
export function op(p: Partial<AiOp> & Pick<AiOp, 'op' | 'sourceMessageIds'>): AiOp {
  return {
    taskCode: null, side: null, title: null, category: null, priority: null, assignedTo: null, askedBy: null, deadline: null,
    latestProgress: null, status: null, text: null, phase: null, personJid: null, role: null, reason: 'test', ...p,
  };
}

export const FAKE_USAGE = { inputTokens: 1000, outputTokens: 200, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

/** A queued answer that overrides the defaults (invalidOps 0, costUsd 0.01, fallbackUsed false). */
export interface FakeResult {
  output: AiOutput;
  invalidOps?: number;
  costUsd?: number;
  fallbackUsed?: boolean;
}

export type FakeResponse = AiOutput | FakeResult | Error;

/** Returns queued responses in order; an Error in the queue is thrown. Empty queue = no changes. */
export class FakeAi implements AiClient {
  readonly calls: { system: string; user: string }[] = [];
  /** Each call's options, in the same order as calls (kept apart so calls stays { system, user }). */
  readonly options: (ReconcileOptions | undefined)[] = [];
  /** When set, each call waits for this promise before answering (for concurrency tests). */
  gate: Promise<unknown> | null = null;
  readonly #responses: FakeResponse[];

  constructor(responses: FakeResponse[] = []) {
    this.#responses = [...responses];
  }

  push(...responses: FakeResponse[]): void {
    this.#responses.push(...responses);
  }

  async reconcile(system: string, user: string, opts?: ReconcileOptions): Promise<AiCallResult> {
    this.calls.push({ system, user });
    this.options.push(opts);
    if (this.gate) await this.gate;
    const next = this.#responses.shift() ?? { ops: [] };
    if (next instanceof Error) throw next;
    const r: FakeResult = 'output' in next ? next : { output: next };
    return {
      output: r.output,
      usage: FAKE_USAGE,
      costUsd: r.costUsd ?? 0.01,
      fallbackUsed: r.fallbackUsed ?? false,
      model: 'fake',
      invalidOps: r.invalidOps ?? 0,
    };
  }
}
