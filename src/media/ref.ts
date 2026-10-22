import { hkdfSync } from 'node:crypto';
import { decrypt, encrypt } from '../crypto/envelope.ts';
import type { MediaRef } from './types.ts';

const CONTENT_TYPES = new Set(['imageMessage', 'documentMessage', 'audioMessage']);

function isRef(x: unknown): x is MediaRef {
  const r = x as Record<string, unknown> | null;
  return (
    typeof r === 'object' && r !== null &&
    typeof r.contentType === 'string' && CONTENT_TYPES.has(r.contentType) &&
    (r.url === null || typeof r.url === 'string') &&
    (r.directPath === null || typeof r.directPath === 'string') &&
    typeof r.mediaKey === 'string'
  );
}

/** Starts with '/', and has no whitespace, backslash or '@', so it cannot change the host it is appended to. */
const DIRECT_PATH = /^\/[^\s\\@]*$/;

const isWhatsAppMediaHost = (hostname: string): boolean => hostname === 'mmg.whatsapp.net' || hostname.endsWith('.whatsapp.net');

/**
 * Whether a file's download address points at WhatsApp's media servers. The address comes from the sender's phone, so
 * ingest never seals one that fails this check, and the downloader checks it again.
 *
 * Baileys downloads from `https://<host><directPath>` whenever there is a direct path, so a direct path must be safe on
 * its own, whatever the url says. The url is then never used: the downloader must fetch from mmg.whatsapp.net plus the
 * direct path and never let the url choose the host. Only without a direct path is the url used, and then it must be a
 * plain https address on WhatsApp's media servers. An empty string counts as absent, as it does for Baileys.
 */
export function isSafeMediaAddress(ref: Pick<MediaRef, 'url' | 'directPath'>): boolean {
  if (ref.directPath) return DIRECT_PATH.test(ref.directPath);
  if (!ref.url) return false;
  const u = URL.parse(ref.url);
  return u !== null && u.protocol === 'https:' && isWhatsAppMediaHost(u.hostname) && u.port === '' && u.username === '' && u.password === '';
}

/** Binds a sealed value to its client and message, so it cannot be moved to another row. */
export const mediaRefAad = (clientId: number, waId: string): string => `media-ref:${clientId}:${waId}`;

/**
 * Seals media download details (URL and media key) with AES-256-GCM under a key derived from the DPAPI-protected
 * master key. They exist only between ingest and the end of the download.
 */
export class MediaRefSealer {
  readonly #key: Buffer;

  constructor(masterKey: Buffer) {
    this.#key = Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), 'whatsapp-media-ref', 32));
  }

  seal(ref: MediaRef, aad: string): Buffer {
    return encrypt(this.#key, Buffer.from(JSON.stringify(ref), 'utf8'), Buffer.from(aad, 'utf8'));
  }

  /** Throws if the value was sealed for another row, with another key, or was changed. */
  open(blob: Buffer, aad: string): MediaRef {
    const parsed = JSON.parse(decrypt(this.#key, blob, Buffer.from(aad, 'utf8')).toString('utf8')) as unknown;
    if (!isRef(parsed)) throw new Error('Sealed media details have the wrong shape');
    return parsed;
  }
}
