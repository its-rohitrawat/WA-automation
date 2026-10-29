import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeClient } from '../../src/brain/claudeClient.ts';
import { AI_OUTPUT_JSON_SCHEMA, AI_OUTPUT_JSON_SCHEMA_WITH_SENTIMENT, parseAiOutput } from '../../src/brain/schema.ts';
import type { Prices } from '../../src/spend/pricing.ts';

const prices: Prices = { inputPerMTok: 4, outputPerMTok: 20, cacheWritePerMTok: 5, cacheReadPerMTok: 0.2 };
const usage = { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, iterations: null };
const wireOp = (over: Record<string, unknown> = {}) => ({
  op: 'add_task', taskCode: '', side: 'us', title: 'Send logo', category: 'design', priority: 'critical', assignedTo: '',
  askedBy: '', deadline: '', latestProgress: '', status: '', text: '', phase: '', personJid: '', role: '',
  sourceMessageIds: ['m1'], reason: 'asked', ...over,
});
type OpSchema = { properties: Record<string, { enum?: string[] }>; required: string[] };
const opSchema = (s: Record<string, unknown>) => (s as { properties: { ops: { items: OpSchema } } }).properties.ops.items;

describe('the output schema with priority levels and sentiment', () => {
  it('offers the four priority levels', () => {
    expect(opSchema(AI_OUTPUT_JSON_SCHEMA).properties.priority!.enum).toEqual(['', 'critical', 'major', 'medium', 'low']);
  });

  it('asks for no sentiment unless switched on, and requires it when on', () => {
    expect(opSchema(AI_OUTPUT_JSON_SCHEMA).properties).not.toHaveProperty('sentiment');
    const on = opSchema(AI_OUTPUT_JSON_SCHEMA_WITH_SENTIMENT);
    expect(on.properties.sentiment!.enum).toEqual(['', 'positive', 'neutral', 'negative', 'frustrated']);
    expect(on.required).toContain('sentiment');
    // The rest of the operation is the same.
    expect({ ...on.properties, sentiment: undefined }).toEqual({ ...opSchema(AI_OUTPUT_JSON_SCHEMA).properties, sentiment: undefined });
  });

  it('parses a mood when asked for one: "" is none; an op without one is dropped', () => {
    const text = JSON.stringify({ ops: [wireOp({ sentiment: 'frustrated' }), wireOp({ sentiment: '' }), wireOp()] });
    const { output, invalidOps } = parseAiOutput(text, { sentiment: true });
    expect(output.ops.map((o) => o.sentiment)).toEqual(['frustrated', null]);
    expect(invalidOps).toBe(1);
  });

  it('ignores a mood it did not ask for, and drops the old "high" level', () => {
    const { output, invalidOps } = parseAiOutput(JSON.stringify({ ops: [wireOp({ sentiment: 'negative' }), wireOp({ priority: 'high' })] }));
    expect(output.ops).toHaveLength(1);
    expect(output.ops[0]).not.toHaveProperty('sentiment');
    expect(output.ops[0]!.priority).toBe('critical');
    expect(invalidOps).toBe(1);
  });
});

describe('ClaudeClient with sentiment', () => {
  it('sends the sentiment schema only when asked, and parses the mood', async () => {
    const create = vi.fn(async () => ({
      stop_reason: 'end_turn', stop_details: null, model: 'claude-opus-5-5', usage,
      content: [{ type: 'text', text: JSON.stringify({ ops: [wireOp({ sentiment: 'positive' })] }) }],
    }));
    const client = new ClaudeClient({ apiKey: 'test-only', model: 'claude-opus-5-5', prices, client: { beta: { messages: { create } } } as unknown as Anthropic });
    const on = await client.reconcile('SYS', 'USER', { sentiment: true });
    expect(on.output.ops[0]!.sentiment).toBe('positive');
    const off = await client.reconcile('SYS', 'USER');
    expect(off.output.ops[0]).not.toHaveProperty('sentiment');
    const formats = create.mock.calls.map((c) => (c as unknown as [{ output_config: { format: { schema: unknown } } }])[0].output_config.format.schema);
    expect(formats).toEqual([AI_OUTPUT_JSON_SCHEMA_WITH_SENTIMENT, AI_OUTPUT_JSON_SCHEMA]);
  });
});
