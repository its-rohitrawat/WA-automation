import { createHash, randomBytes } from 'node:crypto';

// Invite tokens (SaaS design section 5): 32 random bytes, sent in the link only; the database keeps their SHA-256.

/** How long an invite link works. */
export const INVITE_TTL_MS = 7 * 86_400_000;

/** A token as it appears in a link: 32 bytes in base64url (43 characters). */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** A new invite token and the hash the database keeps. The token itself is never stored. */
export function newInviteToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: inviteTokenHash(token)! };
}

/** The SHA-256 (hex) of a well-formed token, or null for anything that is not one (so it is never looked up). */
export function inviteTokenHash(token: unknown): string | null {
  if (typeof token !== 'string' || !TOKEN.test(token)) return null;
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * An email address as stored and compared: trimmed and lower-cased (Google's verified email is compared with the
 * invited one case-insensitively). null when it does not look like one address.
 */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const e = raw.trim().toLowerCase();
  if (e.length < 3 || e.length > 254) return null;
  return /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[a-z0-9-]{2,}$/.test(e) ? e : null;
}
