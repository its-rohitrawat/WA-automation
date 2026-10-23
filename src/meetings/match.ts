// Which client a meeting belongs to (M2), decided before anything is downloaded. Pure: no I/O, no logging.

export interface MatchableClient {
  clientId: number;
  name: string;
  emailDomains: readonly string[];
  meetingKeywords: readonly string[];
  /** Missing means active. An inactive client never matches. */
  active?: boolean;
}

export interface MatchInput {
  title: string;
  attendees: readonly { email: string; self: boolean }[];
  hasInvite: boolean;
}

export type MatchResult =
  | { kind: 'client'; clientId: number; by: 'title' | 'domain' }
  | { kind: 'internal' }
  | { kind: 'unassigned'; reason: 'none' | 'ambiguous' };

const PUNCTUATION_AND_SYMBOLS = /[\p{P}\p{S}]/gu;

/**
 * NFKC, lower case, punctuation and symbols to spaces, single spaces, trimmed. Letters and combining marks are kept, so
 * Devanagari and accented words stay as they are ('café' is not 'cafe').
 */
export function normaliseText(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(PUNCTUATION_AND_SYMBOLS, ' ').replace(/\s+/g, ' ').trim();
}

/** True when the normalised phrase appears in the normalised text as whole words. */
function hasPhrase(paddedText: string, phrase: string): boolean {
  const p = normaliseText(phrase);
  return p !== '' && paddedText.includes(` ${p} `);
}

/** The lower-cased part after the last '@', or null for anything that is not an address. */
export function domainOf(email: string): string | null {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at <= 0) return null;
  const domain = e.slice(at + 1).replace(/\.+$/, '');
  return domain === '' ? null : domain;
}

/** The domain equals one of the entries or is a subdomain of one. Entries are compared lower-cased. */
export function inDomains(domain: string, entries: readonly string[]): boolean {
  const d = domain.toLowerCase();
  return entries.some((raw) => {
    const e = raw.trim().toLowerCase();
    return e !== '' && (d === e || d.endsWith(`.${e}`));
  });
}

/**
 * - Title: a client's name or one of its keywords appears as whole words.
 * - Internal: an invite, at least one attendee besides the mailbox (self), every such attendee in teamDomains, and no
 *   client in the title. Without an invite or attendees a meeting is never internal.
 * - Domain: an attendee's domain (the mailbox's own left out) equals or is under one of a client's emailDomains.
 * - One client by title, with domains naming none or only that client → that client by title. One client by domain and
 *   none by title → by domain. Any other combination with a candidate → ambiguous; none at all → none.
 * Attendees without an '@' (rooms, resources) are ignored everywhere.
 */
export function matchClient(meeting: MatchInput, clients: readonly MatchableClient[], teamDomains: readonly string[]): MatchResult {
  const active = clients.filter((c) => c.active !== false);
  const paddedTitle = ` ${normaliseText(meeting.title)} `;
  const byTitle = new Set<number>();
  for (const c of active) {
    if (hasPhrase(paddedTitle, c.name) || c.meetingKeywords.some((k) => hasPhrase(paddedTitle, k))) byTitle.add(c.clientId);
  }

  const others: string[] = [];
  for (const a of meeting.attendees) {
    if (a.self) continue;
    const d = domainOf(a.email);
    if (d !== null) others.push(d);
  }

  if (byTitle.size === 0 && meeting.hasInvite && others.length > 0 && others.every((d) => inDomains(d, teamDomains))) {
    return { kind: 'internal' };
  }

  const byDomain = new Set<number>();
  for (const c of active) {
    if (others.some((d) => inDomains(d, c.emailDomains))) byDomain.add(c.clientId);
  }

  if (byTitle.size > 1 || byDomain.size > 1) return { kind: 'unassigned', reason: 'ambiguous' };
  const [titleId] = byTitle;
  const [domainId] = byDomain;
  if (titleId !== undefined) {
    if (domainId === undefined || domainId === titleId) return { kind: 'client', clientId: titleId, by: 'title' };
    return { kind: 'unassigned', reason: 'ambiguous' };
  }
  if (domainId !== undefined) return { kind: 'client', clientId: domainId, by: 'domain' };
  return { kind: 'unassigned', reason: 'none' };
}
