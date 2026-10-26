// Text normalisation for matching names and keywords (meeting titles), shared by the matcher and the config checks.

const PUNCTUATION_AND_SYMBOLS = /[\p{P}\p{S}]/gu;
/**
 * Format characters (zero-width space, joiners, direction marks...). Removed from both the title and the phrases, so one
 * hidden inside a word neither breaks a match nor makes a new one. ZWJ and ZWNJ go too: they only change how Devanagari
 * is drawn, and both sides lose them alike.
 */
const FORMAT_CHARS = /\p{Cf}/gu;
/** A phrase shorter than this once normalised (spaces not counted) never matches: 'c++' would become 'c'. */
export const MIN_PHRASE_CHARS = 3;

/**
 * NFKC, format characters removed, lower case, punctuation and symbols to spaces, single spaces, trimmed. Letters and
 * combining marks are kept, so Devanagari and accented words stay as they are ('café' is not 'cafe').
 */
export function normaliseText(s: string): string {
  return s.normalize('NFKC').replace(FORMAT_CHARS, '').toLowerCase().replace(PUNCTUATION_AND_SYMBOLS, ' ').replace(/\s+/g, ' ').trim();
}

/** True when a name or keyword still has at least MIN_PHRASE_CHARS characters (spaces not counted) once normalised. */
export function isMatchablePhrase(phrase: string): boolean {
  return [...normaliseText(phrase).replace(/ /g, '')].length >= MIN_PHRASE_CHARS;
}
