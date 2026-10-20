import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { describe, expect, it } from 'vitest';
import { AiOutputSchema } from '../../src/brain/schema.ts';
import { op } from '../helpers/ai.ts';

describe('AiOutputSchema', () => {
  it('accepts a complete operation', () => {
    const out = AiOutputSchema.parse({ ops: [op({ op: 'add_task', side: 'us', title: 'Banner', category: 'design', priority: 'high', sourceMessageIds: ['m1'] })] });
    expect(out.ops).toHaveLength(1);
  });

  it('rejects unknown operations', () => {
    expect(() => AiOutputSchema.parse({ ops: [{ ...op({ op: 'add_task', sourceMessageIds: ['m1'] }), op: 'delete_everything' }] })).toThrow();
  });

  it('converts to a structured-output JSON schema', () => {
    expect(betaZodOutputFormat(AiOutputSchema).type).toBe('json_schema');
  });
});
