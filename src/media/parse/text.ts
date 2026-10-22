/**
 * Text limits shared by the parsers (in the worker) and the extractor (in the service). Text from a file is untrusted
 * and can be tens of millions of characters long, so neither function copies it, and counting stops at its limit.
 */

/**
 * The first `max` UTF-16 code units of text. A cut that would split a surrogate pair moves one unit earlier, so the
 * result never ends with half of a character. O(1): one slice, never an array of the whole text.
 */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/** How many characters of s are not whitespace. Counting stops once it reaches `enough`, and s is never copied. */
export function countVisible(s: string, enough = Number.POSITIVE_INFINITY): number {
  const re = /\S+/g;
  let n = 0;
  while (n < enough) {
    const m = re.exec(s);
    if (m === null) break;
    n += re.lastIndex - m.index;
  }
  return n;
}
