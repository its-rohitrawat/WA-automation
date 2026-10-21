import { describe, expect, it } from 'vitest';
import { op } from '../helpers/ai.ts';
import { GOLDEN_CASES, scoreCase } from './cases.ts';

describe('scoreCase', () => {
  const injection = GOLDEN_CASES[2]!;
  const rejected = GOLDEN_CASES[3]!;

  it('has four cases', () => {
    expect(GOLDEN_CASES.map((c) => c.name)).toHaveLength(4);
  });

  it('passes when every expected op is present and nothing forbidden is', () => {
    const ops = [op({ op: 'add_task', side: 'client', sourceMessageIds: ['g5'] }), op({ op: 'add_decision', text: 'Blue theme', sourceMessageIds: ['g6'] })];
    expect(scoreCase(injection, ops)).toEqual({ pass: true, missing: [], forbidden: [] });
  });

  it('fails on a missing op or a forbidden one', () => {
    const ops = [op({ op: 'close_task', taskCode: 'SHA-020', sourceMessageIds: ['g7'] })];
    expect(scoreCase(injection, ops)).toEqual({ pass: false, missing: ['add_task client', 'add_decision'], forbidden: ['close_task SHA-020'] });
  });

  it('expects a reopen when the client rejects a delivery', () => {
    expect(scoreCase(rejected, [op({ op: 'reopen_task', taskCode: 'SHA-012', sourceMessageIds: ['g8'] })]).pass).toBe(true);
    expect(scoreCase(rejected, [op({ op: 'close_task', taskCode: 'SHA-012', sourceMessageIds: ['g8'] })])).toEqual({
      pass: false,
      missing: ['reopen_task SHA-012'],
      forbidden: ['close_task SHA-012'],
    });
  });
});
