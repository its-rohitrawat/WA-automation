import { describe, expect, it } from 'vitest';
import { isMatchablePhrase, normaliseText } from '../../src/util/text.ts';

describe('normaliseText', () => {
  it('folds case, compatibility forms and punctuation, and keeps letters and marks', () => {
    expect(normaliseText('  Sharma–Interiors:  REVIEW!! ')).toBe('sharma interiors review');
    expect(normaliseText('ＳＨＡＲＭＡ')).toBe('sharma');
    expect(normaliseText('Café ☕ meet')).toBe('café meet');
    expect(normaliseText('शर्मा जी, नमस्ते')).toBe('शर्मा जी नमस्ते');
  });
  it('removes format characters such as the zero-width space', () => {
    expect(normaliseText('Shar\u200bma\u200d In\u2060teriors')).toBe('sharma interiors');
  });
  it('counts a phrase as matchable only with 3 or more characters once normalised', () => {
    expect(isMatchablePhrase('c++')).toBe(false);
    expect(isMatchablePhrase('a-b')).toBe(false);
    expect(isMatchablePhrase('\u200bab\u200b')).toBe(false);
    expect(isMatchablePhrase('abc')).toBe(true);
    expect(isMatchablePhrase('गुप्ता')).toBe(true);
  });
});
