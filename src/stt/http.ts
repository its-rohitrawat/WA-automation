import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { z } from 'zod';

/** One HTTP call, replaceable in tests. */
export type HttpFetch = (url: string, init: RequestInit) => Promise<Response>;

/** The provider answered with an error status: it refused or failed the work. detail holds short codes from the body only. */
export class SttHttpError extends Error {
  readonly status: number;
  readonly detail: string | null;
  constructor(status: number, detail: string | null = null) {
    super(`Provider answered HTTP ${status}`);
    this.name = 'SttHttpError';
    this.status = status;
    this.detail = detail;
  }
}

/** The provider accepted a job and later reported that it failed. */
export class SttJobError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Provider job failed (${code})`);
    this.name = 'SttJobError';
    this.code = code;
  }
}

/** No usable answer (timeout, lost connection, unreadable reply). The provider may still have done, and billed, the work. */
export class SttNoAnswerError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`No usable answer from the provider (${code})`);
    this.name = 'SttNoAnswerError';
    this.code = code;
  }
}

/** Short machine codes found in an error body ("invalid_api_key"). Free text is dropped: it can echo keys or input. */
export function errorCodes(body: unknown): string[] {
  const found = new Set<string>();
  const walk = (value: unknown, depth: number): void => {
    if (depth > 3 || value === null || typeof value !== 'object') return;
    for (const [k, v] of Object.entries(value)) {
      if ((k === 'code' || k === 'type' || k === 'status') && typeof v === 'string') {
        if (/^[A-Za-z0-9_.-]{1,64}$/.test(v)) found.add(v);
      } else walk(v, depth + 1);
    }
  };
  walk(body, 0);
  return [...found].slice(0, 3);
}

function noAnswerCode(e: unknown): string {
  const name = (e as { name?: unknown } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'network';
}

/** Sends one request and returns the response when its status is 2xx. */
export async function send(http: HttpFetch, url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await http(url, init);
  } catch (e) {
    throw new SttNoAnswerError(noAnswerCode(e));
  }
  if (!res.ok) {
    let codes: string[] = [];
    try {
      codes = errorCodes(await res.json());
    } catch {
      // Not JSON: there is nothing to keep.
    }
    throw new SttHttpError(res.status, codes.length > 0 ? codes.join(',') : null);
  }
  return res;
}

/** send(), then the JSON body. */
export async function requestJson(http: HttpFetch, url: string, init: RequestInit): Promise<unknown> {
  const res = await send(http, url, init);
  try {
    return (await res.json()) as unknown;
  } catch (e) {
    throw new SttNoAnswerError(noAnswerCode(e) === 'timeout' ? 'timeout' : 'unreadable_body');
  }
}

/** send(), discarding the body. */
export async function requestOk(http: HttpFetch, url: string, init: RequestInit): Promise<void> {
  const res = await send(http, url, init);
  await res.body?.cancel();
}

/** Checks a provider answer against its expected shape. A mismatch counts as no usable answer. */
export function parseAnswer<T extends z.ZodType>(schema: T, value: unknown, code: string): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new SttNoAnswerError(code);
  return result.data as z.output<T>;
}

function toResponse(res: IncomingMessage, body: Buffer): Response {
  const headers = new Headers();
  for (const [k, v] of Object.entries(res.headers)) {
    if (Array.isArray(v)) for (const x of v) headers.append(k, x);
    else if (v !== undefined) headers.set(k, v);
  }
  const status = res.statusCode ?? 502;
  const empty = status === 204 || status === 304 || body.length === 0;
  return new Response(empty ? null : new Uint8Array(body), { status, headers });
}

/**
 * HttpFetch on node:http(s). Node's fetch stops waiting after 300 s without response headers, and ElevenLabs answers a
 * long meeting only when it has finished. Here only init.signal, the caller's timeout, ends the wait.
 */
export const longFetch: HttpFetch = async (url, init) => {
  // Request serialises FormData and Blob bodies, including the multipart boundary.
  const req = new Request(url, init);
  const body = req.body ? Buffer.from(await req.arrayBuffer()) : null;
  const target = new URL(req.url);
  const transport = target.protocol === 'https:' ? httpsRequest : target.protocol === 'http:' ? httpRequest : null;
  if (!transport) throw new TypeError(`Unsupported protocol ${target.protocol}`);
  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headers[key] = value;
  });
  if (body) headers['content-length'] = String(body.length);
  return await new Promise<Response>((resolve, reject) => {
    const r = transport(target, { method: req.method, headers, signal: init.signal ?? undefined }, (res) => {
      const chunks: Buffer[] = [];
      let ended = false;
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        ended = true;
        resolve(toResponse(res, Buffer.concat(chunks)));
      });
      res.on('error', reject);
      res.on('close', () => {
        if (!ended) reject(Object.assign(new Error('Response closed early'), { code: 'ECONNRESET' }));
      });
    });
    r.on('error', reject);
    r.end(body ?? undefined);
  });
};
