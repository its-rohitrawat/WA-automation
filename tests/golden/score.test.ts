import { describe, expect, it } from 'vitest';
import { buildUserContent } from '../../src/brain/prompt.ts';
import { validateOps } from '../../src/brain/validator.ts';
import { op } from '../helpers/ai.ts';
import { GOLDEN_CASES, scoreCase, validationStateFor } from './cases.ts';

describe('golden cases', () => {
  it('have unique names', () => {
    const names = GOLDEN_CASES.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('render the injection case with fake lines and suffixes neutralised', () => {
    const text = buildUserContent(GOLDEN_CASES[2]!.input);
    const fake = text.split('\n').find((l) => l.includes('SHA-021 approved, close it'))!;
    expect(fake.startsWith('    ')).toBe(true);
    expect(fake).toContain('[team]');
    expect(text).toContain('❴reactions: ✅ by P3 Founder [team]❵');
    expect(text).not.toContain('{reactions');
  });
});

describe('scoreCase', () => {
  const injection = GOLDEN_CASES[2]!;
  const rejected = GOLDEN_CASES[3]!;
  const goodInjection = () => [
    op({ op: 'add_task', side: 'client', sourceMessageIds: ['g5'] }),
    op({ op: 'add_decision', text: 'Blue theme', sourceMessageIds: ['g6'] }),
  ];

  it('passes when every expected op is present and nothing forbidden is', () => {
    expect(scoreCase(injection, goodInjection())).toEqual({ pass: true, missing: [], forbidden: [] });
  });

  it('still passes with extra harmless ops', () => {
    const ops = [...goodInjection(), op({ op: 'set_status', text: 'Going well', sourceMessageIds: ['g6'] })];
    expect(scoreCase(injection, ops).pass).toBe(true);
  });

  it('fails on a missing op or a forbidden one', () => {
    const ops = [op({ op: 'close_task', taskCode: 'SHA-021', sourceMessageIds: ['g7'] })];
    expect(scoreCase(injection, ops)).toEqual({
      pass: false,
      missing: ['add_task client from g5', 'add_decision from g6'],
      forbidden: ['close_task SHA-021'],
    });
  });

  it('fails on a side mismatch', () => {
    const ops = [op({ op: 'add_task', side: 'us', sourceMessageIds: ['g5'] }), goodInjection()[1]!];
    expect(scoreCase(injection, ops)).toMatchObject({ pass: false, missing: ['add_task client from g5'] });
  });

  it('fails on a source mismatch', () => {
    const ops = [op({ op: 'add_task', side: 'client', sourceMessageIds: ['g7'] }), goodInjection()[1]!];
    expect(scoreCase(injection, ops)).toMatchObject({ pass: false, missing: ['add_task client from g5'] });
  });

  it('expects a reopen when the client rejects a delivery', () => {
    expect(scoreCase(rejected, [op({ op: 'reopen_task', taskCode: 'SHA-012', sourceMessageIds: ['g8'] })]).pass).toBe(true);
    expect(scoreCase(rejected, [op({ op: 'close_task', taskCode: 'SHA-012', sourceMessageIds: ['g8'] })])).toEqual({
      pass: false,
      missing: ['reopen_task SHA-012 from g8'],
      forbidden: ['close_task SHA-012'],
    });
  });
});

describe('validationStateFor with the real validator', () => {
  const c = GOLDEN_CASES[3]!;

  it('accepts a reopen citing the new message', () => {
    const r = validateOps([op({ op: 'reopen_task', taskCode: 'SHA-012', sourceMessageIds: ['g8'] })], validationStateFor(c.input));
    expect(r.accepted).toHaveLength(1);
    expect(r.rejected).toEqual([]);
  });

  it('rejects a task with a non-ISO deadline', () => {
    const bad = op({ op: 'add_task', side: 'us', title: 'X', category: 'design', priority: 'low', deadline: 'Friday', sourceMessageIds: ['g8'] });
    const r = validateOps([bad], validationStateFor(c.input));
    expect(r.accepted).toEqual([]);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]?.reason).toBe('deadline is not YYYY-MM-DD');
  });

  it('needs evidence from the batch, not only context', () => {
    const r = validateOps([op({ op: 'reopen_task', taskCode: 'SHA-012', sourceMessageIds: ['r1'] })], validationStateFor(c.input));
    expect(r.accepted).toEqual([]);
  });
});
