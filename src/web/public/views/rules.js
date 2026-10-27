// The agent's rules for a client's name, meeting keywords and email domains (src/web/routes/groups.ts, src/config/domains.ts
// and src/util/text.ts), checked in the drawer before a save so the owner sees the problem next to the field. The agent
// checks them again; tests/web/public.test.ts keeps the public-domain list equal to the agent's.

/** Mail domains everyone uses: a rule on one would match every guest. */
export const PUBLIC_MAIL_DOMAINS = [
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'yahoo.co.in', 'icloud.com', 'me.com',
  'rediffmail.com', 'proton.me', 'protonmail.com', 'zoho.com', 'aol.com', 'yahoo.in', 'ymail.com', 'msn.com', 'live.in',
  'hotmail.co.uk', 'pm.me', 'gmx.com', 'mail.com', 'yandex.com',
];
const PUBLIC = new Set(PUBLIC_MAIL_DOMAINS);
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const MAX_KEYWORDS = 20;
export const NAME_MAX = 80;

/** A keyword the agent can match: at least 3 characters once punctuation, symbols and spaces are removed. @param {string} k */
export const matchable = (k) => [...k.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]/gu, '')].length >= 3;

/**
 * The first problem with a client's fields, as the owner should read it, or ''.
 * @param {{ name: string, keywords: string[], domains: string[] }} f
 */
export function fieldProblem(f) {
  if (!f.name) return 'Give the client a name.';
  if (f.name.length > NAME_MAX) return `The client name can be at most ${NAME_MAX} characters.`;
  if (f.keywords.length > MAX_KEYWORDS) return `At most ${MAX_KEYWORDS} meeting keywords.`;
  const short = f.keywords.find((k) => k.length < 3 || !matchable(k));
  if (short !== undefined) return `The keyword "${short}" needs at least 3 letters.`;
  const bad = f.domains.find((d) => !DOMAIN.test(d));
  if (bad !== undefined) return `"${bad}" is not a domain. Write it like client.com, without the @ part.`;
  const pub = f.domains.find((d) => PUBLIC.has(d));
  if (pub !== undefined) return `${pub} is a public mail domain: it would match everyone. Use the client's own domain.`;
  return '';
}
