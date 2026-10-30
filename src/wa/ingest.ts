import { isSafeMediaAddress, isSafeMediaUrl, mediaRefAad, type MediaRefSealer } from '../media/ref.ts';
import { MEDIA_LIMITS, type MediaInfo, type MediaRef } from '../media/types.ts';
import { getClientByGroupId } from '../store/clients.ts';
import type { Db } from '../store/db.ts';
import { insertMedia, messageRowId, type MediaStatus } from '../store/media.ts';
import { applyEdit, applyRevoke, insertMessage, upsertReaction } from '../store/messages.ts';
import { upsertPerson } from '../store/people.ts';
import { systemClock, type Clock } from '../util/clock.ts';
import type { NormalizedEvent } from './normalize.ts';

export interface IngestMediaOptions {
  /** Seals the download details before they are stored. */
  sealer: MediaRefSealer;
  /** A file is waiting to be downloaded. Called after the transaction commits. */
  onQueued?: (mediaId: number) => void;
}

export interface MediaPlan {
  status: MediaStatus;
  errorCode: string | null;
  refEnc: Buffer | null;
}

/** What happens to a shared file on arrival. Only images, documents and audio are downloaded. */
export function planMedia(info: MediaInfo, seal: ((ref: MediaRef) => Buffer) | null): MediaPlan {
  // View-once media is meant to be seen once: never kept.
  if (info.viewOnce) return { status: 'metadata', errorCode: 'view_once', refEnc: null };
  if (info.kind === 'video' || info.kind === 'sticker') return { status: 'metadata', errorCode: null, refEnc: null };
  if (info.fileSize !== null && info.fileSize > MEDIA_LIMITS.maxDownloadBytes) return { status: 'unavailable', errorCode: 'too_large', refEnc: null };
  if (!info.ref) return { status: 'unavailable', errorCode: 'no_ref', refEnc: null };
  // The address comes from the sender's phone: one that does not point at WhatsApp's media servers is never sealed.
  if (!isSafeMediaAddress(info.ref)) return { status: 'unavailable', errorCode: 'bad_address', refEnc: null };
  if (!seal) return { status: 'unavailable', errorCode: 'not_downloaded', refEnc: null };
  // With a direct path the url is never used, so a url that does not itself point at WhatsApp's media servers is not stored.
  const ref = info.ref.directPath && !isSafeMediaUrl(info.ref.url) ? { ...info.ref, url: null } : info.ref;
  return { status: 'pending', errorCode: null, refEnc: seal(ref) };
}

export class Ingestor {
  readonly #db: Db;
  readonly #onNew: (clientId: number) => void;
  readonly #clock: Clock;
  readonly #media: IngestMediaOptions | undefined;

  constructor(opts: { db: Db; onNewMessages: (clientId: number) => void; clock?: Clock; media?: IngestMediaOptions }) {
    this.#db = opts.db;
    this.#onNew = opts.onNewMessages;
    this.#clock = opts.clock ?? systemClock;
    this.#media = opts.media;
  }

  /** The gateways hand events over one after another, waiting for each (src/wa/gateway.ts), so they are stored in order. */
  async handle(e: NormalizedEvent): Promise<void> {
    const db = this.#db;
    // Second line of defence after the gateway's allow-list.
    const client = await getClientByGroupId(db, e.groupId);
    if (!client || !client.active) return;

    switch (e.kind) {
      case 'message': {
        // The message and its file row are written together, so a file is never left without its message.
        const result = await db.tx(async (q) => {
          const isNew = await insertMessage(q, {
            waId: e.waId,
            clientId: client.id,
            senderJid: e.senderJid,
            senderNumber: e.senderNumber,
            senderName: e.senderName,
            fromMe: e.fromMe,
            ts: e.ts.toISOString(),
            text: e.text,
            quotedWaId: e.quotedWaId,
            mediaType: e.mediaType,
          });
          let queued: number | null = null;
          const messageId = isNew && e.media ? await messageRowId(q, client.id, e.waId) : undefined;
          if (e.media && messageId !== undefined) {
            const sealer = this.#media?.sealer;
            const plan = planMedia(e.media, sealer ? (ref) => sealer.seal(ref, mediaRefAad(client.id, e.waId)) : null);
            const id = await insertMedia(q, {
              messageId,
              clientId: client.id,
              kind: e.media.kind,
              status: plan.status,
              mimeType: e.media.mimeType,
              fileName: e.media.fileName,
              fileSize: e.media.fileSize,
              seconds: e.media.seconds,
              forwarded: e.media.forwarded,
              refEnc: plan.refEnc,
              errorCode: plan.errorCode,
              createdAt: this.#clock.now().toISOString(),
            });
            if (plan.status === 'pending') queued = id;
          }
          return { isNew, queued };
        });
        await upsertPerson(db, { clientId: client.id, jid: e.senderJid, number: e.senderNumber, name: e.senderName, fromMe: e.fromMe });
        if (result.isNew) this.#onNew(client.id);
        if (result.queued !== null) this.#media?.onQueued?.(result.queued);
        return;
      }
      case 'edit':
        if (await applyEdit(db, client.id, e.waId, e.text, e.ts.toISOString())) this.#onNew(client.id);
        return;
      case 'revoke':
        await applyRevoke(db, client.id, e.waId);
        return;
      case 'reaction':
        await upsertReaction(db, { clientId: client.id, targetWaId: e.targetWaId, reactorJid: e.reactorJid, emoji: e.emoji, ts: e.ts.toISOString() });
        await upsertPerson(db, { clientId: client.id, jid: e.reactorJid, number: null, name: null, fromMe: e.fromMe });
        if (e.emoji) this.#onNew(client.id);
        return;
    }
  }
}
