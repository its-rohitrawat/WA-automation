import { describe, expect, it } from 'vitest';

const later = async (v: number): Promise<number> => v;
const refuse = async (): Promise<never> => {
  throw new Error('no');
};

/** tests/setup/expectGuard.ts: a check handed a Promise fails instead of passing without checking anything. */
describe('the promise guard on expect', () => {
  it('fails a matcher given a promise as the value', () => {
    expect(() => expect(later(1)).toEqual(later(2))).toThrowError(/was given a Promise/);
    expect(() => expect([later(1)][0]).toBeDefined()).toThrowError(/was given a Promise/);
    expect(() => expect(later(1)).not.toBeNull()).toThrowError(/was given a Promise/);
  });

  it('fails a matcher given a promise as the expected value', () => {
    expect(() => expect(1).toEqual(later(1))).toThrowError(/was given a Promise/);
  });

  it('fails toThrow on a function that returns a promise, whether or not it rejects', () => {
    expect(() => expect(() => refuse()).toThrow()).toThrowError(/returns a Promise/);
    expect(() => expect(() => later(1)).not.toThrow()).toThrowError(/returns a Promise/);
  });

  it('leaves .resolves, .rejects and plain values alone', async () => {
    await expect(later(1)).resolves.toBe(1);
    await expect(refuse()).rejects.toThrowError('no');
    expect(await later(2)).toEqual(2);
    expect(() => {
      throw new Error('sync');
    }).toThrowError('sync');
    expect(() => 1).not.toThrow();
  });
});
