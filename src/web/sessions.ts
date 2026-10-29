import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { Db } from '../store/db.ts';
import type { Clock } from '../util/clock.ts';
import { serializeCookie } from './http.ts';

/** The owner's session cookie. Its value is the raw session id; the database keeps only its SHA-256. */
export const SESSION_COOKIE = 'wa_session';
/** A session ends 7 days after sign-in, however much it is used. */
export const SESSION_TTL_MS = 7 * 24 * 3_600_000;
/** A session also ends after more than 24 hours without use. */
export const IDLE_TIMEOUT_MS = 24 * 3_600_000;
/** `last_seen_at` is written at most this often, so reading a page does not write to the database on every request. */
const TOUCH_EVERY_MS = 60_000;
const LABEL_MAX = 60;
/** 32 random bytes in base64url, with no padding: exactly 43 characters. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export interface Session {
  email: string;
  /** SHA-256 (hex) of the session's CSRF token. */
  csrfHash: string;
  createdAt: string;
  expiresAt: string;
}

interface Row {
  email: string;
  csrf_hash: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
}

/** SHA-256 in hex: how session ids and CSRF tokens are stored and compared. */
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/** True when the value has the shape of a session id or CSRF token (43 base64url characters). */
export function isToken(value: string | undefined): value is string {
  return value !== undefined && TOKEN.test(value);
}

function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The session's CSRF token, derived from its id (HMAC-SHA256 keyed by the id): only a browser that holds the cookie
 * can get it, through `/dashboard/api/me`, and the database still keeps only its hash. Deriving it lets the page get
 * the same token again after a reload without the server storing it.
 */
export function csrfFor(id: string): string {
  return createHmac('sha256', id).update('wa-dashboard-csrf').digest('base64url');
}

/**
 * Control characters, Unicode line and paragraph breaks (U+0085, U+2028, U+2029) and bidi marks and overrides
 * (U+200E-U+200F, U+202A-U+202E, U+2066-U+2069): anything that could break a one-line text or reverse how it reads.
 */
export const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g;

/** A short one-line browser label (for example "Edge on Windows"), or null. */
function cleanLabel(label: string | undefined): string | null {
  if (label === undefined) return null;
  const one = label.replace(UNSAFE_TEXT, ' ').replace(/\s+/g, ' ').trim();
  return one === '' ? null : one.slice(0, LABEL_MAX).trimEnd();
}

/**
 * The owner's signed-in sessions in `web_sessions` (migration v9). Only SHA-256 hashes of the session id and of the
 * per-session CSRF token are stored; the raw values exist only in the browser (cookie, and the token in page memory).
 */
/** A session that ended: by its id's hash (sign-out, expiry), or every session of an email (sign out everywhere). */
export type SessionEnd = { idHash: string } | { email: string };

export class SessionStore {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #ended = new Set<(e: SessionEnd) => void>();

  constructor(db: Db, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  /**
   * Told when a session ends here (sign-out, sign out everywhere, or found expired), so what is kept in memory for it
   * (the assistant's chat) goes with it. A listener that throws changes nothing. Returns the function that removes it.
   */
  onEnd(fn: (e: SessionEnd) => void): () => void {
    this.#ended.add(fn);
    return () => this.#ended.delete(fn);
  }

  #tell(e: SessionEnd): void {
    for (const fn of this.#ended) {
      try {
        fn(e);
      } catch {
        // a listener's failure must not stop the sign-out
      }
    }
  }

  /** Starts a session. The returned id goes only into the cookie and the CSRF token only to the signed-in page. */
  create(email: string, agentLabel?: string): { id: string; csrf: string } {
    const id = newToken();
    const csrf = csrfFor(id);
    const now = this.#clock.now();
    const at = now.toISOString();
    this.#db
      .prepare(
        `INSERT INTO web_sessions (id_hash, email, csrf_hash, created_at, expires_at, last_seen_at, agent_label)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(hashToken(id), email.trim().toLowerCase(), hashToken(csrf), at, new Date(now.getTime() + SESSION_TTL_MS).toISOString(), at, cleanLabel(agentLabel));
    return { id, csrf };
  }

  /**
   * The live session for this id, or undefined when it is unknown, malformed, past its 7 days or idle for more than
   * 24 hours (such a row is removed at once). Marks the session as used, at most once a minute.
   */
  get(id: string): Session | undefined {
    if (!isToken(id)) return undefined;
    const idHash = hashToken(id);
    const row = this.#db
      .prepare('SELECT email, csrf_hash, created_at, expires_at, last_seen_at FROM web_sessions WHERE id_hash = ?')
      .get(idHash) as Row | undefined;
    if (row === undefined) return undefined;
    const now = this.#clock.now().getTime();
    const expires = Date.parse(row.expires_at);
    const lastSeen = Date.parse(row.last_seen_at);
    // Fail closed: a row whose times cannot be read is treated as ended, never as live forever.
    if (!Number.isFinite(expires) || !Number.isFinite(lastSeen) || now >= expires || now - lastSeen > IDLE_TIMEOUT_MS) {
      this.#db.prepare('DELETE FROM web_sessions WHERE id_hash = ?').run(idHash);
      this.#tell({ idHash });
      return undefined;
    }
    if (now - lastSeen >= TOUCH_EVERY_MS) {
      this.#db.prepare('UPDATE web_sessions SET last_seen_at = ? WHERE id_hash = ?').run(new Date(now).toISOString(), idHash);
    }
    return { email: row.email, csrfHash: row.csrf_hash, createdAt: row.created_at, expiresAt: row.expires_at };
  }

  /** Ends one session (sign-out). An unknown id is a no-op. */
  destroy(id: string): void {
    if (!isToken(id)) return;
    this.#db.prepare('DELETE FROM web_sessions WHERE id_hash = ?').run(hashToken(id));
    this.#tell({ idHash: hashToken(id) });
  }

  /** Ends every session of this owner. Returns how many ended. */
  destroyAllFor(email: string): number {
    const n = this.#db.prepare('DELETE FROM web_sessions WHERE email = ?').run(email.trim().toLowerCase()).changes;
    this.#tell({ email: email.trim().toLowerCase() });
    return n;
  }

  /** Removes expired and idle sessions (the web server calls this hourly). Returns how many were removed. */
  purgeExpired(): number {
    const now = this.#clock.now().getTime();
    const idleCutoff = new Date(now - IDLE_TIMEOUT_MS).toISOString();
    return this.#db
      .prepare('DELETE FROM web_sessions WHERE expires_at <= ? OR last_seen_at < ?')
      .run(new Date(now).toISOString(), idleCutoff).changes;
  }
}

/**
 * Whether the cookies set for a request carry `Secure`: true when the origin that request uses (the public https
 * address) is https. A browser on the Mac itself uses plain `http://localhost`, where a Secure cookie would be dropped
 * and sign-in would loop, so the flag follows each request's origin, never the public URL alone.
 */
export function secureFor(origin: string): boolean {
  return origin.startsWith('https://');
}

/** `wa_session=<id>; HttpOnly; SameSite=Lax; Path=/dashboard; Max-Age=604800`, plus `Secure` behind https. */
export function sessionCookie(id: string, o: { secure: boolean }): string {
  return serializeCookie(SESSION_COOKIE, id, { httpOnly: true, sameSite: 'Lax', path: '/dashboard', maxAge: SESSION_TTL_MS / 1000, secure: o.secure });
}

/** The same cookie emptied with `Max-Age=0`, for signing out. */
export function clearSessionCookie(o: { secure: boolean }): string {
  return serializeCookie(SESSION_COOKIE, '', { httpOnly: true, sameSite: 'Lax', path: '/dashboard', maxAge: 0, secure: o.secure });
}
