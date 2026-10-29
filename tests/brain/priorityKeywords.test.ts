import { describe, expect, it } from 'vitest';
import { keywordMatcher, NO_KEYWORDS } from '../../src/brain/priorityKeywords.ts';
import { DEFAULT_KEYWORDS } from '../../src/config/prioritySettings.ts';

const lists = (o: Partial<typeof NO_KEYWORDS>) => ({ ...NO_KEYWORDS, ...o });

describe('keywordMatcher', () => {
  it('matches a whole word in any case and names the keyword as saved', () => {
    const match = keywordMatcher(lists({ critical: ['Urgent'] }));
    expect(match(['Banner URGENT chahiye'])).toEqual({ level: 'critical', keyword: 'Urgent' });
    expect(match(['urgent!'])).toEqual({ level: 'critical', keyword: 'Urgent' });
    expect(match(['(urgent)'])).toEqual({ level: 'critical', keyword: 'Urgent' });
  });

  it('never matches inside a longer word', () => {
    const match = keywordMatcher(lists({ critical: ['urgent', 'asap'], low: ['low'] }));
    expect(match(['this is not urgently needed'])).toBeNull();
    expect(match(['nonurgent'])).toBeNull();
    expect(match(['asaps', 'below', 'flower', 'urgent_ish'])).toBeNull();
  });

  it('matches a phrase across any spaces and line breaks', () => {
    const match = keywordMatcher(lists({ critical: ['site down'] }));
    expect(match(['Site   down hai'])).toEqual({ level: 'critical', keyword: 'site down' });
    expect(match(['site\ndown'])).toEqual({ level: 'critical', keyword: 'site down' });
    expect(match(['website down'])).toBeNull();
  });

  it('matches Hindi in Devanagari as whole words, its vowel signs counting as part of the word', () => {
    const match = keywordMatcher(lists({ critical: ['तुरंत'], major: ['जरूरी'] }));
    expect(match(['यह तुरंत चाहिए'])).toEqual({ level: 'critical', keyword: 'तुरंत' });
    expect(match(['बहुत जरूरी है'])).toEqual({ level: 'major', keyword: 'जरूरी' });
    // A word that only starts with the keyword is another word.
    expect(match(['तुरंतता'])).toBeNull();
  });

  it('treats the precomposed and the separate nukta as the same letter (NFC)', () => {
    const precomposed = 'ज़रूरी'; // ज़ as one code point
    const separate = 'ज़रूरी'; // ज + nukta
    expect(keywordMatcher(lists({ major: [precomposed] }))([`bahut ${separate} hai`])).toEqual({ level: 'major', keyword: precomposed });
    expect(keywordMatcher(lists({ major: [separate] }))([`bahut ${precomposed} hai`])).toEqual({ level: 'major', keyword: separate });
  });

  it('gives the most urgent level that matches in any of the texts', () => {
    const match = keywordMatcher(lists({ critical: ['urgent'], major: ['important'], low: ['no rush'] }));
    expect(match(['no rush on this', 'but it is important'])).toEqual({ level: 'major', keyword: 'important' });
    expect(match(['important', 'urgent'])).toEqual({ level: 'critical', keyword: 'urgent' });
    expect(match(['no rush'])).toEqual({ level: 'low', keyword: 'no rush' });
    expect(match(['hello', ''])).toBeNull();
    expect(match([])).toBeNull();
  });

  it('reads regex characters in a keyword as plain characters', () => {
    const match = keywordMatcher(lists({ critical: ['a+b', 'v2.0', '(asap)', 'fix/now'], major: ['co-op'] }));
    expect(match(['aab'])).toBeNull();
    expect(match(['v2x0'])).toBeNull();
    expect(match(['need a+b today'])).toEqual({ level: 'critical', keyword: 'a+b' });
    expect(match(['ship v2.0'])).toEqual({ level: 'critical', keyword: 'v2.0' });
    expect(match(['fix/now please'])).toEqual({ level: 'critical', keyword: 'fix/now' });
    expect(match(['the co-op'])).toEqual({ level: 'major', keyword: 'co-op' });
  });

  it('matches nothing without keywords', () => {
    expect(keywordMatcher(NO_KEYWORDS)(['urgent asap emergency'])).toBeNull();
  });

  it('keeps the starting lists free of words that would turn a no-hurry message urgent', () => {
    const match = keywordMatcher(DEFAULT_KEYWORDS);
    expect(match(['koi hurry nahi, whenever possible'])).toEqual({ level: 'low', keyword: 'whenever possible' });
    expect(match(['koi jaldi nahi'])).toBeNull();
    expect(match(['Site down hai, turant dekho'])?.level).toBe('critical');
  });
});
