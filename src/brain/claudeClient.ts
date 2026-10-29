import Anthropic from '@anthropic-ai/sdk';
import type { BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { FALLBACK_PRICES, costUsd, type Prices, type TokenUsage } from '../spend/pricing.ts';
import { AI_OUTPUT_JSON_SCHEMA, AI_OUTPUT_JSON_SCHEMA_WITH_SENTIMENT, AiOutputParseError, parseAiOutput, type AiOutput } from './schema.ts';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Output allowance per call (thinking counts as output). The spend estimate uses the same number. */
export const MAX_OUTPUT_TOKENS = 16_000;
/** The SDK retries timeouts and connection errors on its own; each attempt may be billed. */
export const SDK_MAX_RETRIES = 2;

/**
 * The `fetch` the Anthropic clients use. When undici's connect timer fires, the request never left this machine, but
 * the SDK sees "Timeout" in the error text and throws APIConnectionTimeoutError with no cause, which settleFailedCall
 * books at the estimate. This throws it again as a plain fetch failure that keeps only the code, so the SDK throws
 * APIConnectionError with the code among its causes and the reservation is released. Every other error passes
 * through unchanged, so a timeout after sending (an AbortError) is still booked.
 */
export async function keepConnectTimeoutCode(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (e) {
    if ((e as { cause?: { code?: unknown } | null } | null | undefined)?.cause?.code === 'UND_ERR_CONNECT_TIMEOUT') {
      throw new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
    }
    throw e;
  }
}

export interface AiCallResult {
  output: AiOutput;
  /** Summed over every attempt, fallbacks included. */
  usage: TokenUsage;
  /** Dollars for every attempt, fallbacks priced at FALLBACK_PRICES. */
  costUsd: number;
  fallbackUsed: boolean;
  model: string;
  /** Operations that did not match the schema and were dropped. */
  invalidOps: number;
}

/** sentiment: ask for each operation's sentiment too (the switch on the dashboard's Settings screen). */
export interface ReconcileOptions {
  sentiment?: boolean;
}

export interface AiClient {
  reconcile(system: string, user: string, opts?: ReconcileOptions): Promise<AiCallResult>;
}

export class AiRefusalError extends Error {
  readonly category: string | null;
  readonly usage: TokenUsage;
  readonly costUsd: number | null;
  constructor(category: string | null, usage: TokenUsage, costUsd: number | null = null) {
    super('The model declined this batch');
    this.name = 'AiRefusalError';
    this.category = category;
    this.usage = usage;
    this.costUsd = costUsd;
  }
}

export class AiInvalidOutputError extends Error {
  readonly usage: TokenUsage | null;
  readonly costUsd: number | null;
  constructor(reason: string, usage: TokenUsage | null, costUsd: number | null = null) {
    super(reason);
    this.name = 'AiInvalidOutputError';
    this.usage = usage;
    this.costUsd = costUsd;
  }
}

const ZERO: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

/** Bills every attempt listed in usage.iterations (server-side fallback can run more than one model). */
export function billOf(
  u: BetaUsage,
  requestedModel: string,
  prices: Prices,
): { usage: TokenUsage; costUsd: number; fallbackUsed: boolean } {
  if (Array.isArray(u.iterations) && u.iterations.length > 0) {
    const total: TokenUsage = { ...ZERO };
    let cost = 0;
    let fallbackUsed = false;
    for (const it of u.iterations) {
      const usage: TokenUsage = {
        inputTokens: it.input_tokens ?? 0,
        outputTokens: it.output_tokens ?? 0,
        cacheCreationInputTokens: it.cache_creation_input_tokens ?? 0,
        cacheReadInputTokens: it.cache_read_input_tokens ?? 0,
      };
      const model = 'model' in it ? it.model : null;
      const isFallback = it.type === 'fallback_message' || (typeof model === 'string' && !model.startsWith(requestedModel));
      if (isFallback) fallbackUsed = true;
      cost += costUsd(usage, isFallback ? FALLBACK_PRICES : prices);
      total.inputTokens += usage.inputTokens;
      total.outputTokens += usage.outputTokens;
      total.cacheCreationInputTokens += usage.cacheCreationInputTokens;
      total.cacheReadInputTokens += usage.cacheReadInputTokens;
    }
    return { usage: total, costUsd: cost, fallbackUsed };
  }
  const usage: TokenUsage = {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
  };
  return { usage, costUsd: costUsd(usage, prices), fallbackUsed: false };
}

export class ClaudeClient implements AiClient {
  readonly #client: Anthropic;
  readonly #model: string;
  readonly #effort: Effort;
  readonly #prices: Prices;

  constructor(opts: { apiKey: string; model: string; effort?: Effort; prices: Prices; client?: Anthropic }) {
    this.#client =
      opts.client ??
      new Anthropic({ apiKey: opts.apiKey, maxRetries: SDK_MAX_RETRIES, timeout: 600_000, fetch: keepConnectTimeoutCode });
    this.#model = opts.model;
    this.#effort = opts.effort ?? 'medium';
    this.#prices = opts.prices;
  }

  async reconcile(system: string, user: string, opts: ReconcileOptions = {}): Promise<AiCallResult> {
    const schema = opts.sentiment ? AI_OUTPUT_JSON_SCHEMA_WITH_SENTIMENT : AI_OUTPUT_JSON_SCHEMA;
    const res = await this.#client.beta.messages.create({
      model: this.#model,
      max_tokens: MAX_OUTPUT_TOKENS,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: user }],
      output_config: { effort: this.#effort, format: { type: 'json_schema', schema } },
    });
    const bill = billOf(res.usage, this.#model, this.#prices);
    if (res.stop_reason === 'refusal') {
      throw new AiRefusalError(res.stop_details?.category ?? null, bill.usage, bill.costUsd);
    }
    if (res.stop_reason === 'max_tokens') {
      throw new AiInvalidOutputError('Output was cut off at max_tokens', bill.usage, bill.costUsd);
    }
    const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    try {
      const { output, invalidOps } = parseAiOutput(text, { sentiment: opts.sentiment === true });
      return { output, usage: bill.usage, costUsd: bill.costUsd, fallbackUsed: bill.fallbackUsed, model: res.model, invalidOps };
    } catch (e) {
      if (e instanceof AiOutputParseError) {
        throw new AiInvalidOutputError('Model output was not valid JSON', bill.usage, bill.costUsd);
      }
      throw e;
    }
  }
}
