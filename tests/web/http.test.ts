import { describe, expect, it } from 'vitest';
import {
  CONTENT_SECURITY_POLICY,
  HttpError,
  jsonText,
  parseCookies,
  requestId,
  securityHeaders,
  sendError,
  sendJson,
  serializeCookie,
} from '../../src/web/http.ts';
import type { ServerResponse } from 'node:http';

/** Just enough of ServerResponse to record what the helpers write. */
function fakeRes() {
  const headers: Record<string, string | number> = {};
  const out = { status: 0, body: '', ended: false };
  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader(name: string, value: string | number) {
      headers[name.toLowerCase()] = value;
      return res;
    },
    end(chunk?: string) {
      out.status = res.statusCode;
      out.body = chunk ?? '';
      out.ended = true;
      return res;
    },
  };
  return { res: res as unknown as ServerResponse, headers, out };
}

describe('securityHeaders', () => {
  it('sets the strict CSP and the other security headers', () => {
    const { res, headers } = fakeRes();
    securityHeaders(res);
    expect(CONTENT_SECURITY_POLICY).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; " +
        "frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://accounts.google.com",
    );
    expect(headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('same-origin');
  });
});

describe('sendJson and sendError', () => {
  it('sendJson writes JSON with no-store', () => {
    const { res, headers, out } = fakeRes();
    sendJson(res, 201, { a: 1 });
    expect(out.status).toBe(201);
    expect(JSON.parse(out.body)).toEqual({ a: 1 });
    expect(headers['content-type']).toBe('application/json; charset=utf-8');
    expect(headers['cache-control']).toBe('no-store');
    expect(headers['content-length']).toBe(Buffer.byteLength(out.body));
  });

  it('refuses a Promise anywhere in a body (a missing await), naming its key, and sends nothing', () => {
    const pending = Promise.resolve({ name: 'Acme' });
    for (const [body, where] of [[pending, ''], [{ client: pending }, ' at "client"'], [{ a: { b: [1, pending] } }, ' at "1"']] as const) {
      expect(() => jsonText(body), where).toThrow(new TypeError(`response body is a Promise${where}: missing await`));
      const { res, out } = fakeRes();
      expect(() => sendJson(res, 200, body)).toThrow(TypeError);
      expect(out.body, where).toBe(''); // nothing went out, not even {}
    }
    // A plain object with a then that is not a function is data, not a Promise.
    expect(jsonText({ then: 'later', n: null })).toBe('{"then":"later","n":null}');
  });

  it('sendError uses the { error: { code, message } } shape', () => {
    const { res, out } = fakeRes();
    sendError(res, 404, 'not_found', 'Not found.');
    expect(out.status).toBe(404);
    expect(JSON.parse(out.body)).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
  });

  it('sendError keeps messages plain: one line, no stack frames, no file paths, bounded length', () => {
    const { res, out } = fakeRes();
    sendError(res, 400, 'bad', `Bad thing\n    at foo (C:\\Users\\x\\src\\web\\server.ts:10:5)\n    at /home/a/b.ts:1:1${'x'.repeat(500)}`);
    const msg = (JSON.parse(out.body) as { error: { message: string } }).error.message;
    expect(msg).toBe('Bad thing');
    const { res: res2, out: out2 } = fakeRes();
    sendError(res2, 400, 'bad', 'y'.repeat(1000));
    expect((JSON.parse(out2.body) as { error: { message: string } }).error.message.length).toBeLessThanOrEqual(200);
    const { res: res3, out: out3 } = fakeRes();
    sendError(res3, 400, 'bad', 'ENOENT: no such file, open C:\\Users\\Dell\\data\\tracker.db');
    expect(out3.body).not.toMatch(/Users|tracker\.db/);
  });

  it('sendError replaces real paths, file URLs and stack frames with the generic message', () => {
    const generic = [
      'open /Users/dell/data/tracker.db failed',
      'cannot read /home/a/b',
      'see file:///C:/x/y.ts',
      'failed at Object.<anonymous> (src/web/server.ts:10:5)',
      'failed at foo (node:internal/fs:1:2)',
      'D:/data/x failed',
      'a\\b failed',
    ];
    for (const m of generic) {
      const { res, out } = fakeRes();
      sendError(res, 400, 'bad', m);
      expect((JSON.parse(out.body) as { error: { message: string } }).error.message, m).toBe('Something went wrong.');
    }
  });

  it('sendError lets ordinary plain messages through unchanged', () => {
    const plain = [
      'Upload a groups.json file.',
      'allowed-groups.json could not be written.',
      'Try again at 10:00 (local time).',
      'Choose a .js-free browser',
      'Use and/or skip.',
      'The tracker.db file is busy.',
    ];
    for (const m of plain) {
      const { res, out } = fakeRes();
      sendError(res, 400, 'bad', m);
      expect((JSON.parse(out.body) as { error: { message: string } }).error.message, m).toBe(m);
    }
  });
});

describe('HttpError', () => {
  it('carries a status and a code', () => {
    const e = new HttpError(413, 'too_large', 'The request is too large.');
    expect(e).toBeInstanceOf(Error);
    expect(e.status).toBe(413);
    expect(e.code).toBe('too_large');
    expect(e.message).toBe('The request is too large.');
  });
});

describe('parseCookies', () => {
  it('parses pairs, trims, decodes and keeps the first of duplicates', () => {
    const c = parseCookies('a=1; b = two ; c=x%20y; a=9; d="q"; e=v=w');
    expect(c).toEqual({ a: '1', b: 'two', c: 'x y', d: 'q', e: 'v=w' });
  });

  it('copes with a missing header, junk and bad encodings', () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('')).toEqual({});
    expect(parseCookies(';;novalue; =x; f=%E0%A4%A')).toEqual({ f: '%E0%A4%A' });
  });

  it('cannot reach the object prototype', () => {
    const c = parseCookies('__proto__=x; constructor=y');
    expect(Object.getPrototypeOf(c)).toBeNull();
    expect(c.__proto__).toBe('x');
    expect(c.constructor).toBe('y');
  });
});

describe('serializeCookie', () => {
  it('writes the flags', () => {
    expect(serializeCookie('wa_session', 'abc', { httpOnly: true, sameSite: 'Lax', path: '/dashboard', maxAge: 604800 })).toBe(
      'wa_session=abc; HttpOnly; SameSite=Lax; Path=/dashboard; Max-Age=604800',
    );
    expect(serializeCookie('wa_session', '', { httpOnly: true, sameSite: 'Lax', path: '/dashboard', maxAge: 0, secure: true })).toBe(
      'wa_session=; HttpOnly; SameSite=Lax; Path=/dashboard; Max-Age=0; Secure',
    );
    expect(serializeCookie('a', 'b', {})).toBe('a=b');
  });

  it('encodes the value', () => {
    expect(serializeCookie('a', 'x y;z', {})).toBe('a=x%20y%3Bz');
  });

  it('refuses a bad name, path or max-age', () => {
    expect(() => serializeCookie('a b', 'x', {})).toThrow();
    expect(() => serializeCookie('a;b', 'x', {})).toThrow();
    expect(() => serializeCookie('', 'x', {})).toThrow();
    expect(() => serializeCookie('a', 'x', { path: '/a;b' })).toThrow();
    expect(() => serializeCookie('a', 'x', { maxAge: -1 })).toThrow();
    expect(() => serializeCookie('a', 'x', { maxAge: 1.5 })).toThrow();
  });
});

describe('requestId', () => {
  it('is 12 random hex characters', () => {
    const ids = new Set(Array.from({ length: 200 }, () => requestId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{12}$/);
  });
});
