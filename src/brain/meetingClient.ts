import Anthropic from '@anthropic-ai/sdk';
import type { SpendGuard } from '../spend/spendGuard.ts';
import { estimateCostUsd, type Prices, type TokenUsage } from '../spend/pricing.ts';
import { isolatedClientOptions } from './anthropicIsolated.ts';
import { AiInvalidOutputError, AiRefusalError, billOf, keepConnectTimeoutCode, type Effort } from './claudeClient.ts';
import { buildMeetingPrompt, type MeetingPromptInput } from './meetingPrompt.ts';
import { MEETING_SUMMARY_JSON_SCHEMA, validateSummary, type MeetingSummary } from './meetingSchema.ts';
import { withReservation } from './paidCall.ts';

/** Output allowance for one summary (thinking counts as output). The spend estimate uses the same number. */
export const MEETING_MAX_TOKENS = 16_000;
/**
 * One SDK attempt per call, as for media: a lost connection is booked at the estimate once per attempt, and the summary
 * of a long meeting reserves up to about $2. summarizeMeeting tries once more only after an invalid output.
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

  /** `isolated`: a customer's client, which no founder environment setting reaches (anthropicIsolated.ts). */
  constructor(opts: { apiKey: string; model: string; effort?: Effort; prices: Prices; client?: Anthropic; isolated?: boolean }) {
    this.#client =
      opts.client ??
      new Anthropic({
        apiKey: opts.apiKey, maxRetries: MEETING_SDK_MAX_RETRIES, timeout: MEETING_TIMEOUT_MS, fetch: keepConnectTimeoutCode,
        ...(opts.isolated ? isolatedClientOptions(opts.apiKey, keepConnectTimeoutCode) : {}),
      });
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

/** Devanagari letters and signs. Each is about one token; other text, mostly English letters, about half a token. */
const DEVANAGARI = /[\u0900-\u097F]/g;

/** Input tokens a meeting prompt may use: Devanagari at about 1 per character, everything else at about 0.5. */
export function estimateMeetingTokens(text: string): number {
  const devanagari = text.match(DEVANAGARI)?.length ?? 0;
  return devanagari + Math.ceil((text.length - devanagari) / 2);
}

/** The spend ceiling for one summary call: the prompt's tokens and a full MEETING_MAX_TOKENS answer. */
export function meetingEstimateUsd(system: string, user: string, prices: Prices): number {
  // estimateCostUsd counts 2 characters per token, so it is given twice the token estimate.
  return estimateCostUsd(2 * (estimateMeetingTokens(system) + estimateMeetingTokens(user)), prices, MEETING_MAX_TOKENS);
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
  /**
   * 'no_lines': no transcript line could be sent (no segments, or the first one alone is over the limit), so Claude was
   * not called; summary is empty and nothing was booked. null for a real summary.
   */
  skipped: 'no_lines' | null;
  /** The transcript was cut; the caller stores the note `transcript_cut`. */
  cut: boolean;
  /** Items dropped by validation. */
  dropped: number;
  /** Dollars booked for this summary, a failed first attempt included. */
  costUsd: number;
  /** Of the call that gave the summary; null when skipped. */
  model: string | null;
  fallbackUsed: boolean;
  /** Tokens of the call that gave the summary (a failed first attempt is not included); zero when skipped. */
  usage: TokenUsage;
}

const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

export function emptySummary(): MeetingSummary {
  return { whatHappened: '', discussion: [], decisions: [], actionItems: [], openQuestions: [], conclusion: '', speakers: [] };
}

/**
 * Builds the prompt, makes the paid call under a spend reservation (booked as `ai`, label "meeting <id>"), and validates
 * the answer.
 * - No transcript line to send: returns `skipped: 'no_lines'` without calling Claude.
 * - An invalid output, or one whose whatHappened is empty after validation, is booked at that call's cost and tried
 *   once more with a second reservation. A blank summary never comes back.
 * - A second failure, a refusal, a lost connection or SpendCapReachedError is thrown after it was booked.
 */
export async function summarizeMeeting(deps: SummarizeDeps, input: SummarizeInput): Promise<SummarizeResult> {
  const p = buildMeetingPrompt(input);
  if (p.segmentIds.length === 0) {
    return { summary: emptySummary(), skipped: 'no_lines', cut: p.cut, dropped: 0, costUsd: 0, model: null, fallbackUsed: false, usage: { ...ZERO_USAGE } };
  }
  const estimate = meetingEstimateUsd(p.system, p.user, deps.prices);
  let failedUsd = 0;
  const call = () =>
    withReservation(
      deps.spend,
      estimate,
      `meeting ${input.meetingId}`,
      async () => {
        const r = await deps.ai.summarize(p.system, p.user);
        const v = validateSummary(r.output, p.segmentIds, p.names, p.labels);
        if (!v.summary.whatHappened) throw new AiInvalidOutputError('Summary was empty after validation', r.usage, r.costUsd);
        return { ...r, ...v };
      },
      MEETING_SDK_MAX_RETRIES + 1,
      (usd) => {
        failedUsd += usd;
      },
    );
  let r: Awaited<ReturnType<typeof call>>;
  try {
    r = await call();
  } catch (e) {
    if (!(e instanceof AiInvalidOutputError)) throw e;
    r = await call();
  }
  return {
    summary: r.summary,
    skipped: null,
    cut: p.cut,
    dropped: r.dropped,
    costUsd: failedUsd + r.costUsd,
    model: r.model,
    fallbackUsed: r.fallbackUsed,
    usage: r.usage,
  };
}
