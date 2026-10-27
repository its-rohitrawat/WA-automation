import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Self only, no inline script, no framing; forms may post only here and to Google's sign-in. */
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; " +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://accounts.google.com";

/** An expected refusal: the server turns it into `sendError(status, code, message)`. The message must be plain. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Past this much, readJson does not wait for the end of the body: it rejects at once and the server answers 413. Node
 * closes the connection after an answer to an unfinished request, so a slow or endless upload cannot hold it open.
 * The request is not destroyed here: that would reset the connection before the 413 is sent.
 */
const DRAIN_LIMIT_BYTES = 1_048_576;

/**
 * Reads a JSON request body. Over `limitBytes` it rejects with 413 (`too_large`); an empty or unparsable body rejects
 * with 400 (`bad_json`). A moderately oversized body is read to the end and dropped. A declared length over 1 MiB is
 * refused before any of the body is read, and a body that passes 1 MiB is refused as soon as it does; in both cases the
 * server still sends the 413 before the connection is closed.
 */
export function readJson(req: IncomingMessage, limitBytes = 65_536): Promise<unknown> {
  const tooLarge = () => new HttpError(413, 'too_large', 'The request is too large.');
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > DRAIN_LIMIT_BYTES) return Promise.reject(tooLarge());
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > DRAIN_LIMIT_BYTES) {
        // Settled once; later chunks are dropped until Node closes the connection after the 413.
        chunks.length = 0;
        reject(tooLarge());
        return;
      }
      if (size > limitBytes) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (over) {
        reject(tooLarge());
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
      } catch {
        reject(new HttpError(400, 'bad_json', 'The request is not valid JSON.'));
      }
    });
    req.on('error', () => reject(new HttpError(400, 'bad_request', 'The request could not be read.')));
    req.on('aborted', () => reject(new HttpError(400, 'bad_request', 'The request could not be read.')));
  });
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', Buffer.byteLength(text));
  res.end(text);
}

const GENERIC_MESSAGE = 'Something went wrong.';
/** Anything that looks like a file path or a source location. */
const PATH_LIKE = /[A-Za-z]:[\\/]|\\|(?:^|\s)\/[\w.-]+\/|\.(?:ts|js|db|json)\b|\bat\s+\S+\s*\(/;

/** First line only, at most 200 characters; a message that looks like a path or a stack frame becomes the generic one. */
function plainMessage(message: string): string {
  const first = (message.split(/\r?\n/, 1)[0] ?? '').trim();
  if (first === '' || PATH_LIKE.test(first)) return GENERIC_MESSAGE;
  return first.length > 200 ? first.slice(0, 200) : first;
}

/** The one error shape: `{ error: { code, message } }`. Never a stack trace or an internal path. */
export function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message: plainMessage(message) } });
}

/** Parses a Cookie header into a null-prototype record. The first of duplicate names wins; bad encodings stay raw. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name === '' || name in out) continue;
    let value = part.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export interface CookieOptions {
  httpOnly?: boolean;
  sameSite?: 'Lax' | 'Strict' | 'None';
  path?: string;
  /** Seconds; 0 clears the cookie. */
  maxAge?: number;
  secure?: boolean;
}

const COOKIE_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const COOKIE_PATH = /^\/[\x21-\x3a\x3c-\x7e]*$/;

/** `name=value; HttpOnly; SameSite=…; Path=…; Max-Age=…; Secure`, with the value percent-encoded. */
export function serializeCookie(name: string, value: string, opts: CookieOptions): string {
  if (!COOKIE_NAME.test(name)) throw new Error('invalid cookie name');
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.httpOnly) parts.push('HttpOnly');
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  if (opts.path !== undefined) {
    if (!COOKIE_PATH.test(opts.path)) throw new Error('invalid cookie path');
    parts.push(`Path=${opts.path}`);
  }
  if (opts.maxAge !== undefined) {
    if (!Number.isInteger(opts.maxAge) || opts.maxAge < 0) throw new Error('invalid cookie max-age');
    parts.push(`Max-Age=${opts.maxAge}`);
  }
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

/** The headers every response carries. API responses also get `Cache-Control: no-store` (sendJson). */
export function securityHeaders(res: ServerResponse): void {
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
}

/** 12 random hex characters, for tying a log line to a request. */
export function requestId(): string {
  return randomBytes(6).toString('hex');
}
