import { getContentType, isPnUser, jidNormalizedUser, normalizeMessageContent, proto, WAMessageStubType } from 'baileys';
import type { WAMessage, WAMessageKey, WAMessageUpdate } from 'baileys';
import type { MediaInfo, MediaKind, MediaRef } from '../media/types.ts';

/** Fixed sender id for the founder's own messages. */
export const SELF_JID = 'self@founder';

export type NormalizedEvent =
  | {
      kind: 'message';
      groupId: string;
      waId: string;
      senderJid: string;
      senderNumber: string | null;
      senderName: string | null;
      fromMe: boolean;
      ts: Date;
      text: string | null;
      quotedWaId: string | null;
      mediaType: string | null;
      /** Present only for files (image, video, document, sticker, voice, audio). */
      media?: MediaInfo;
    }
  | { kind: 'edit'; groupId: string; waId: string; text: string; ts: Date }
  | { kind: 'revoke'; groupId: string; waId: string; ts: Date }
  | { kind: 'reaction'; groupId: string; targetWaId: string; reactorJid: string; fromMe: boolean; emoji: string; ts: Date };

const MEDIA: Record<string, string> = {
  imageMessage: 'image',
  videoMessage: 'video',
  ptvMessage: 'video',
  documentMessage: 'document',
  stickerMessage: 'sticker',
  locationMessage: 'location',
  liveLocationMessage: 'location',
  contactMessage: 'contact',
  contactsArrayMessage: 'contact',
  pollCreationMessage: 'poll',
  pollCreationMessageV2: 'poll',
  pollCreationMessageV3: 'poll',
  eventMessage: 'event',
};

/** Bookkeeping content types that carry no conversation. */
const SKIP = new Set(['pollUpdateMessage', 'pinInChatMessage', 'keepInChatMessage', 'encReactionMessage', 'encEventResponseMessage', 'secretEncryptedMessage', 'albumMessage', 'placeholderMessage']);

const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const validId = (id: string | null | undefined): id is string => typeof id === 'string' && ID_RE.test(id);
/** Real reactions are emoji. Text, brackets or tags mean someone is faking one. */
const BAD_EMOJI = /[A-Za-z[\]{}<>]/;
const cleanEmoji = (e: string | null | undefined): string => [...(e ?? '')].slice(0, 16).join('');

function phoneFromJid(jid: string): string | null {
  const user = jid.split('@')[0]?.split(':')[0];
  return user && /^\d+$/.test(user) ? user : null;
}

export function senderOf(key: WAMessageKey): { jid: string; number: string | null } {
  if (key.fromMe) return { jid: SELF_JID, number: null };
  const candidates = [key.participantAlt, key.participant].filter((j): j is string => typeof j === 'string' && j.length > 0);
  const pn = candidates.find((j) => isPnUser(j) === true);
  return { jid: pn ? (jidNormalizedUser(pn) || pn) : (candidates[0] ?? key.remoteJid ?? 'unknown'), number: pn ? phoneFromJid(pn) : null };
}

function toDate(t: unknown): Date {
  let n: number | null = null;
  if (typeof t === 'number') n = t;
  else if (t && typeof (t as { toNumber?: unknown }).toNumber === 'function') n = (t as { toNumber(): number }).toNumber();
  return n !== null && Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date();
}

function textOf(c: proto.IMessage | null | undefined): string | null {
  if (!c) return null;
  return c.conversation ?? c.extendedTextMessage?.text ?? c.imageMessage?.caption ?? c.videoMessage?.caption ?? c.documentMessage?.caption ?? null;
}

function quotedOf(c: proto.IMessage, type: string): string | null {
  const inner = (c as Record<string, unknown>)[type];
  if (!inner || typeof inner !== 'object') return null;
  const id = (inner as { contextInfo?: proto.IContextInfo | null }).contextInfo?.stanzaId;
  return validId(id) ? id : null;
}

function mediaTypeOf(c: proto.IMessage, type: string): string | null {
  if (type === 'conversation' || type === 'extendedTextMessage') return null;
  if (type === 'audioMessage') return c.audioMessage?.ptt ? 'voice' : 'audio';
  return MEDIA[type] ?? 'unsupported';
}

/** Kinds that are files. Locations, contacts, polls and events are not. */
const FILE_KINDS = new Set<string>(['image', 'video', 'document', 'sticker', 'voice', 'audio']);
/** Content types whose file is downloaded: images, documents, and audio (kept for Phase 2b). Never video or stickers. */
const DOWNLOADABLE = new Set<string>(['imageMessage', 'documentMessage', 'audioMessage']);

/**
 * The wrappers Baileys' normalizeMessageContent opens (7.0.0-rc14), in its order. It opens at most UNWRAP_LIMIT of them.
 * tests/wa/normalizeMedia.test.ts checks this list and its order against the installed Baileys.
 */
const WRAPPERS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'documentWithCaptionMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'editedMessage',
  'associatedChildMessage',
  'groupStatusMessage',
  'groupStatusMessageV2',
] as const satisfies readonly (keyof proto.IMessage)[];
const VIEW_ONCE_WRAPPERS = ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension'] as const satisfies readonly (typeof WRAPPERS)[number][];
const UNWRAP_LIMIT = 5;

interface MediaFields {
  url?: string | null;
  directPath?: string | null;
  mediaKey?: Uint8Array | null;
  mimetype?: string | null;
  fileName?: string | null;
  fileLength?: unknown;
  seconds?: number | null;
  viewOnce?: boolean | null;
  contextInfo?: proto.IContextInfo | null;
}

/** A non-negative whole number from a number or a protobuf Long. */
function count(v: unknown): number | null {
  let n: number | null = null;
  if (typeof v === 'number') n = v;
  else if (v && typeof (v as { toNumber?: unknown }).toNumber === 'function') n = (v as { toNumber(): number }).toNumber();
  return n !== null && Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

const short = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length > 0 ? [...v].slice(0, max).join('') : null);

/**
 * Whether the file came inside a view-once wrapper. Walks the same path as Baileys' normalizeMessageContent, down to the
 * content it returns. A view-once wrapper beside the one Baileys opens counts too.
 */
function wrappedViewOnce(raw: proto.IMessage | null | undefined): boolean {
  let m = raw;
  for (let depth = 0; depth <= UNWRAP_LIMIT && m; depth++) {
    const level: proto.IMessage = m;
    if (VIEW_ONCE_WRAPPERS.some((w) => level[w])) return true;
    const next = WRAPPERS.find((w) => level[w]);
    m = next ? level[next]?.message : null;
  }
  return false;
}

/** Owner decision D2: forwarded files are never sent to Claude for a paid description. */
function isForwarded(ctx: proto.IContextInfo | null | undefined): boolean {
  return ctx?.isForwarded === true || (ctx?.forwardingScore ?? 0) > 0;
}

function mediaOf(raw: proto.IMessage | null | undefined, c: proto.IMessage, type: string, mediaType: string | null): MediaInfo | undefined {
  if (!mediaType || !FILE_KINDS.has(mediaType)) return undefined;
  const f = ((c as Record<string, unknown>)[type] ?? {}) as MediaFields;
  const viewOnce = f.viewOnce === true || wrappedViewOnce(raw);
  const key = f.mediaKey;
  const ref: MediaRef | null =
    DOWNLOADABLE.has(type) && !viewOnce && key instanceof Uint8Array && key.length > 0 && (f.url || f.directPath)
      ? { contentType: type as MediaRef['contentType'], url: f.url ?? null, directPath: f.directPath ?? null, mediaKey: Buffer.from(key).toString('base64') }
      : null;
  return {
    kind: mediaType as MediaKind,
    mimeType: short(f.mimetype, 100),
    fileName: short(f.fileName, 255),
    fileSize: count(f.fileLength),
    seconds: count(f.seconds),
    viewOnce,
    forwarded: isForwarded(f.contextInfo),
    ref,
  };
}

export function normalizeMessage(msg: WAMessage): NormalizedEvent | null {
  const groupId = msg.key.remoteJid;
  const waId = msg.key.id;
  if (!groupId || !validId(waId)) return null;
  const content = normalizeMessageContent(msg.message);
  if (!content) return null;
  const ts = toDate(msg.messageTimestamp);

  const pm = content.protocolMessage;
  if (pm) {
    const target = pm.key?.id;
    if (!validId(target)) return null;
    if (pm.type === proto.Message.ProtocolMessage.Type.REVOKE) return { kind: 'revoke', groupId, waId: target, ts };
    if (pm.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT) {
      const text = textOf(normalizeMessageContent(pm.editedMessage));
      return text === null ? null : { kind: 'edit', groupId, waId: target, text, ts };
    }
    return null;
  }

  if (content.reactionMessage) {
    const target = content.reactionMessage.key?.id;
    if (!validId(target)) return null;
    const emoji = cleanEmoji(content.reactionMessage.text);
    if (BAD_EMOJI.test(emoji)) return null;
    return { kind: 'reaction', groupId, targetWaId: target, reactorJid: senderOf(msg.key).jid, fromMe: Boolean(msg.key.fromMe), emoji, ts };
  }

  const type = getContentType(content);
  if (!type || SKIP.has(type)) return null;
  const sender = senderOf(msg.key);
  const mediaType = mediaTypeOf(content, type);
  const media = mediaOf(msg.message, content, type, mediaType);
  return {
    kind: 'message',
    groupId,
    waId,
    senderJid: sender.jid,
    senderNumber: sender.number,
    senderName: msg.pushName ?? null,
    fromMe: Boolean(msg.key.fromMe),
    ts,
    text: textOf(content),
    quotedWaId: quotedOf(content, type),
    mediaType,
    ...(media ? { media } : {}),
  };
}

export function normalizeUpdate(u: WAMessageUpdate): NormalizedEvent | null {
  const groupId = u.key.remoteJid;
  const waId = u.key.id;
  if (!groupId || !validId(waId)) return null;
  const ts = toDate(u.update.messageTimestamp);
  if (u.update.messageStubType === WAMessageStubType.REVOKE) return { kind: 'revoke', groupId, waId, ts };
  if (u.update.message?.editedMessage) {
    const text = textOf(normalizeMessageContent(u.update.message));
    if (text !== null) return { kind: 'edit', groupId, waId, text, ts };
  }
  return null;
}

export function normalizeReaction(r: { key: WAMessageKey; reaction: proto.IReaction }): NormalizedEvent | null {
  const groupId = r.key.remoteJid;
  const target = r.key.id;
  if (!groupId || !validId(target)) return null;
  const emoji = cleanEmoji(r.reaction.text);
  if (BAD_EMOJI.test(emoji)) return null;
  const reactorKey = r.reaction.key ?? undefined;
  const msRaw = r.reaction.senderTimestampMs;
  const ms = msRaw === null || msRaw === undefined ? NaN : Number(msRaw);
  return {
    kind: 'reaction',
    groupId,
    targetWaId: target,
    reactorJid: reactorKey ? senderOf(reactorKey).jid : 'unknown',
    fromMe: Boolean(reactorKey?.fromMe),
    emoji,
    ts: Number.isFinite(ms) && ms > 0 ? new Date(ms) : new Date(),
  };
}
