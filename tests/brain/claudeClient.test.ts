import Anthropic from '@anthropic-ai/sdk';
import type { BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { describe, expect, it, vi } from 'vitest';
import {
  AiInvalidOutputError,
  AiRefusalError,
  ClaudeClient,
  MAX_OUTPUT_TOKENS,
  SDK_MAX_RETRIES,
  billOf,
} from '../../src/brain/claudeClient.ts';
import { AI_OUTPUT_JSON_SCHEMA } from '../../src/brain/schema.ts';
import { FALLBACK_PRICES, costUsd, type Prices, type TokenUsage } from '../../src/spend/pricing.ts';

const prices: Prices = { inputPerMTok: 4, outputPerMTok: 20, cacheWritePerMTok: 5, cacheReadPerMTok: 0.2 };
const usage = {
  input_tokens: 1200,
  output_tokens: 300,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 900,
  iterations: null,
};
const tokenUsage = { inputTokens: 1200, outputTokens: 300, cacheCreationInputTokens: 0, cacheReadInputTokens: 900 };

const wireOp = (over: Record<string, unknown> = {}) => ({
  op: 'add_task', taskCode: '', side: 'us', title: 'Send logo', category: 'design', priority: '', assignedTo: '',
  askedBy: '', deadline: '', latestProgress: '', status: '', text: '', phase: '', personJid: '', role: '',
  sourceMessageIds: ['m1'], reason: 'asked', ...over,
});
const textResponse = (ops: unknown[], extra: Record<string, unknown> = {}) => ({
  stop_reason: 'end_turn', stop_details: null, content: [{ type: 'text', text: JSON.stringify({ ops }) }], usage, model: 'claude-opus-5-5', ...extra,
});

function fakeAnthropic(impl: (params: unknown) => Promise<unknown>) {
  const create = vi.fn(impl);
  return { client: { beta: { messages: { create } } } as unknown as Anthropic, create };
}
const make = (client: Anthropic) => new ClaudeClient({ apiKey: 'test-only', model: 'claude-opus-5-5', effort: 'medium', prices, client });

describe('ClaudeClient', () => {
  it('sends a cached system prompt, the fallback, effort and schema', async () => {
    const { client, create } = fakeAnthropic(async () => textResponse([]));
    const result = await make(client).reconcile('SYS', 'USER');
    expect(result.output.ops).toEqual([]);
    const params = create.mock.calls[0]![0] as Record<string, unknown> & { output_config: { effort: string; format: unknown } };
    expect(params).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: MAX_OUTPUT_TOKENS,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'USER' }],
    });
    expect(params).not.toHaveProperty('thinking');
    expect(params.output_config.effort).toBe('medium');
    expect(params.output_config.format).toEqual({ type: 'json_schema', schema: AI_OUTPUT_JSON_SCHEMA });
    expect(SDK_MAX_RETRIES).toBe(2);
  });

  it('turns empty wire fields into nulls and maps usage and cost', async () => {
    const { client } = fakeAnthropic(async () => textResponse([wireOp()]));
    const r = await make(client).reconcile('S', 'U');
    expect(r.output.ops[0]).toMatchObject({ op: 'add_task', taskCode: null, assignedTo: null, title: 'Send logo' });
    expect(r.usage).toEqual(tokenUsage);
    expect(r.invalidOps).toBe(0);
    expect(r.fallbackUsed).toBe(false);
    expect(r.costUsd).toBeCloseTo(costUsd(tokenUsage, prices));
  });

  it('drops an invalid op and counts it', async () => {
    const { client } = fakeAnthropic(async () => textResponse([wireOp({ category: 'Design' }), wireOp({ title: 'Valid' })]));
    const r = await make(client).reconcile('S', 'U');
    expect(r.output.ops).toHaveLength(1);
    expect(r.output.ops[0]!.title).toBe('Valid');
    expect(r.invalidOps).toBe(1);
  });

  it('raises AiRefusalError, keeping usage and cost for billing', async () => {
    const { client } = fakeAnthropic(async () => ({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [], usage, model: 'x' }));
    const err = await make(client).reconcile('S', 'U').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiRefusalError);
    expect((err as AiRefusalError).category).toBe('cyber');
    expect((err as AiRefusalError).usage.inputTokens).toBe(1200);
    expect((err as AiRefusalError).costUsd).toBeCloseTo(costUsd(tokenUsage, prices));
  });

  it('raises AiInvalidOutputError with usage on max_tokens', async () => {
    const { client } = fakeAnthropic(async () => textResponse([], { stop_reason: 'max_tokens' }));
    const err = await make(client).reconcile('S', 'U').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiInvalidOutputError);
    expect((err as AiInvalidOutputError).usage).not.toBeNull();
    expect((err as AiInvalidOutputError).costUsd).toBeGreaterThan(0);
  });

  it('raises AiInvalidOutputError with usage when the text is not JSON', async () => {
    const { client } = fakeAnthropic(async () => ({ ...textResponse([]), content: [{ type: 'text', text: 'not json' }] }));
    const err = await make(client).reconcile('S', 'U').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiInvalidOutputError);
    expect((err as AiInvalidOutputError).usage?.inputTokens).toBe(1200);
    expect((err as AiInvalidOutputError).costUsd).toBeGreaterThan(0);
  });

  it('rethrows API errors unchanged', async () => {
    const down = new Anthropic.APIConnectionError({ message: 'network down' });
    const { client } = fakeAnthropic(async () => { throw down; });
    await expect(make(client).reconcile('S', 'U')).rejects.toBe(down);
  });

  it('parses the op from a real response with thinking and fallback blocks', async () => {
    const content = [
      { type: 'thinking', thinking: '', signature: 's' },
      { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' }, trigger: { type: 'refusal', category: 'cyber' } },
      { type: 'text', text: JSON.stringify({ ops: [wireOp()] }) },
    ];
    const { client } = fakeAnthropic(async () => textResponse([], { content }));
    const r = await make(client).reconcile('S', 'U');
    expect(r.output.ops).toHaveLength(1);
    expect(r.output.ops[0]!.title).toBe('Send logo');
  });

  it('bills a fallback attempt on top of the primary one', async () => {
    const iterations = [
      { type: 'message', model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      { type: 'fallback_message', model: 'claude-opus-5', input_tokens: 1000, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    ];
    const { client } = fakeAnthropic(async () => textResponse([], { usage: { ...usage, iterations } }));
    const r = await make(client).reconcile('S', 'U');
    expect(r.fallbackUsed).toBe(true);
    expect(r.usage.inputTokens).toBe(2000);
    const part = (output: number): TokenUsage => ({ inputTokens: 1000, outputTokens: output, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 });
    expect(r.costUsd).toBeCloseTo(costUsd(part(200), prices) + costUsd(part(300), FALLBACK_PRICES));
  });
});

describe('billOf', () => {
  const usageOf = (over: Partial<BetaUsage>): BetaUsage => ({
    cache_creation: null,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 900,
    fallback_credit: null,
    inference_geo: null,
    input_tokens: 1200,
    iterations: null,
    output_tokens: 300,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: null,
    speed: null,
    ...over,
  });
  const zero = { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null };

  it('sums every iteration, cache tokens included, and prices fallbacks separately', () => {
    const it1 = { type: 'message', model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 200, cache_creation: null, cache_creation_input_tokens: 400, cache_read_input_tokens: 600 } as const;
    const it2 = { type: 'fallback_message', model: 'claude-opus-5', input_tokens: 1000, output_tokens: 300, ...zero } as const;
    const cheap: Prices = { inputPerMTok: 1, outputPerMTok: 2, cacheWritePerMTok: 3, cacheReadPerMTok: 4 };
    const r = billOf(usageOf({ iterations: [it1, it2] }), 'claude-opus-5-5', cheap);
    expect(r.usage).toEqual({ inputTokens: 2000, outputTokens: 500, cacheCreationInputTokens: 400, cacheReadInputTokens: 600 });
    const primary = costUsd({ inputTokens: 1000, outputTokens: 200, cacheCreationInputTokens: 400, cacheReadInputTokens: 600 }, cheap);
    const fb = costUsd({ inputTokens: 1000, outputTokens: 300, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, FALLBACK_PRICES);
    expect(r.costUsd).toBeCloseTo(primary + fb);
    expect(r.fallbackUsed).toBe(true);
  });

  it('treats a differently named model as a fallback even if typed as message', () => {
    const e = { type: 'message', model: 'claude-opus-4-8', input_tokens: 10, output_tokens: 10, ...zero } as const;
    expect(billOf(usageOf({ iterations: [e] }), 'claude-opus-5-5', prices).fallbackUsed).toBe(true);
  });

  it('uses the top-level usage when iterations is null or empty', () => {
    for (const iterations of [null, []]) {
      const r = billOf(usageOf({ iterations }), 'claude-opus-5-5', prices);
      expect(r.usage).toEqual(tokenUsage);
      expect(r.costUsd).toBeCloseTo(costUsd(r.usage, prices));
      expect(r.fallbackUsed).toBe(false);
    }
  });
});
