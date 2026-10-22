import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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
        const body = Buffer.concat(chunks).toString('utf8');
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          method: req.method,
          type: req.headers['content-type'] ?? null,
          length: req.headers['content-length'] ?? null,
          key: req.headers['x-key'] ?? null,
          hasModel: body.includes('name="model"'),
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
    const echo = (await res.json()) as { method: string; type: string; length: string; key: string; hasModel: boolean };
    expect(echo).toMatchObject({ method: 'POST', key: 'k', hasModel: true });
    expect(echo.type).toMatch(/^multipart\/form-data; boundary=/);
    expect(Number(echo.length)).toBeGreaterThan(0);
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
