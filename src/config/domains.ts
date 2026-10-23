import { z } from 'zod';

/**
 * Public mail domains. A rule on one of these would match everyone who uses it, so neither a client's
 * `emailDomains` (allowed-groups.json) nor TEAM_EMAIL_DOMAINS (.env) may list one.
 */
export const PUBLIC_MAIL_DOMAINS: readonly string[] = [
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'yahoo.co.in',
  'icloud.com',
  'me.com',
  'rediffmail.com',
  'proton.me',
  'protonmail.com',
  'zoho.com',
  'aol.com',
  'yahoo.in',
  'ymail.com',
  'msn.com',
  'live.in',
  'hotmail.co.uk',
  'pm.me',
  'gmx.com',
  'mail.com',
  'yandex.com',
];

const PUBLIC = new Set(PUBLIC_MAIL_DOMAINS);

// Lower-case labels of letters, digits and inner hyphens, then a top-level label of letters: client.com, client.co.in.
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** True for a lower-case domain name such as client.com. Not an email address or a URL. */
export function isDomain(s: string): boolean {
  return DOMAIN.test(s);
}

/** One domain: trimmed and lower-cased. The messages never contain the value. */
export const DomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine(isDomain, 'must look like a domain such as client.com')
  .refine((d) => !PUBLIC.has(d), 'must not be a public mail domain such as gmail.com (it would match everyone)');
