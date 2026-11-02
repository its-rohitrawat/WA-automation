// Open chat's tags (November release, change 2), on their own so they can be tested without a page: the message as the
// owner typed it ("@Name") turned into the form WhatsApp reads ("@<digits>").

/**
 * The text as WhatsApp gets it: each tagged "@Label" as "@<digits>" (longest labels first, so one never eats another);
 * and who it tags, by label, in the order they first appear in the text. A label the owner edited away is no tag.
 * @param {string} shown @param {Map<string, string>} picks label to digits
 * @returns {{ text: string, tagged: string[] }}
 */
export function toWhatsApp(shown, picks) {
  let text = shown;
  /** @type {{ label: string, tag: string }[]} */
  const found = [];
  for (const [label, tag] of [...picks].sort((a, b) => b[0].length - a[0].length)) {
    const re = new RegExp(`@${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'gu');
    const next = text.replace(re, `@${tag}`);
    if (next !== text) found.push({ label, tag });
    text = next;
  }
  // In the order the tags stand in the message, as the members will read them.
  const at = (/** @type {string} */ tag) => text.search(new RegExp(`@${tag}(?!\\d)`));
  return { text, tagged: found.sort((a, b) => at(a.tag) - at(b.tag)).map((f) => f.label) };
}
