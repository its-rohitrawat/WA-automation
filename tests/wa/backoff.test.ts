import { describe, expect, it } from 'vitest';
import { backoffMs } from '../../src/wa/backoff.ts';

const mid = () => 0.5; // no jitter

describe('backoffMs', () => {
  it('starts at 5 seconds and doubles', () => {
    expect(backoffMs(0, mid)).toBe(5_000);
    expect(backoffMs(1, mid)).toBe(10_000);
    expect(backoffMs(3, mid)).toBe(40_000);
  });

  it('is capped at 10 minutes even with jitter', () => {
    expect(backoffMs(20, mid)).toBe(600_000);
    expect(backoffMs(20, () => 1)).toBe(600_000);
  });

  it('never drops below 5 seconds', () => {
    expect(backoffMs(0, () => 0)).toBe(5_000);
  });
});
