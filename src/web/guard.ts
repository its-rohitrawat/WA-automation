import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { systemClock } from '../util/clock.ts';
import type { Clock } from '../util/clock.ts';
import { HttpError, parseCookies } from './http.ts';
import { hashToken, isToken, SESSION_COOKIE } from './sessions.ts';
import type { Session, SessionStore } from './sessions.ts';

/** A signed-in owner's session, with the raw id from the cookie (kept in memory only, for sign-out). */
export interface OwnerSession extends Session {
  id: string;
}

export interface GuardDeps {
  sessions: Pick<SessionStore, 'get' | 'destroy'>;
  /** DASHBOARD_OWNER_EMAILS (lower-cased). A session whose email has since been removed from the list is refused. */
  ownerEmails: readonly string[];
  /** DASHBOARD_PUBLIC_URL: a bare origin such as `https://dash.example.com`, or absent. */
  publicUrl?: string;
  /** The port the dashboard listens on, for the localhost origins (the bound port, which tests choose at random). */
  port: () => number | undefined;
}

export interface Guard {
  /** The signed-in owner's session, or a 401 (`HttpError`, which the server sends as JSON). */
  requireOwner(req: IncomingMessage): Promise<OwnerSession>;
  /**
   * For every request but GET and HEAD: the `Origin` header must be the public origin or the localhost origin, and the
   * `X-CSRF-Token` header must hash to the session's CSRF hash. Otherwise a 403.
   */
  requireCsrf(req: IncomingMessage, session: Session): void;
}

const unauthorized = () => new HttpError(401, 'unauthorized', 'Sign in to continue.');
const refused = () => new HttpError(403, 'csrf', 'This request could not be verified. Reload the page and try again.');

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === 'string' ? v : undefined;
}

/** Compares two hex SHA-256 strings in constant time. */
function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createGuard(deps: GuardDeps): Guard {
  const owners = new Set(deps.ownerEmails.map((e) => e.trim().toLowerCase()));

  function allowedOrigins(): Set<string> {
    const out = new Set<string>();
    if (deps.publicUrl !== undefined) out.add(new URL(deps.publicUrl).origin);
    const port = deps.port();
    if (port !== undefined && port > 0) {
      out.add(`http://localhost:${port}`);
      out.add(`http://127.0.0.1:${port}`);
    }
    return out;
  }

  return {
    async requireOwner(req) {
      const id = parseCookies(header(req, 'cookie'))[SESSION_COOKIE];
      if (!isToken(id)) throw unauthorized();
      const session = await deps.sessions.get(id);
      if (session === undefined) throw unauthorized();
      if (!owners.has(session.email)) {
        await deps.sessions.destroy(id);
        throw unauthorized();
      }
      return { ...session, id };
    },

    requireCsrf(req, session) {
      const method = req.method ?? 'GET';
      if (method === 'GET' || method === 'HEAD') return;
      const origin = header(req, 'origin');
      if (origin === undefined || !allowedOrigins().has(origin)) throw refused();
      const token = header(req, 'x-csrf-token');
      if (!isToken(token) || !sameHash(hashToken(token), session.csrfHash)) throw refused();
    },
  };
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * The key a rate limit counts by. The server listens on 127.0.0.1 only, so a request that came through the tunnel
 * arrives from loopback with `CF-Connecting-IP` naming the real visitor; that header is used only then, and only when
 * it is a single IP address. Otherwise the socket's own address.
 */
export function clientAddress(req: IncomingMessage): string {
  const remote = req.socket.remoteAddress;
  if (remote !== undefined && LOOPBACK.has(remote)) {
    const cf = header(req, 'cf-connecting-ip')?.trim();
    if (cf !== undefined && isIP(cf) !== 0) return rateKey(cf);
  }
  return remote === undefined ? 'unknown' : rateKey(remote);
}

/** The 8 hextets of an IPv6 address (a trailing dotted IPv4 part becomes two), or undefined when it cannot be read. */
function hextets(ip: string): number[] | undefined {
  const bare = ip.split('%')[0]!.toLowerCase();
  const halves = bare.split('::');
  if (halves.length > 2) return undefined;
  const parse = (s: string): number[] | undefined => {
    if (s === '') return [];
    const out: number[] = [];
    for (const part of s.split(':')) {
      if (part.includes('.')) {
        if (isIP(part) !== 4) return undefined;
        const [a, b, c, d] = part.split('.').map(Number) as [number, number, number, number];
        out.push((a << 8) | b, (c << 8) | d);
      } else if (/^[0-9a-f]{1,4}$/.test(part)) {
        out.push(parseInt(part, 16));
      } else {
        return undefined;
      }
    }
    return out;
  };
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  if (head === undefined || tail === undefined) return undefined;
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return undefined;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

/**
 * One rate-limit key per client: an IPv4 address as it is, an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) as its IPv4
 * address, and any other IPv6 address as its /64 prefix (one home or one server usually holds a whole /64, so counting
 * each address on its own would give it endless buckets).
 */
export function rateKey(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  const h = hextets(ip);
  if (h === undefined) return ip;
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) {
    return `${h[6]! >> 8}.${h[6]! & 0xff}.${h[7]! >> 8}.${h[7]! & 0xff}`;
  }
  return `${h.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}

export interface RateLimit {
  capacity: number;
  refillPerSec: number;
}

/** Sign-in and its callback: 10 a minute per client. */
export const SIGNIN_LIMIT: Readonly<RateLimit> = Object.freeze({ capacity: 10, refillPerSec: 10 / 60 });
/** Requests that change something: 30 a minute per client. */
export const ACTION_LIMIT: Readonly<RateLimit> = Object.freeze({ capacity: 30, refillPerSec: 30 / 60 });

interface Bucket {
  tokens: number;
  at: number;
}

/** Float rounding must not turn exactly one refilled token into 0.9999…. */
const EPSILON = 1e-9;

/** A token bucket per client address: `capacity` requests at once, refilled at `refillPerSec`. Memory only. */
export class RateLimiter {
  readonly #capacity: number;
  readonly #refillPerSec: number;
  readonly #clock: Clock;
  readonly #maxKeys: number;
  readonly #buckets = new Map<string, Bucket>();

  constructor(o: RateLimit & { clock?: Clock; maxKeys?: number }) {
    if (!(o.capacity >= 1) || !(o.refillPerSec > 0)) throw new Error('invalid rate limit');
    this.#capacity = o.capacity;
    this.#refillPerSec = o.refillPerSec;
    this.#clock = o.clock ?? systemClock;
    this.#maxKeys = o.maxKeys ?? 10_000;
  }

  #refill(b: Bucket, now: number): void {
    // A clock that steps back adds nothing, and the bucket restarts from the new time.
    const elapsed = Math.max(0, now - b.at);
    b.tokens = Math.min(this.#capacity, b.tokens + (elapsed / 1000) * this.#refillPerSec);
    b.at = now;
  }

  /**
   * Takes one request from this key's bucket: true when allowed, false when over the limit. When the limiter already
   * tracks `maxKeys` clients and every one of them is out of requests, a new client is refused too (fail closed) until
   * some bucket refills, rather than forgetting a client that is over its limit.
   */
  take(key: string): boolean {
    const now = this.#clock.now().getTime();
    let b = this.#buckets.get(key);
    if (b === undefined) {
      this.#prune(now);
      if (this.#buckets.size >= this.#maxKeys) return false;
      b = { tokens: this.#capacity, at: now };
      this.#buckets.set(key, b);
    } else {
      this.#refill(b, now);
    }
    if (b.tokens + EPSILON < 1) return false;
    b.tokens = Math.max(0, b.tokens - 1);
    return true;
  }

  /** Seconds until this key may make one more request (at least 1). */
  retryAfter(key: string): number {
    const b = this.#buckets.get(key);
    if (b === undefined) return 1;
    return Math.max(1, Math.ceil((1 - b.tokens) / this.#refillPerSec - EPSILON));
  }

  /** Counts the request against its client; over the limit it sets `Retry-After` and throws a 429. */
  hit(req: IncomingMessage, res: ServerResponse): void {
    const key = clientAddress(req);
    if (this.take(key)) return;
    res.setHeader('Retry-After', String(this.retryAfter(key)));
    throw new HttpError(429, 'rate_limited', 'Too many requests. Wait a minute and try again.');
  }

  /** How many clients are tracked (for tests). */
  size(): number {
    return this.#buckets.size;
  }

  /**
   * Before a new key is added at the cap: drop buckets that are full again, then the oldest ones that still have a
   * request left. A bucket that is out of requests is never dropped, so a client cannot flush its own limit by
   * flooding the limiter with new addresses.
   */
  #prune(now: number): void {
    if (this.#buckets.size < this.#maxKeys) return;
    for (const [k, b] of this.#buckets) {
      this.#refill(b, now);
      if (b.tokens >= this.#capacity) this.#buckets.delete(k);
    }
    for (const [k, b] of this.#buckets) {
      if (this.#buckets.size < this.#maxKeys) break;
      if (b.tokens + EPSILON >= 1) this.#buckets.delete(k);
    }
  }
}
