import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { downloadMediaMessage } from 'baileys';
import type { DestinationStream } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { baileysFetcher, type Downloader } from '../../src/media/fetch.ts';
import type { MediaRef } from '../../src/media/types.ts';
import { createLogger } from '../../src/util/logger.ts';

vi.mock('baileys', async (importOriginal) => ({ ...(await importOriginal<typeof import('baileys')>()), downloadMediaMessage: vi.fn() }));

const MEDIA_KEY = Buffer.alloc(32, 9);
const ref: MediaRef = { contentType: 'documentMessage', url: 'https://mmg.whatsapp.net/d/f', directPath: '/d/f', mediaKey: MEDIA_KEY.toString('base64') };
const LIMITS = { maxBytes: 1_000, timeoutMs: 200 };
const boom = (statusCode: number) => Object.assign(new Error('Failed to fetch stream from https://mmg.whatsapp.net/d/f'), { isBoom: true, output: { statusCode } });
const failing = (e: Error) => vi.fn<Downloader>(async () => { throw e; });
const PINNED = { host: 'mmg.whatsapp.net' };

describe('baileysFetcher', () => {
  it('asks Baileys for a stream of the right content and returns the bytes', async () => {
    const download = vi.fn<Downloader>(async () => Readable.from([Buffer.from('%PDF-'), Buffer.from('1.4')]));
    expect(await baileysFetcher(download)(ref, LIMITS)).toEqual(Buffer.from('%PDF-1.4'));
    const [message, type, options] = download.mock.calls[0]!;
    expect(type).toBe('stream');
    expect(options).toEqual(PINNED);
    expect(message.message).toEqual({ documentMessage: { url: 'https://mmg.whatsapp.net/d/f', directPath: '/d/f', mediaKey: MEDIA_KEY } });
  });

  it('stops a file that grows past the size cap', async () => {
    const download = vi.fn<Downloader>(async () => Readable.from([Buffer.alloc(600), Buffer.alloc(600)]));
    await expect(baileysFetcher(download)(ref, LIMITS)).rejects.toMatchObject({ name: 'MediaUnavailableError', code: 'too_large' });
  });

  it('an expired or missing file is unavailable; a server or network error is worth a retry', async () => {
    for (const status of [404, 410, 403]) await expect(baileysFetcher(failing(boom(status)))(ref, LIMITS)).rejects.toMatchObject({ name: 'MediaUnavailableError', code: 'expired' });
    await expect(baileysFetcher(failing(boom(503)))(ref, LIMITS)).rejects.toMatchObject({ name: 'MediaDownloadError', code: 'http_503' });
    await expect(baileysFetcher(failing(new TypeError('fetch failed')))(ref, LIMITS)).rejects.toMatchObject({ name: 'MediaDownloadError', code: 'network' });
    await expect(baileysFetcher(failing(Object.assign(new Error('bad decrypt'), { code: 'ERR_OSSL_BAD_DECRYPT' })))(ref, LIMITS))
      .rejects.toMatchObject({ name: 'MediaUnavailableError', code: 'decrypt_failed' });
  });

  it('times out when the server never answers or the body never ends', async () => {
    const never = vi.fn<Downloader>(() => new Promise<Readable>(() => {}));
    await expect(baileysFetcher(never)(ref, LIMITS)).rejects.toMatchObject({ name: 'MediaDownloadError', code: 'timeout' });
    const endless = new Readable({ read() {} });
    endless.push(Buffer.from('x'));
    await expect(baileysFetcher(vi.fn<Downloader>(async () => endless))(ref, LIMITS)).rejects.toMatchObject({ code: 'timeout' });
    expect(endless.destroyed).toBe(true);
  });

  it('by default calls Baileys with exactly three arguments, so no re-upload request can be sent', async () => {
    vi.mocked(downloadMediaMessage).mockResolvedValue(Readable.from([Buffer.from('abc')]) as never);
    expect(await baileysFetcher()(ref, LIMITS)).toEqual(Buffer.from('abc'));
    const call = vi.mocked(downloadMediaMessage).mock.calls[0]!;
    expect(call).toHaveLength(3);
    expect(call[1]).toBe('stream');
    expect(call[2]).toEqual(PINNED);
  });

  it('no source file can ask a phone to re-upload media', () => {
    const src = fileURLToPath(new URL('../../src', import.meta.url));
    const files = readdirSync(src, { recursive: true, withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(30);
    for (const f of files) expect(readFileSync(join(f.parentPath, f.name), 'utf8'), f.name).not.toMatch(/updateMediaMessage|reuploadRequest/);
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

describe('baileysFetcher download address (amendment 5a, review C2)', () => {
  const ok = () => vi.fn<Downloader>(async () => Readable.from([Buffer.from('ok')]));
  /** What the downloader was asked to fetch: the file's entry in the message, and the options. */
  async function asked(r: MediaRef) {
    const download = ok();
    expect(await baileysFetcher(download)(r, LIMITS)).toEqual(Buffer.from('ok'));
    expect(download).toHaveBeenCalledTimes(1);
    const [message, , options] = download.mock.calls[0]!;
    return { content: message.message?.documentMessage, options };
  }

  it('refuses an http url on a private address with no direct path, without calling the downloader', async () => {
    const download = ok();
    await expect(baileysFetcher(download)({ ...ref, url: 'http://192.168.1.1/x', directPath: null }, LIMITS))
      .rejects.toMatchObject({ name: 'MediaUnavailableError', code: 'bad_address' });
    expect(download).not.toHaveBeenCalled();
  });

  it('refuses a direct path of @evil.com, even next to a good url', async () => {
    for (const url of [null, 'https://mmg.whatsapp.net/d/f']) {
      const download = ok();
      await expect(baileysFetcher(download)({ ...ref, url, directPath: '@evil.com' }, LIMITS))
        .rejects.toMatchObject({ name: 'MediaUnavailableError', code: 'bad_address' });
      expect(download, String(url)).not.toHaveBeenCalled();
    }
  });

  it('refuses a file with no address, or an address over 2,048 characters', async () => {
    for (const address of [{ url: null, directPath: null }, { url: '', directPath: '' }, { url: null, directPath: `/${'a'.repeat(2_048)}` }]) {
      const download = ok();
      await expect(baileysFetcher(download)({ ...ref, ...address }, LIMITS)).rejects.toMatchObject({ name: 'MediaUnavailableError', code: 'bad_address' });
      expect(download).not.toHaveBeenCalled();
    }
  });

  it('a url on evil.com next to a valid direct path still downloads from mmg.whatsapp.net', async () => {
    for (const url of ['https://evil.com/x', 'https://10.0.0.5:8443/x', '', null]) {
      const { content, options } = await asked({ ...ref, url, directPath: '/v/t1' });
      expect(options, String(url)).toEqual(PINNED);
      expect(content, String(url)).toEqual({ url: 'https://mmg.whatsapp.net/v/t1', directPath: '/v/t1', mediaKey: MEDIA_KEY });
    }
  });

  it('without a direct path, downloads the path and query of the checked url from mmg.whatsapp.net', async () => {
    for (const directPath of [null, '']) {
      const { content, options } = await asked({ ...ref, url: 'https://media-bom1-1.cdn.whatsapp.net/v/t62/x.enc?ccb=11-4&oh=01_Q5A#frag', directPath });
      expect(options).toEqual(PINNED);
      expect(content).toEqual({ url: 'https://mmg.whatsapp.net/v/t62/x.enc?ccb=11-4&oh=01_Q5A', directPath: '/v/t62/x.enc?ccb=11-4&oh=01_Q5A', mediaKey: MEDIA_KEY });
    }
  });

  it("with the real Baileys code, the request goes to mmg.whatsapp.net whatever the sender's url says", async () => {
    const real = await vi.importActual<typeof import('baileys')>('baileys');
    const fetchStub = vi.fn(async (_url: unknown, _init?: unknown) => new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchStub);
    try {
      const fetcher = baileysFetcher((message, type, options) => real.downloadMediaMessage(message, type, options));
      await expect(fetcher({ ...ref, url: 'https://evil.com/x', directPath: '/v/t1' }, LIMITS)).rejects.toMatchObject({ name: 'MediaUnavailableError', code: 'expired' });
      await expect(fetcher({ ...ref, url: 'https://media-bom1-1.cdn.whatsapp.net/v/t2?x=1', directPath: null }, LIMITS)).rejects.toMatchObject({ code: 'expired' });
      expect(fetchStub.mock.calls.map(([url]) => String(url))).toEqual(['https://mmg.whatsapp.net/v/t1', 'https://mmg.whatsapp.net/v/t2?x=1']);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('baileysFetcher closes the HTTP body when it stops reading', () => {
  /** Baileys' shape: the HTTP body piped into a decrypt stream, with nothing listening for errors on the body. */
  function piped(chunks: Buffer[]) {
    const body = new Readable({ read() {} });
    for (const c of chunks) body.push(c);
    return { body, stream: body.pipe(new PassThrough()) };
  }
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it('after the time limit or the size cap, so a later error on the body cannot stop the service', async () => {
    for (const [chunks, code] of [[[Buffer.from('x')], 'timeout'], [[Buffer.alloc(600), Buffer.alloc(600)], 'too_large']] as const) {
      const { body, stream } = piped([...chunks]);
      await expect(baileysFetcher(vi.fn<Downloader>(async () => stream))(ref, LIMITS)).rejects.toMatchObject({ code });
      await settle();
      expect(body.destroyed, code).toBe(true);
      // Without a listener this would throw: in the service, an uncaught exception.
      expect(() => body.emit('error', new Error('terminated')), code).not.toThrow();
    }
  });

  it('when the stream arrives after the time limit', async () => {
    const { body, stream } = piped([Buffer.from('x')]);
    let arrive: (s: Readable) => void = () => {};
    const download = vi.fn<Downloader>(() => new Promise<Readable>((resolve) => { arrive = resolve; }));
    await expect(baileysFetcher(download)(ref, LIMITS)).rejects.toMatchObject({ code: 'timeout' });
    arrive(stream);
    await settle();
    expect(stream.destroyed).toBe(true);
    expect(body.destroyed).toBe(true);
    expect(() => body.emit('error', new Error('terminated'))).not.toThrow();
  });

  it('a download that ends normally still returns every byte', async () => {
    const { body, stream } = piped([Buffer.from('ab'), Buffer.from('c')]);
    body.push(null);
    expect(await baileysFetcher(vi.fn<Downloader>(async () => stream))(ref, LIMITS)).toEqual(Buffer.from('abc'));
  });

  it('with the real Baileys code, the time limit cancels the HTTP body', async () => {
    const real = await vi.importActual<typeof import('baileys')>('baileys');
    let cancelled = false;
    // Some bytes, then nothing: the server stalls.
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(64)); }, cancel() { cancelled = true; } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
    try {
      const fetcher = baileysFetcher((message, type, options) => real.downloadMediaMessage(message, type, options));
      await expect(fetcher(ref, LIMITS)).rejects.toMatchObject({ name: 'MediaDownloadError', code: 'timeout' });
      await settle();
      expect(cancelled).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
