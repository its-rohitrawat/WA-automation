import { createCipheriv, createHmac, hkdfSync } from 'node:crypto';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadMediaMessage, encryptedStream } from 'baileys';
import type { DestinationStream } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { baileysFetcher, type HttpFetch } from '../../src/media/fetch.ts';
import type { MediaRef } from '../../src/media/types.ts';
import { createLogger } from '../../src/util/logger.ts';

vi.mock('baileys', async (importOriginal) => ({ ...(await importOriginal<typeof import('baileys')>()), downloadMediaMessage: vi.fn() }));

const MEDIA_KEY = Buffer.alloc(32, 9);
const ref: MediaRef = { contentType: 'documentMessage', url: 'https://mmg.whatsapp.net/d/f', directPath: '/d/f', mediaKey: MEDIA_KEY.toString('base64') };
const LIMITS = { maxBytes: 1_000, timeoutMs: 200 };

const HKDF_INFO = { imageMessage: 'WhatsApp Image Keys', documentMessage: 'WhatsApp Document Keys', audioMessage: 'WhatsApp Audio Keys' } as const;

/**
 * A file as WhatsApp's media servers hold it, built the way Baileys' upload code builds one: AES-256-CBC under keys
 * expanded from the media key with HKDF-SHA256, then the first 10 bytes of HMAC-SHA256(macKey, iv + ciphertext).
 */
function encrypt(plain: Buffer, o: { key?: Buffer; contentType?: MediaRef['contentType']; padding?: boolean } = {}): Buffer {
  const keys = Buffer.from(hkdfSync('sha256', o.key ?? MEDIA_KEY, Buffer.alloc(0), HKDF_INFO[o.contentType ?? 'documentMessage'], 112));
  const iv = keys.subarray(0, 16);
  const aes = createCipheriv('aes-256-cbc', keys.subarray(16, 48), iv).setAutoPadding(o.padding ?? true);
  const cipher = Buffer.concat([aes.update(plain), aes.final()]);
  return Buffer.concat([cipher, createHmac('sha256', keys.subarray(48, 80)).update(iv).update(cipher).digest().subarray(0, 10)]);
}

function splitAt(bytes: Buffer, cuts: number[]): Buffer[] {
  const points = [0, ...cuts, bytes.length];
  return points.slice(1).map((end, i) => bytes.subarray(points[i], end));
}

interface Answer {
  status?: number;
  headers?: Record<string, string>;
  /** Body chunks, sent at once. */
  chunks?: Uint8Array[];
  /** After the chunks: end the body (the default), stall, or fail with this error 20 ms later. */
  then?: 'end' | 'stall' | Error;
  /** Answer after this many ms; never when Infinity. */
  afterMs?: number;
}

/**
 * A stand-in for Node's fetch that treats an abort as Node's fetch does: the call rejects with the signal's reason, or,
 * once answered, the body fails with it.
 */
function fakeFetch(answer: Answer = {}) {
  const fetch = vi.fn<HttpFetch>((_url, init) => new Promise<Response>((resolve, reject) => {
    const signal = init.signal as AbortSignal;
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    signal.addEventListener('abort', () => { reject(signal.reason); stream?.error(signal.reason); }, { once: true });
    if (answer.afterMs === Infinity) return;
    setTimeout(() => {
      const then = answer.then ?? 'end';
      const source = new ReadableStream<Uint8Array>({
        start(c) {
          stream = c;
          for (const chunk of answer.chunks ?? []) c.enqueue(chunk);
          if (then === 'end') c.close();
          else if (then instanceof Error) setTimeout(() => c.error(then), 20);
        },
      });
      resolve(new Response(source, { status: answer.status ?? 200, headers: answer.headers }));
    }, answer.afterMs ?? 0);
  }));
  return { fetch };
}

/** A promise's outcome, readable as soon as it settles without awaiting it. */
function watch(p: Promise<unknown>) {
  const state: { settled: boolean; error?: unknown } = { settled: false };
  p.then(() => { state.settled = true; }, (e: unknown) => { state.settled = true; state.error = e; });
  return state;
}

/** Runs fn and returns whatever reached the process-level error handlers meanwhile and just after. */
async function uncaughtDuring(fn: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const record = (e: unknown) => { seen.push(e); };
  process.on('uncaughtException', record);
  process.on('unhandledRejection', record);
  try {
    await fn();
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    process.off('uncaughtException', record);
    process.off('unhandledRejection', record);
  }
  return seen;
}

const sourceFiles = () => {
  const src = fileURLToPath(new URL('../../src', import.meta.url));
  return readdirSync(src, { recursive: true, withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith('.ts'));
};

describe('baileysFetcher', () => {
  it('fetches the file from the pinned host and returns the decrypted bytes', async () => {
    const plain = Buffer.from('%PDF-1.4 the brief');
    const { fetch } = fakeFetch({ chunks: [encrypt(plain)] });
    expect(await baileysFetcher(fetch)(ref, LIMITS)).toEqual(plain);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://mmg.whatsapp.net/d/f');
    expect(init).toMatchObject({ redirect: 'manual', headers: { Origin: 'https://web.whatsapp.com' } });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.body).toBeUndefined();
  });

  it("decrypts files encrypted by Baileys' own upload code, with the keys of each kind of file", async () => {
    for (const [contentType, mediaType] of [['documentMessage', 'document'], ['imageMessage', 'image'], ['audioMessage', 'audio']] as const) {
      const plain = Buffer.from(`${mediaType} bytes `.repeat(40));
      const enc = await encryptedStream(plain, mediaType);
      try {
        const { fetch } = fakeFetch({ chunks: [readFileSync(enc.encFilePath)] });
        expect(await baileysFetcher(fetch)({ ...ref, contentType, mediaKey: enc.mediaKey.toString('base64') }, LIMITS), contentType).toEqual(plain);
      } finally {
        rmSync(enc.encFilePath, { force: true });
      }
    }
  });

  it('decrypts however the body is split into chunks, including inside the MAC', async () => {
    const plain = Buffer.alloc(100, 'chunked ');
    const enc = encrypt(plain);
    const n = enc.length;
    const everyByte = Array.from({ length: n - 1 }, (_, i) => i + 1);
    for (const cuts of [[], [1], [n - 11], [n - 10], [n - 9], [n - 1], [7, 50, n - 3], everyByte]) {
      expect(await baileysFetcher(fakeFetch({ chunks: splitAt(enc, cuts) }).fetch)(ref, LIMITS), cuts.join(',')).toEqual(plain);
    }
  });

  it('keeps a file of exactly the size cap; one byte more is too large', async () => {
    for (const maxBytes of [1_000, 1_024]) {
      const limits = { ...LIMITS, maxBytes };
      const exact = Buffer.alloc(maxBytes, 'x');
      expect(await baileysFetcher(fakeFetch({ chunks: [encrypt(exact)] }).fetch)(ref, limits), String(maxBytes)).toEqual(exact);
      await expect(baileysFetcher(fakeFetch({ chunks: [encrypt(Buffer.alloc(maxBytes + 1, 'x'))] }).fetch)(ref, limits), String(maxBytes))
        .rejects.toMatchObject({ name: 'MediaUnavailableError', code: 'too_large' });
    }
  });

  it('stops reading a body that grows past the size cap, and cancels it', async () => {
    let pulls = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({ pull(c) { pulls++; c.enqueue(new Uint8Array(100)); }, cancel() { cancelled = true; } });
    await expect(baileysFetcher(vi.fn<HttpFetch>(async () => new Response(endless)))(ref, LIMITS)).rejects.toMatchObject({ name: 'MediaUnavailableError', code: 'too_large' });
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(20);
  });

  it('an expired or missing file is unavailable; a server or network error is worth a retry', async () => {
    for (const status of [400, 401, 403, 404, 410]) {
      await expect(baileysFetcher(fakeFetch({ status }).fetch)(ref, LIMITS), String(status)).rejects.toMatchObject({ name: 'MediaUnavailableError', code: 'expired' });
    }
    for (const status of [429, 500, 503]) {
      await expect(baileysFetcher(fakeFetch({ status }).fetch)(ref, LIMITS), String(status)).rejects.toMatchObject({ name: 'MediaDownloadError', code: `http_${status}` });
    }
    const refused = vi.fn<HttpFetch>(async () => { throw new TypeError('fetch failed'); });
    await expect(baileysFetcher(refused)(ref, LIMITS)).rejects.toMatchObject({ name: 'MediaDownloadError', code: 'network' });
  });

  it('releases the connection of an error answer, whose body is never read', async () => {
    const { fetch } = fakeFetch({ status: 404, chunks: [new Uint8Array(10)], then: 'stall' });
    await expect(baileysFetcher(fetch)(ref, LIMITS)).rejects.toMatchObject({ code: 'expired' });
    expect(fetch.mock.calls[0]![1].signal?.aborted).toBe(true);
  });

  it('never follows a redirect', async () => {
    const { fetch } = fakeFetch({ status: 302, headers: { location: 'https://evil.com/x' } });
    await expect(baileysFetcher(fetch)(ref, LIMITS)).rejects.toMatchObject({ name: 'MediaDownloadError', code: 'http_302' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![1].redirect).toBe('manual');
  });

  it('a file that does not decrypt, or fails its MAC check, is unavailable', async () => {
    const plain = Buffer.from('%PDF-1.4 the brief');
    const good = encrypt(plain);
    const flip = (b: Buffer, i: number) => { const c = Buffer.from(b); c[i] = c[i]! ^ 1; return c; };
    const cases: Record<string, Buffer> = {
      'another media key': encrypt(plain, { key: Buffer.alloc(32, 1) }),
      'the keys of another kind of file': encrypt(plain, { contentType: 'imageMessage' }),
      'a changed ciphertext byte': flip(good, 0),
      'a changed MAC byte': flip(good, good.length - 1),
      'one byte short': good.subarray(0, good.length - 1),
      'no MAC': good.subarray(0, good.length - 10),
      'shorter than a block and a MAC': good.subarray(0, 20),
      empty: Buffer.alloc(0),
      'a valid MAC over bad padding': encrypt(Buffer.alloc(32), { padding: false }),
    };
    for (const [name, bytes] of Object.entries(cases)) {
      await expect(baileysFetcher(fakeFetch({ chunks: [bytes] }).fetch)(ref, LIMITS), name).rejects.toMatchObject({ name: 'MediaUnavailableError', code: 'decrypt_failed' });
    }
  });

  it('no source file can ask a phone to re-upload media', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(30);
    for (const f of files) expect(readFileSync(join(f.parentPath, f.name), 'utf8'), f.name).not.toMatch(/updateMediaMessage|reuploadRequest/);
  });

  it("no source file uses Baileys' streaming media download, whose mid-download network errors are uncaught", () => {
    for (const f of sourceFiles()) {
      expect(readFileSync(join(f.parentPath, f.name), 'utf8'), f.name).not.toMatch(/downloadMediaMessage|downloadContentFromMessage|downloadEncryptedContent/);
    }
  });

  it('the logger censors media keys, addresses and file names', () => {
    const lines: string[] = [];
    const log = createLogger('info', { write: (s: string) => { lines.push(s); } } as unknown as DestinationStream);
    log.info({ mediaKey: 'KEY-SECRET', url: 'https://x/URL-SECRET', directPath: '/PATH-SECRET', fileName: 'NAME-SECRET.pdf', ref: { mediaKey: 'NESTED' }, mediaId: 4 }, 'm');
    const out = lines.join('');
    for (const s of ['KEY-SECRET', 'URL-SECRET', 'PATH-SECRET', 'NAME-SECRET', 'NESTED']) expect(out).not.toContain(s);
    expect(out).toContain('"mediaId":4');
  });

  it('the logger censors those names one level deep too', () => {
    const lines: string[] = [];
    const log = createLogger('info', { write: (s: string) => { lines.push(s); } } as unknown as DestinationStream);
    log.info({ media: { mediaKey: 'KEY-SECRET', url: 'URL-SECRET', directPath: 'PATH-SECRET', fileName: 'NAME-SECRET', ref: 'REF-SECRET' }, mediaId: 4 }, 'm');
    const out = lines.join('');
    for (const s of ['KEY-SECRET', 'URL-SECRET', 'PATH-SECRET', 'NAME-SECRET', 'REF-SECRET']) expect(out).not.toContain(s);
    expect(out).toContain('"mediaId":4');
  });
});

describe('baileysFetcher time limit and network errors (review of Task 5)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('stops waiting at the time limit when the server never answers, and aborts the request', async () => {
    vi.useFakeTimers();
    const { fetch } = fakeFetch({ afterMs: Infinity });
    const result = watch(baileysFetcher(fetch)(ref, LIMITS));
    await vi.advanceTimersByTimeAsync(LIMITS.timeoutMs - 1);
    expect(result.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(result.error).toMatchObject({ name: 'MediaDownloadError', code: 'timeout' });
    expect(fetch.mock.calls[0]![1].signal?.aborted).toBe(true);
  });

  it('one time limit covers the whole download: after a slow answer, the body gets only what is left', async () => {
    vi.useFakeTimers();
    const { fetch } = fakeFetch({ afterMs: LIMITS.timeoutMs * 0.6, chunks: [new Uint8Array(32)], then: 'stall' });
    const result = watch(baileysFetcher(fetch)(ref, LIMITS));
    await vi.advanceTimersByTimeAsync(LIMITS.timeoutMs - 1);
    expect(result.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(result.error).toMatchObject({ name: 'MediaDownloadError', code: 'timeout' });
  });

  it('a connection that drops in the middle of the body is a network error at once, and nothing is left uncaught', async () => {
    const seen = await uncaughtDuring(async () => {
      const { fetch } = fakeFetch({ chunks: [encrypt(Buffer.alloc(5_000)).subarray(0, 64)], then: new TypeError('terminated') });
      const started = performance.now();
      await expect(baileysFetcher(fetch)(ref, { maxBytes: 10_000, timeoutMs: 5_000 })).rejects.toMatchObject({ name: 'MediaDownloadError', code: 'network' });
      expect(performance.now() - started).toBeLessThan(2_500);
    });
    expect(seen).toEqual([]);
  });
});

describe('baileysFetcher download address (amendment 5a, review C2)', () => {
  /** The address the file was requested from. */
  async function requested(r: MediaRef): Promise<string> {
    const { fetch } = fakeFetch({ chunks: [encrypt(Buffer.from('ok'))] });
    expect(await baileysFetcher(fetch)(r, LIMITS)).toEqual(Buffer.from('ok'));
    expect(fetch).toHaveBeenCalledTimes(1);
    return fetch.mock.calls[0]![0];
  }

  it('refuses an http url on a private address with no direct path, without a download', async () => {
    const { fetch } = fakeFetch();
    await expect(baileysFetcher(fetch)({ ...ref, url: 'http://192.168.1.1/x', directPath: null }, LIMITS))
      .rejects.toMatchObject({ name: 'MediaUnavailableError', code: 'bad_address' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a direct path of @evil.com, even next to a good url', async () => {
    for (const url of [null, 'https://mmg.whatsapp.net/d/f']) {
      const { fetch } = fakeFetch();
      await expect(baileysFetcher(fetch)({ ...ref, url, directPath: '@evil.com' }, LIMITS))
        .rejects.toMatchObject({ name: 'MediaUnavailableError', code: 'bad_address' });
      expect(fetch, String(url)).not.toHaveBeenCalled();
    }
  });

  it('refuses a file with no address, or an address over 2,048 characters', async () => {
    for (const address of [{ url: null, directPath: null }, { url: '', directPath: '' }, { url: null, directPath: `/${'a'.repeat(2_048)}` }]) {
      const { fetch } = fakeFetch();
      await expect(baileysFetcher(fetch)({ ...ref, ...address }, LIMITS)).rejects.toMatchObject({ name: 'MediaUnavailableError', code: 'bad_address' });
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it('a url on evil.com next to a valid direct path still downloads from mmg.whatsapp.net', async () => {
    for (const url of ['https://evil.com/x', 'https://10.0.0.5:8443/x', '', null]) {
      expect(await requested({ ...ref, url, directPath: '/v/t1' }), String(url)).toBe('https://mmg.whatsapp.net/v/t1');
    }
  });

  it('without a direct path, downloads the path and query of the checked url from mmg.whatsapp.net', async () => {
    for (const directPath of [null, '']) {
      expect(await requested({ ...ref, url: 'https://media-bom1-1.cdn.whatsapp.net/v/t62/x.enc?ccb=11-4&oh=01_Q5A#frag', directPath }))
        .toBe('https://mmg.whatsapp.net/v/t62/x.enc?ccb=11-4&oh=01_Q5A');
    }
  });
});

describe('baileysFetcher by default', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("uses Node's fetch and never Baileys' downloader, so no re-upload request can be sent", async () => {
    const { fetch } = fakeFetch({ chunks: [encrypt(Buffer.from('abc'))] });
    vi.stubGlobal('fetch', fetch);
    expect(await baileysFetcher()(ref, LIMITS)).toEqual(Buffer.from('abc'));
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['https://mmg.whatsapp.net/d/f']);
    expect(downloadMediaMessage).not.toHaveBeenCalled();
  });

  it("requests mmg.whatsapp.net whatever the sender's url says", async () => {
    const { fetch } = fakeFetch({ status: 404 });
    vi.stubGlobal('fetch', fetch);
    await expect(baileysFetcher()({ ...ref, url: 'https://evil.com/x', directPath: '/v/t1' }, LIMITS)).rejects.toMatchObject({ name: 'MediaUnavailableError', code: 'expired' });
    await expect(baileysFetcher()({ ...ref, url: 'https://media-bom1-1.cdn.whatsapp.net/v/t2?x=1', directPath: null }, LIMITS)).rejects.toMatchObject({ code: 'expired' });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['https://mmg.whatsapp.net/v/t1', 'https://mmg.whatsapp.net/v/t2?x=1']);
  });

  it('a body that fails after 64 bytes fails only this download: no uncaught exception stops the service', async () => {
    const seen = await uncaughtDuring(async () => {
      vi.stubGlobal('fetch', fakeFetch({ chunks: [new Uint8Array(64)], then: new TypeError('terminated') }).fetch);
      const started = performance.now();
      await expect(baileysFetcher()(ref, { maxBytes: 1_000_000, timeoutMs: 5_000 })).rejects.toMatchObject({ name: 'MediaDownloadError', code: 'network' });
      expect(performance.now() - started).toBeLessThan(2_500);
    });
    expect(seen).toEqual([]);
  });
});
