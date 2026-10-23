import Anthropic from '@anthropic-ai/sdk';
import type { SpendGuard } from '../spend/spendGuard.ts';
import { estimateCostUsd, type Prices, type TokenUsage } from '../spend/pricing.ts';
import { AiInvalidOutputError, AiRefusalError, billOf, keepConnectTimeoutCode, type Effort } from './claudeClient.ts';
import { buildMeetingPrompt, type MeetingPromptInput } from './meetingPrompt.ts';
import { MEETING_SUMMARY_JSON_SCHEMA, validateSummary, type MeetingSummary } from './meetingSchema.ts';
import { withReservation } from './paidCall.ts';

/** Output allowance for one summary (thinking counts as output). The spend estimate uses the same number. */
export const MEETING_MAX_TOKENS = 16_000;
/**
 * One SDK attempt per call, as for media: a lost connection is booked at the estimate once per attempt, and the summary
 * of a long meeting reserves up to about $1. summarizeMeeting tries once more only after an invalid output.
 */
export const MEETING_SDK_MAX_RETRIES = 0;
/** One attempt of up to 600 s stays well inside the spend reservation's 45-minute lifetime. */
const MEETING_TIMEOUT_MS = 600_000;

export interface MeetingAiResult {
  /** The parsed JSON object, not yet validated (validateSummary). */
  output: unknown;
  usage: TokenUsage;
  /** Dollars for every attempt, fallbacks included. */
  costUsd: number;
  fallbackUsed: boolean;
  model: string;
}

export interface MeetingAi {
  summarize(system: string, user: string): Promise<MeetingAiResult>;
}

/** Claude summarises one meeting transcript as structured output. No tools. The call is never aborted. */
export class ClaudeMeetingClient implements MeetingAi {
  readonly #client: Anthropic;
  readonly #model: string;
  readonly #effort: Effort;
  readonly #prices: Prices;

  constructor(opts: { apiKey: string; model: string; effort?: Effort; prices: Prices; client?: Anthropic }) {
    this.#client =
      opts.client ??
      new Anthropic({ apiKey: opts.apiKey, maxRetries: MEETING_SDK_MAX_RETRIES, timeout: MEETING_TIMEOUT_MS, fetch: keepConnectTimeoutCode });
    this.#model = opts.model;
    this.#effort = opts.effort ?? 'medium';
    this.#prices = opts.prices;
  }

  async summarize(system: string, user: string): Promise<MeetingAiResult> {
    const res = await this.#client.beta.messages.create({
      model: this.#model,
      max_tokens: MEETING_MAX_TOKENS,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: user }],
      output_config: { effort: this.#effort, format: { type: 'json_schema', schema: MEETING_SUMMARY_JSON_SCHEMA } },
    });
    const bill = billOf(res.usage, this.#model, this.#prices);
    if (res.stop_reason === 'refusal') throw new AiRefusalError(res.stop_details?.category ?? null, bill.usage, bill.costUsd);
    if (res.stop_reason === 'max_tokens') throw new AiInvalidOutputError('Output was cut off at max_tokens', bill.usage, bill.costUsd);
    const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    let output: unknown;
    try {
      output = JSON.parse(text);
    } catch {
      output = null;
    }
    if (typeof output !== 'object' || output === null || Array.isArray(output)) {
      throw new AiInvalidOutputError('Model output was not a JSON object', bill.usage, bill.costUsd);
    }
    return { output, usage: bill.usage, costUsd: bill.costUsd, fallbackUsed: bill.fallbackUsed, model: res.model };
  }
}

export interface SummarizeDeps {
  ai: MeetingAi;
  spend: SpendGuard;
  prices: Prices;
}

export interface SummarizeInput extends MeetingPromptInput {
  /** The meetings row id, for the spend label. */
  meetingId: number;
}

export interface SummarizeResult {
  summary: MeetingSummary;
  /** The transcript was cut; the caller stores the note `transcript_cut`. */
  cut: boolean;
  /** Items dropped by validation. */
  dropped: number;
  /** Dollars booked for this summary, a failed first attempt included. */
  costUsd: number;
}

/**
 * Builds the prompt, makes the paid call under a spend reservation (booked as `ai`, label "meeting <id>"), and validates
 * the answer. An invalid output is tried once more, with a second reservation; a second failure, a refusal, a lost
 * connection or SpendCapReachedError is thrown after it was booked.
 */
export async function summarizeMeeting(deps: SummarizeDeps, input: SummarizeInput): Promise<SummarizeResult> {
  const p = buildMeetingPrompt(input);
  const estimate = estimateCostUsd(p.system.length + p.user.length, deps.prices, MEETING_MAX_TOKENS);
  const call = () =>
    withReservation(deps.spend, estimate, `meeting ${input.meetingId}`, () => deps.ai.summarize(p.system, p.user), MEETING_SDK_MAX_RETRIES + 1);
  let failedUsd = 0;
  let r: MeetingAiResult;
  try {
    r = await call();
  } catch (e) {
    if (!(e instanceof AiInvalidOutputError)) throw e;
    failedUsd = e.costUsd ?? estimate; // what settleFailedCall booked
    r = await call();
  }
  const { summary, dropped } = validateSummary(r.output, p.segmentIds, p.names, p.labels);
  return { summary, cut: p.cut, dropped, costUsd: failedUsd + r.costUsd };
}
