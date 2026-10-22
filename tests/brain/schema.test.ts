import { describe, expect, it } from 'vitest';
import { AI_OUTPUT_JSON_SCHEMA, AiOutputParseError, OP_NAMES, parseAiOutput } from '../../src/brain/schema.ts';

const wireOp = (o: Record<string, unknown> = {}) => ({
  op: 'add_task', taskCode: '', side: '', title: '', category: '', priority: '', assignedTo: '', askedBy: '', deadline: '',
  latestProgress: '', status: '', text: '', phase: '', personJid: '', role: '', sourceMessageIds: ['m1'], reason: 'test', ...o,
});

function walk(node: unknown, visit: (n: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) node.forEach((x) => walk(x, visit));
  else if (node && typeof node === 'object') {
    visit(node as Record<string, unknown>);
    Object.values(node).forEach((x) => walk(x, visit));
  }
}

describe('AI_OUTPUT_JSON_SCHEMA', () => {
  it('has no unions and is strict', () => {
    walk(AI_OUTPUT_JSON_SCHEMA, (n) => {
      expect(n).not.toHaveProperty('anyOf');
      expect(n).not.toHaveProperty('oneOf');
      if ('type' in n) expect(Array.isArray(n.type)).toBe(false);
      if (n.type === 'object') expect(n.additionalProperties).toBe(false);
    });
    expect(AI_OUTPUT_JSON_SCHEMA).not.toHaveProperty('$schema');
  });

  it('keeps the op enum and requires every field', () => {
    const props = AI_OUTPUT_JSON_SCHEMA.properties as { ops: { items: { properties: { op: { enum: string[] } }; required: string[] } } };
    expect(props.ops.items.properties.op.enum).toEqual([...OP_NAMES]);
    expect(props.ops.items.required).toHaveLength(17);
  });
});

describe('enums in the JSON schema', () => {
  it('keeps the field enums, each including ""', () => {
    const props = (AI_OUTPUT_JSON_SCHEMA.properties as { ops: { items: { properties: Record<string, { enum?: string[] }> } } }).ops.items.properties;
    for (const f of ['side', 'category', 'priority', 'status', 'role']) {
      expect(props[f]!.enum, f).toBeDefined();
      expect(props[f]!.enum).toContain('');
    }
  });
});

describe('parseAiOutput', () => {
  it('turns a whitespace-only title into null', () => {
    expect(parseAiOutput(JSON.stringify({ ops: [wireOp({ title: '  ' })] })).output.ops[0]!.title).toBeNull();
  });

  it('turns empty strings into nulls', () => {
    const { output, invalidOps } = parseAiOutput(JSON.stringify({ ops: [wireOp()] }));
    expect(invalidOps).toBe(0);
    expect(output.ops[0]).toMatchObject({ op: 'add_task', side: null, deadline: null, status: null, sourceMessageIds: ['m1'] });
  });

  it('drops an invalid op but keeps the valid ones', () => {
    const { output, invalidOps } = parseAiOutput(JSON.stringify({ ops: [wireOp({ category: 'Design' }), wireOp({ category: 'design' })] }));
    expect(invalidOps).toBe(1);
    expect(output.ops).toHaveLength(1);
    expect(output.ops[0]!.category).toBe('design');
  });

  it('throws on non-JSON or a wrong shape', () => {
    expect(() => parseAiOutput('not json')).toThrow(AiOutputParseError);
    expect(() => parseAiOutput('{}')).toThrow(AiOutputParseError);
  });
});
