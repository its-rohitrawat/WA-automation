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
