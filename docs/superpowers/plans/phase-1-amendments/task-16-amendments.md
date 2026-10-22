# Task 16 amendments (controller decisions; these replace the task's reconcile() body and tests)

Since Task 13 was amended, src/brain/schema.ts no longer exports `AiOutputSchema`. It exports `AI_OUTPUT_JSON_SCHEMA` (a plain JSON schema built by zod that keeps `enum`), `parseAiOutput(text)` returning `{ output, invalidOps }` (invalid ops are dropped and counted) and `AiOutputParseError`. Reason: the SDK's `betaZodOutputFormat` strips `enum`, and `parse()` loses the token usage when parsing fails.

Implement `ClaudeClient.reconcile` with `client.beta.messages.create` (not `parse`) and our own parsing:

```ts
import Anthropic from '@anthropic-ai/sdk';
import type { TokenUsage } from '../spend/pricing.ts';
import { AI_OUTPUT_JSON_SCHEMA, AiOutputParseError, parseAiOutput, type AiOutput } from './schema.ts';

export interface AiCallResult {
  output: AiOutput;
  usage: TokenUsage;
  model: string;
  /** Operations that did not match the schema and were dropped. */
  invalidOps: number;
}

// AiClient, Effort, AiRefusalError and AiInvalidOutputError stay as in the task text.

  async reconcile(system: string, user: string): Promise<AiCallResult> {
    const res = await this.#client.beta.messages.create({
      model: this.#model,
      max_tokens: 16_000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: user }],
      output_config: { effort: this.#effort, format: { type: 'json_schema', schema: AI_OUTPUT_JSON_SCHEMA } },
    });
    const usage: TokenUsage = {
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
      cacheCreationInputTokens: res.usage.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: res.usage.cache_read_input_tokens ?? 0,
    };
    if (res.stop_reason === 'refusal') throw new AiRefusalError(res.stop_details?.category ?? null, usage);
    if (res.stop_reason === 'max_tokens') throw new AiInvalidOutputError('Output was cut off at max_tokens', usage);
    const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    try {
      const { output, invalidOps } = parseAiOutput(text);
      return { output, usage, model: res.model, invalidOps };
    } catch (e) {
      if (e instanceof AiOutputParseError) throw new AiInvalidOutputError('Model output was not valid JSON', usage);
      throw e;
    }
  }
```

API errors (including `Anthropic.APIConnectionError`) propagate unchanged; the SDK already retried them. If the beta `create` params reject `fallbacks: 'default'` or the `json_schema` format shape at type-check time, report the exact compiler error rather than casting.

Tests (replace tests/brain/claudeClient.test.ts). The fake client is `{ beta: { messages: { create } } }`; responses use `content: [{ type: 'text', text: JSON.stringify({ ops: [...] }) }]` with wire ops (every field present, "" for unset):
- params: model, `betas: ['server-side-fallback-2026-07-01']`, `fallbacks: 'default'`, system with `cache_control: { type: 'ephemeral' }`, the user message, `output_config.effort === 'medium'`, `output_config.format` deep-equals `{ type: 'json_schema', schema: AI_OUTPUT_JSON_SCHEMA }`;
- a wire op with "" fields comes back with nulls; usage is mapped; `invalidOps` is 0;
- one invalid op (category 'Design') next to a valid one → the valid op is returned and `invalidOps` is 1;
- refusal → AiRefusalError with category and usage;
- `stop_reason: 'max_tokens'` → AiInvalidOutputError whose `usage` is set;
- text `not json` → AiInvalidOutputError whose `usage` is set;
- create rejecting with `new Anthropic.APIConnectionError({ message: 'network down' })` → that error is rethrown.

---

## Round 2 (from the Task 15 review): bill every attempt, including fallbacks

Server-side fallback can run more than one model per request. The top-level `res.usage` covers only the attempt that produced the returned message. `res.usage.iterations` lists every attempt. Each entry has `type` ('message' | 'fallback_message' | others), `model`, `input_tokens`, `output_tokens`, `cache_creation_input_tokens` and `cache_read_input_tokens`. Fallback models (Opus 5 / Opus 4.8) cost more than Opus 5.5. Changes:

1. **Constructor:**
   - Takes `prices: Prices` (from `../spend/pricing.ts`). The options become `{ apiKey, model, effort?, prices, client? }`.
   - Add `export const SDK_MAX_RETRIES = 2;`.
   - The default client is `new Anthropic({ apiKey, maxRetries: SDK_MAX_RETRIES, timeout: 600_000 })`.
   - Reasons: a 16k-token reply with always-on thinking can take several minutes without streaming. The SDK retries timeouts and connection errors on its own, and each attempt may be billed, so the reconciler settles an unknown outcome at the estimate × (SDK_MAX_RETRIES + 1).
   - `effort` defaults to `'medium'`, as in the task text.
2. **Max tokens:** `export const MAX_OUTPUT_TOKENS = 16_000;`, used as `max_tokens`.
3. **Billing helper:** add a pure function `export function billOf(u: <the beta usage type>, requestedModel: string, prices: Prices): { usage: TokenUsage; costUsd: number; fallbackUsed: boolean }`.
   - The controller checked SDK 0.135: `BetaUsage` has `iterations: BetaIterationsUsage | null`. This is an array of `BetaMessageIterationUsage | BetaCompactionIterationUsage | BetaAdvisorMessageIterationUsage | BetaFallbackMessageIterationUsage`, and each entry has `type`, `model`, `input_tokens`, `output_tokens`, `cache_creation_input_tokens` and `cache_read_input_tokens`.
   - Use those types. If they do not compile, report the exact error instead of casting.
   - If `u.iterations` is a non-empty array, map every entry to a TokenUsage (missing numbers count as 0).
     - An entry is a **fallback** entry when `type === 'fallback_message'`, or when its `model` is a non-null string that does not start with `requestedModel`.
     - Price fallback entries with `FALLBACK_PRICES` and all others with `prices`.
     - `usage` is the sum of all entries, `costUsd` is the sum of the per-entry costs, and `fallbackUsed` is true if any fallback entry exists.
   - Otherwise use the top-level usage at `prices`, with `fallbackUsed` false.
4. **Results and errors:**
   - `AiCallResult` gains `costUsd: number` and `fallbackUsed: boolean`. `usage` is the summed usage from `billOf`.
   - `AiRefusalError` and `AiInvalidOutputError` gain a `costUsd: number | null` field next to `usage`.
     - It is a third constructor parameter that defaults to `null`: `new AiRefusalError(category, usage, costUsd = null)` and `new AiInvalidOutputError(message, usage, costUsd = null)`.
     - The client always passes it from `billOf` when a response exists.
5. **Tests to add:**
   - `billOf` with iterations `[{ type: 'message', model: 'claude-opus-5-5', input 1000, output 200 }, { type: 'fallback_message', model: 'claude-opus-5', input 1000, output 300 }]`:
     - `usage` sums to input 2000 / output 500;
     - `costUsd` equals primary-at-prices plus fallback-at-FALLBACK_PRICES;
     - `fallbackUsed` is true.
   - With `iterations: null`, the top-level usage is used and `fallbackUsed` is false.
   - Request params use `max_tokens: MAX_OUTPUT_TOKENS`.
   - A refusal response carries `costUsd`.
