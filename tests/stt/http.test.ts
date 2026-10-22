import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  errorCodes, longFetch, parseAnswer, requestJson, requestOk, SttHttpError, SttNoAnswerError, type HttpFetch,
} from '../../src/stt/http.ts';

const answer = (res: Response | Error): HttpFetch => async () => {
  if (res instanceof Error) throw res;
  return res;
};

describe('requestJson', () => {
  it('returns the JSON body of a 2xx answer', async () => {
    expect(await requestJson(answer(Response.json({ a: 1 })), 'https://x.test', {})).toEqual({ a: 1 });
  });

  it('turns an error status into SttHttpError carrying only short codes', async () => {
    const body = { error: { message: 'Incorrect API key provided: sk-abc', type: 'invalid_request_error', code: 'invalid_api_key' } };
    const err = await requestJson(answer(Response.json(body, { status: 401 })), 'https://x.test', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SttHttpError);
    expect((err as SttHttpError).status).toBe(401);
    expect((err as SttHttpError).detail).toBe('invalid_request_error,invalid_api_key');
    expect(String((err as Error).message)).not.toContain('sk-abc');
  });

  it('keeps the status when the error body is not JSON', async () => {
    const err = await requestJson(answer(new Response('<Error/>', { status: 500 })), 'https://x.test', {}).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'SttHttpError', status: 500, detail: null });
  });

  it('reports a request that threw as no answer, with a code', async () => {
    const timeout = Object.assign(new Error('x'), { name: 'TimeoutError' });
    await expect(requestJson(answer(timeout), 'https://x.test', {})).rejects.toMatchObject({ name: 'SttNoAnswerError', code: 'timeout' });
    const reset = Object.assign(new Error('x'), { code: 'ECONNRESET' });
    await expect(requestJson(answer(reset), 'https://x.test', {})).rejects.toMatchObject({ code: 'ECONNRESET' });
  });

  it('reports an unreadable 2xx body as no answer', async () => {
    await expect(requestJson(answer(new Response('not json')), 'https://x.test', {})).rejects.toMatchObject({ code: 'unreadable_body' });
  });

  it('treats a gateway timeout as no answer: the provider behind the proxy may still bill the work', async () => {
    for (const status of [502, 504, 520, 524]) {
      const err = await requestJson(answer(Response.json({ code: 'x' }, { status })), 'https://x.test', {}).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SttNoAnswerError);
      expect((err as SttNoAnswerError).code).toBe(`http_${status}`);
    }
  });

  it('keeps 408 and 521-523 as a refusal: the request never reached the work', async () => {
    for (const status of [408, 521, 522, 523]) {
      const err = await requestJson(answer(new Response(null, { status })), 'https://x.test', {}).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SttHttpError);
      expect((err as SttHttpError).status).toBe(status);
    }
  });
});

describe('requestOk', () => {
  it('accepts an empty 2xx answer', async () => {
    await expect(requestOk(answer(new Response(null, { status: 201 })), 'https://x.test', {})).resolves.toBeUndefined();
  });
});

describe('errorCodes', () => {
  it('collects code, type and status strings up to three levels deep', () => {
    expect(errorCodes({ detail: { status: 'invalid_api_key', message: 'Invalid API key' } })).toEqual(['invalid_api_key']);
  });

  it('ignores free text that does not look like a code', () => {
    expect(errorCodes({ error: { code: 'has spaces in it' } })).toEqual([]);
  });

  it('drops key-shaped and long hex or numeric values, so a key is never echoed', () => {
    const key = `sk_${'0123456789abcdef'.repeat(2)}01234567`;
    expect(key).toHaveLength(43);
    expect(errorCodes({ error: { code: key } })).toEqual([]);
    expect(errorCodes({ code: 'sk-proj' })).toEqual([]);
    expect(errorCodes({ code: 'req12345678' })).toEqual([]);
    expect(errorCodes({ code: 'deadbeefdeadbeef' })).toEqual([]);
    expect(errorCodes({ code: '_leading_underscore' })).toEqual([]);
    expect(errorCodes({ code: `a${'z'.repeat(40)}` })).toEqual([]);
    expect(errorCodes({ code: `a${'z'.repeat(39)}` })).toEqual([`a${'z'.repeat(39)}`]);
  });

  it('keeps at most three codes', () => {
    expect(errorCodes({ a: { code: 'c1' }, b: { code: 'c2' }, c: { code: 'c3' }, d: { code: 'c4' } })).toEqual(['c1', 'c2', 'c3']);
  });

  it('ignores a code four levels deep', () => {
    expect(errorCodes({ a: { b: { c: { code: 'deep' } } } })).toEqual(['deep']);
    expect(errorCodes({ a: { b: { c: { d: { code: 'deeper' } } } } })).toEqual([]);
  });
});

describe('parseAnswer', () => {
  it('returns the parsed value or throws SttNoAnswerError with the given code', () => {
    const schema = z.object({ id: z.string() });
    expect(parseAnswer(schema, { id: 'a' }, 'bad')).toEqual({ id: 'a' });
    expect(() => parseAnswer(schema, { id: 1 }, 'bad_job')).toThrow(SttNoAnswerError);
  });
});

describe('longFetch', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (req.url === '/slow') return; // never answers
        if (req.url === '/empty') {
          res.writeHead(204);
          res.end();
          return;
        }
        if (req.url === '/odd-status') {
          res.writeHead(600, { 'content-type': 'application/json' });
          res.end('{}');
          return;
        }
        if (req.url === '/gzip') {
          res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
          res.end(gzipSync(JSON.stringify({ zipped: true, asked: req.headers['accept-encoding'] ?? null })));
          return;
        }
        if (req.url === '/bad-gzip') {
          res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
          res.end('not gzip');
          return;
        }
        if (req.url === '/half' || req.url === '/drop') {
          // Promises 100 bytes and sends one.
          res.writeHead(200, { 'content-length': '100' });
          res.write('x');
          if (req.url === '/drop') setImmediate(() => res.socket?.destroy());
          return;
        }
        const body = Buffer.concat(chunks);
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          method: req.method,
          type: req.headers['content-type'] ?? null,
          length: req.headers['content-length'] ?? null,
          received: body.length,
          key: req.headers['x-key'] ?? null,
          encoding: req.headers['accept-encoding'] ?? null,
          hasModel: body.toString('utf8').includes('name="model"'),
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  it('sends a multipart body with its boundary and length', async () => {
    const form = new FormData();
    form.append('model', 'm1');
    form.append('file', new Blob(['abc'], { type: 'audio/mpeg' }), 'a.mp3');
    const res = await longFetch(`${base}/echo`, { method: 'POST', headers: { 'x-key': 'k' }, body: form });
    expect(res.status).toBe(201);
    const echo = (await res.json()) as {
      method: string; type: string; length: string; received: number; key: string; encoding: string; hasModel: boolean;
    };
    expect(echo).toMatchObject({ method: 'POST', key: 'k', hasModel: true, encoding: 'identity' });
    expect(echo.type).toMatch(/^multipart\/form-data; boundary=/);
    expect(Number(echo.length)).toBeGreaterThan(0);
    expect(echo.received).toBe(Number(echo.length));
  });

  it('reports a status outside 200-599 as no answer instead of crashing', async () => {
    await expect(requestJson(longFetch, `${base}/odd-status`, { method: 'GET' })).rejects.toMatchObject({
      name: 'SttNoAnswerError', code: 'bad_status',
    });
  });

  it('decodes a gzip answer and drops the encoding headers', async () => {
    const res = await longFetch(`${base}/gzip`, { method: 'GET', headers: { 'accept-encoding': 'gzip' } });
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(res.headers.get('content-length')).toBeNull();
    expect(await res.json()).toEqual({ zipped: true, asked: 'gzip' });
    expect(await requestJson(longFetch, `${base}/gzip`, { method: 'GET' })).toEqual({ zipped: true, asked: 'identity' });
  });

  it('reports an answer that does not decode as no answer', async () => {
    const err = await requestJson(longFetch, `${base}/bad-gzip`, { method: 'GET' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SttNoAnswerError);
  });

  it('reports a body that stops arriving as a timeout once the signal fires', async () => {
    await expect(requestJson(longFetch, `${base}/half`, { method: 'GET', signal: AbortSignal.timeout(100) })).rejects.toMatchObject({
      name: 'SttNoAnswerError', code: 'timeout',
    });
  });

  it('reports a connection lost mid-body as ECONNRESET', async () => {
    await expect(requestJson(longFetch, `${base}/drop`, { method: 'GET', signal: AbortSignal.timeout(5000) })).rejects.toMatchObject({
      name: 'SttNoAnswerError', code: 'ECONNRESET',
    });
  });

  it('returns an empty body for 204', async () => {
    const res = await longFetch(`${base}/empty`, { method: 'GET' });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('stops waiting when the signal fires', async () => {
    await expect(longFetch(`${base}/slow`, { method: 'GET', signal: AbortSignal.timeout(100) })).rejects.toMatchObject({
      name: expect.stringMatching(/AbortError|TimeoutError/),
    });
  });
});
