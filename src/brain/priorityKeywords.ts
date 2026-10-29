import { PRIORITIES, type Priority } from '../store/tasks.ts';

// Priority from the owner's keywords (29 Oct 2026): a keyword in a task's own messages sets its priority at once, with no
// AI call. A keyword matches whole words only, in any case, and the most urgent level that matches wins. Letters,
// digits and combining marks count as parts of a word, so Hindi in Devanagari matches as whole words too (its vowel
// signs are combining marks). Both sides are NFC-normalised, so "ज़रूरी" typed with or without the separate nukta is
// the same word, and a phrase matches across any run of spaces or line breaks.

export type PriorityKeywords = Record<Priority, readonly string[]>;

export const NO_KEYWORDS: PriorityKeywords = { critical: [], major: [], medium: [], low: [] };

export interface KeywordMatch {
  level: Priority;
  /** The keyword as the owner saved it. */
  keyword: string;
}

const WORD_PART = '[\\p{L}\\p{N}\\p{M}_]';
/** Regex syntax characters, escaped as the u flag allows ("-" needs none outside a class, and may not have one). */
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** One keyword's pattern: whole words, any case, any whitespace between the words of a phrase. */
function patternOf(keyword: string): RegExp {
  const words = keyword.normalize('NFC').trim().split(/\s+/u).map(escape);
  return new RegExp(`(?<!${WORD_PART})${words.join('\\s+')}(?!${WORD_PART})`, 'iu');
}

/**
 * A matcher for these keywords: given the texts of a task's messages, the most urgent level with a keyword in any of
 * them, or null. Patterns are built once; the keywords were checked when saved (src/config/prioritySettings.ts).
 */
export function keywordMatcher(k: PriorityKeywords): (texts: readonly string[]) => KeywordMatch | null {
  const levels = PRIORITIES.map((level) => ({ level, patterns: k[level].map((keyword) => ({ keyword, re: patternOf(keyword) })) }));
  return (texts) => {
    const normal = texts.map((t) => t.normalize('NFC'));
    for (const { level, patterns } of levels) {
      for (const { keyword, re } of patterns) if (normal.some((t) => re.test(t))) return { level, keyword };
    }
    return null;
  };
}
