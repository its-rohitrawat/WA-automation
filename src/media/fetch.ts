import { Readable } from 'node:stream';
import { downloadMediaMessage, type MediaDownloadOptions, type WAMessage } from 'baileys';
import { isSafeMediaAddress } from './ref.ts';
import type { MediaRef } from './types.ts';

/** The file can never be fetched (expired, removed, too large, undecryptable, unsafe address). Not retried. */
export class MediaUnavailableError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Media unavailable (${code})`);
    this.name = 'MediaUnavailableError';
    this.code = code;
  }
}

/** A network problem that may pass. Retried. */
export class MediaDownloadError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Media download failed (${code})`);
    this.name = 'MediaDownloadError';
    this.code = code;
  }
}

export interface FetchLimits {
  maxBytes: number;
  timeoutMs: number;
}

export type MediaFetcher = (ref: MediaRef, limits: FetchLimits) => Promise<Buffer>;
export type Downloader = (message: WAMessage, type: 'stream', options: MediaDownloadOptions) => Promise<Readable>;

/**
 * Exactly three arguments, never a fourth. Without that context object Baileys cannot ask the sender's phone to upload
 * an expired file again (that request is an outbound message). An expired file is simply marked unavailable.
 */
const passiveDownload: Downloader = (message, type, options) => downloadMediaMessage(message, type, options);

/** Every file is downloaded from this host. The sender's url never chooses it (amendment 5a). */
const MEDIA_HOST = 'mmg.whatsapp.net';

/** HTTP statuses that mean the file is gone for good. */
const GONE = new Set([400, 401, 403, 404, 410]);

function classify(e: unknown): Error {
  if (e instanceof MediaUnavailableError || e instanceof MediaDownloadError) return e;
  const status = (e as { output?: { statusCode?: unknown } } | null)?.output?.statusCode;
  if (typeof status === 'number') return GONE.has(status) ? new MediaUnavailableError('expired') : new MediaDownloadError(`http_${status}`);
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code.startsWith('ERR_OSSL')) return new MediaUnavailableError('decrypt_failed');
  return new MediaDownloadError('network');
}

/**
 * The path to fetch from MEDIA_HOST, or null when the address is unsafe. The address comes from the sender's phone:
 * ingest checked it before sealing, and it is checked again here. A checked direct path is used as it is. Without one,
 * only the path and query of the checked url are used, never its host. An empty string counts as absent.
 */
function downloadPath(ref: MediaRef): string | null {
  if (!isSafeMediaAddress(ref)) return null;
  if (ref.directPath) return ref.directPath;
  const url = ref.url ? URL.parse(ref.url) : null;
  return url ? url.pathname + url.search : null;
}

/** A message carrying only what Baileys needs to fetch and decrypt the file from MEDIA_HOST. */
function toMessage(ref: MediaRef, path: string): WAMessage {
  // Baileys checks for a url key before downloading, so there is one, on MEDIA_HOST too. With a direct path Baileys
  // fetches from the host option plus the direct path.
  const content = { url: `https://${MEDIA_HOST}${path}`, directPath: path, mediaKey: Buffer.from(ref.mediaKey, 'base64') };
  return { key: { remoteJid: 'media@download', id: 'download', fromMe: false }, message: { [ref.contentType]: content } } as unknown as WAMessage;
}

/**
 * Baileys pipes the HTTP body into its decrypt stream and returns only the decrypt stream. When reading stops early
 * (time limit, size cap), Node unpipes the body but leaves it open and paused, and an error on it later, such as the
 * server dropping the idle connection, has no listener: an uncaught exception, which stops the service. The body is
 * the stream that unpipes, so it is closed here and its late errors are ignored.
 */
function closeBodyOnUnpipe(stream: Readable): Readable {
  stream.once('unpipe', (body: unknown) => {
    if (body instanceof Readable) {
      body.on('error', () => {});
      body.destroy();
    }
  });
  return stream;
}

function withTimeout<T>(p: Promise<T>, ms: number, onLate: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      done = true;
      reject(new MediaDownloadError('timeout'));
    }, ms);
    p.then(
      (v) => {
        if (done) return onLate(v);
        done = true;
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

async function collect(stream: Readable, maxBytes: number, timeoutMs: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  // Baileys pipes the HTTP body without forwarding its errors (review M17), so a network error in the middle of a
  // download never reaches this stream and shows up here as the timeout. Node raises that error on the body itself,
  // which has no listener while it is piped (an uncaught exception); Baileys gives no handle on the body to prevent it.
  const timer = setTimeout(() => stream.destroy(new MediaDownloadError('timeout')), timeoutMs);
  try {
    for await (const chunk of stream) {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += b.length;
      if (total > maxBytes) {
        stream.destroy();
        throw new MediaUnavailableError('too_large');
      }
      chunks.push(b);
    }
  } catch (e) {
    throw classify(e);
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(chunks);
}

/**
 * Downloads and decrypts one file with a size cap and an overall time limit, always from MEDIA_HOST. An unsafe address
 * is refused without a download. Errors carry codes only, never the URL.
 */
export function baileysFetcher(download: Downloader = passiveDownload): MediaFetcher {
  return async (ref, limits) => {
    const path = downloadPath(ref);
    if (path === null) throw new MediaUnavailableError('bad_address');
    const deadline = Date.now() + limits.timeoutMs;
    let stream: Readable;
    try {
      const started = download(toMessage(ref, path), 'stream', { host: MEDIA_HOST }).then(closeBodyOnUnpipe);
      stream = await withTimeout(started, limits.timeoutMs, (late) => late.destroy());
    } catch (e) {
      throw classify(e);
    }
    return collect(stream, limits.maxBytes, Math.max(1, deadline - Date.now()));
  };
}
