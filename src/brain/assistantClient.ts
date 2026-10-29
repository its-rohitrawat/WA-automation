import Anthropic from '@anthropic-ai/sdk';
import { ASSISTANT_MAX_TOKENS, type AssistantAi, type AssistantMessage, type AssistantTurn } from '../assistant/assistant.ts';
import type { Prices } from '../spend/pricing.ts';
import { billOf, keepConnectTimeoutCode, type Effort } from './claudeClient.ts';

/** One retry: a question is interactive, and each attempt of a lost connection is booked at the estimate. */
export const ASSISTANT_SDK_MAX_RETRIES = 1;
/** One call should answer within two minutes; the owner is waiting. */
const ASSISTANT_TIMEOUT_MS = 120_000;

/**
 * The dashboard assistant's Claude calls: streamed (the panel shows the answer as it comes), with the read and propose
 * tools, the system prompt cached, model and effort from AI_MODEL and AI_EFFORT, and the server-side fallback as the
 * agent's other calls. Tool inputs are small and arrive whole (no eager input streaming), and every one is checked
 * against its schema before it runs (src/assistant/tools.ts).
 */
export class ClaudeAssistantClient implements AssistantAi {
  readonly #client: Anthropic;
  readonly #model: string;
  readonly #effort: Effort;
  readonly #prices: Prices;
  readonly attempts = ASSISTANT_SDK_MAX_RETRIES + 1;

  constructor(opts: { apiKey: string; model: string; effort?: Effort; prices: Prices; client?: Anthropic }) {
    this.#client =
      opts.client ??
      new Anthropic({ apiKey: opts.apiKey, maxRetries: ASSISTANT_SDK_MAX_RETRIES, timeout: ASSISTANT_TIMEOUT_MS, fetch: keepConnectTimeoutCode });
    this.#model = opts.model;
    this.#effort = opts.effort ?? 'medium';
    this.#prices = opts.prices;
  }

  async turn(
    req: { system: string; tools: Anthropic.Beta.BetaTool[]; messages: AssistantMessage[] },
    onText: (delta: string) => void,
  ): Promise<AssistantTurn> {
    // Never aborted: a call cut off part-way may still be billed, so it runs to its end and is booked.
    const stream = this.#client.beta.messages.stream({
      model: this.#model,
      max_tokens: ASSISTANT_MAX_TOKENS,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      tools: req.tools,
      messages: req.messages,
      output_config: { effort: this.#effort },
    });
    stream.on('text', (delta) => onText(delta));
    const res = await stream.finalMessage();
    const bill = billOf(res.usage, this.#model, this.#prices);
    return { content: res.content, stopReason: res.stop_reason, costUsd: bill.costUsd, fallbackUsed: bill.fallbackUsed };
  }
}
