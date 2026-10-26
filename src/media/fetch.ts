import { createDecipheriv, createHmac, timingSafeEqual, type Decipheriv, type Hmac } from 'node:crypto';
import { DEFAULT_ORIGIN, getMediaKeys, type MediaType } from 'baileys';
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
/** The HTTP request, replaceable in tests. The default is Node's own fetch. */
export type HttpFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Every file is downloaded from this host. The sender's url never chooses it (amendment 5a). */
const MEDIA_HOST = 'mmg.whatsapp.net';

/** HTTP statuses that mean the file is gone for good. */
const GONE = new Set([400, 401, 403, 404, 410]);

/** The key derivation each kind of file uses, as Baileys picks it from the content type. */
const KEY_TYPES: Record<MediaRef['contentType'], MediaType> = { imageMessage: 'image', documentMessage: 'document', audioMessage: 'audio' };

const BLOCK_BYTES = 16;
const MAC_BYTES = 10;

function classify(e: unknown): Error {
  if (e instanceof MediaUnavailableError || e instanceof MediaDownloadError) return e;
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code.startsWith('ERR_OSSL')) return new MediaUnavailableError('decrypt_failed');
  return new MediaDownloadError('network');
}

const statusError = (status: number): Error =>
  GONE.has(status) ? new MediaUnavailableError('expired') : new MediaDownloadError(`http_${status}`);

/**
 * The path to fetch from MEDIA_HOST, or null when the address is unsafe. The address comes from the sender's phone:
 * ingest checked it before sealing, and it is checked again here. A checked direct path is used as it is. Without one,
 * only the path and search string of the checked url are used, never its host. An empty string counts as absent.
 */
function downloadPath(ref: MediaRef): string | null {
  if (!isSafeMediaAddress(ref)) return null;
  if (ref.directPath) return ref.directPath;
  const url = ref.url ? URL.parse(ref.url) : null;
  return url ? url.pathname + url.search : null;
}

/**
 * WhatsApp's media encryption: AES-256-CBC, followed by the first 10 bytes of HMAC-SHA256(macKey, iv + ciphertext).
 * Decrypts as the body arrives and holds back the last 10 bytes seen, which may be the MAC. Nothing decrypted may be
 * used until final() has checked the MAC.
 */
class Decrypter {
  readonly #decipher: Decipheriv;
  readonly #hmac: Hmac;
  #held = Buffer.alloc(0);
  #cipherBytes = 0;

  constructor(iv: Uint8Array, cipherKey: Uint8Array, macKey: Uint8Array) {
    this.#decipher = createDecipheriv('aes-256-cbc', cipherKey, iv);
    this.#hmac = createHmac('sha256', macKey).update(iv);
  }

  update(chunk: Uint8Array): Buffer {
    const data = Buffer.concat([this.#held, chunk]);
    const cut = data.length - MAC_BYTES;
    if (cut <= 0) {
      this.#held = data;
      return Buffer.alloc(0);
    }
    this.#held = data.subarray(cut);
    const cipher = data.subarray(0, cut);
    this.#cipherBytes += cipher.length;
    this.#hmac.update(cipher);
    return this.#decipher.update(cipher);
  }

  /** The last bytes of the file. A file cut short, changed, or encrypted with other keys is decrypt_failed. */
  final(): Buffer {
    const whole = this.#held.length === MAC_BYTES && this.#cipherBytes > 0 && this.#cipherBytes % BLOCK_BYTES === 0;
    if (!whole || !timingSafeEqual(this.#hmac.digest().subarray(0, MAC_BYTES), this.#held)) throw new MediaUnavailableError('decrypt_failed');
    return this.#decipher.final(); // bad padding: ERR_OSSL_BAD_DECRYPT, which classify() makes decrypt_failed
  }
}

/** The file's keys, expanded from its media key as Baileys does it for this kind of file. */
async function decrypterFor(ref: MediaRef): Promise<Decrypter> {
  const keys = await getMediaKeys(Buffer.from(ref.mediaKey, 'base64'), KEY_TYPES[ref.contentType]);
  if (!keys.macKey) throw new MediaUnavailableError('decrypt_failed');
  return new Decrypter(keys.iv, keys.cipherKey, keys.macKey);
}

/**
 * Downloads and decrypts one file, always from MEDIA_HOST, with a size cap on the decrypted bytes and one time limit for
 * the whole download (connecting, waiting for the answer, reading the body). An unsafe address is refused without a
 * download. Errors carry codes only, never the URL.
 *
 * Passive: this is a plain HTTPS GET. The WhatsApp connection is never used, so nothing is sent to WhatsApp and no phone
 * can be asked to upload an expired file again. An expired file is simply marked unavailable.
 *
 * Baileys' own streaming download is not used (review of Task 5, amendment 5b). It pipes the HTTP body into its decrypt
 * stream with nothing listening for errors on the body, so a connection that drops in the middle of a download is an
 * uncaught exception, which stops the service. Here the body is read as a web stream: such an error, or the time limit
 * aborting the request, is an ordinary rejection of this download only.
 */
export function baileysFetcher(httpFetch: HttpFetch = (url, init) => fetch(url, init)): MediaFetcher {
  return async (ref, limits) => {
    const path = downloadPath(ref);
    if (path === null) throw new MediaUnavailableError('bad_address');
    const request = new AbortController();
    const timer = setTimeout(() => request.abort(new MediaDownloadError('timeout')), limits.timeoutMs);
    try {
      const decrypter = await decrypterFor(ref);
      // A redirect is never followed, so the request cannot leave MEDIA_HOST; it fails as http_3xx.
      const res = await httpFetch(`https://${MEDIA_HOST}${path}`, { signal: request.signal, redirect: 'manual', headers: { Origin: DEFAULT_ORIGIN } });
      if (!res.ok) throw statusError(res.status);
      const chunks: Buffer[] = [];
      let total = 0;
      const keep = (plain: Buffer): void => {
        total += plain.length;
        if (total > limits.maxBytes) throw new MediaUnavailableError('too_large');
        chunks.push(plain);
      };
      // Leaving the loop early (size cap) cancels the body.
      if (res.body) for await (const chunk of res.body) keep(decrypter.update(chunk));
      keep(decrypter.final());
      return Buffer.concat(chunks, total);
    } catch (e) {
      throw classify(e);
    } finally {
      clearTimeout(timer);
      // Releases the connection whatever happened, such as the unread body of an error answer. A no-op after a full read.
      request.abort();
    }
  };
}
