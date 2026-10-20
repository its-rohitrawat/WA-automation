import { getContentType, isPnUser, normalizeMessageContent, proto, WAMessageStubType } from 'baileys';
import type { WAMessage, WAMessageKey, WAMessageUpdate } from 'baileys';

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
};

function phoneFromJid(jid: string): string | null {
  const user = jid.split('@')[0]?.split(':')[0];
  return user && /^\d+$/.test(user) ? user : null;
}

export function senderOf(key: WAMessageKey): { jid: string; number: string | null } {
  if (key.fromMe) return { jid: SELF_JID, number: null };
  const candidates = [key.participantAlt, key.participant].filter((j): j is string => typeof j === 'string' && j.length > 0);
  const pn = candidates.find((j) => isPnUser(j) === true);
  return { jid: pn ?? candidates[0] ?? key.remoteJid ?? 'unknown', number: pn ? phoneFromJid(pn) : null };
}

function toDate(t: unknown): Date {
  if (typeof t === 'number') return new Date(t * 1000);
  if (t && typeof (t as { toNumber?: unknown }).toNumber === 'function') return new Date((t as { toNumber(): number }).toNumber() * 1000);
  return new Date();
}

function textOf(c: proto.IMessage | null | undefined): string | null {
  if (!c) return null;
  return c.conversation ?? c.extendedTextMessage?.text ?? c.imageMessage?.caption ?? c.videoMessage?.caption ?? c.documentMessage?.caption ?? null;
}

function quotedOf(c: proto.IMessage, type: string): string | null {
  const inner = (c as Record<string, unknown>)[type];
  if (!inner || typeof inner !== 'object') return null;
  return (inner as { contextInfo?: proto.IContextInfo | null }).contextInfo?.stanzaId ?? null;
}

function mediaTypeOf(c: proto.IMessage, type: string): string | null {
  if (type === 'conversation' || type === 'extendedTextMessage') return null;
  if (type === 'audioMessage') return c.audioMessage?.ptt ? 'voice' : 'audio';
  return MEDIA[type] ?? type;
}

export function normalizeMessage(msg: WAMessage): NormalizedEvent | null {
  const groupId = msg.key.remoteJid;
  const waId = msg.key.id;
  if (!groupId || !waId) return null;
  const content = normalizeMessageContent(msg.message);
  if (!content) return null;
  const ts = toDate(msg.messageTimestamp);

  const pm = content.protocolMessage;
  if (pm) {
    const target = pm.key?.id;
    if (!target) return null;
    if (pm.type === proto.Message.ProtocolMessage.Type.REVOKE) return { kind: 'revoke', groupId, waId: target, ts };
    if (pm.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT) {
      const text = textOf(normalizeMessageContent(pm.editedMessage));
      return text === null ? null : { kind: 'edit', groupId, waId: target, text, ts };
    }
    return null;
  }

  if (content.reactionMessage) {
    const target = content.reactionMessage.key?.id;
    if (!target) return null;
    return { kind: 'reaction', groupId, targetWaId: target, reactorJid: senderOf(msg.key).jid, fromMe: Boolean(msg.key.fromMe), emoji: content.reactionMessage.text ?? '', ts };
  }

  const type = getContentType(content);
  if (!type) return null;
  const sender = senderOf(msg.key);
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
    mediaType: mediaTypeOf(content, type),
  };
}

export function normalizeUpdate(u: WAMessageUpdate): NormalizedEvent | null {
  const groupId = u.key.remoteJid;
  const waId = u.key.id;
  if (!groupId || !waId) return null;
  const ts = toDate(u.update.messageTimestamp);
  if (u.update.messageStubType === WAMessageStubType.REVOKE) return { kind: 'revoke', groupId, waId, ts };
  if (u.update.message) {
    const text = textOf(normalizeMessageContent(u.update.message));
    if (text !== null) return { kind: 'edit', groupId, waId, text, ts };
  }
  return null;
}

export function normalizeReaction(r: { key: WAMessageKey; reaction: proto.IReaction }): NormalizedEvent | null {
  const groupId = r.key.remoteJid;
  const target = r.key.id;
  if (!groupId || !target) return null;
  const reactorKey = r.reaction.key ?? undefined;
  const ms = r.reaction.senderTimestampMs;
  return {
    kind: 'reaction',
    groupId,
    targetWaId: target,
    reactorJid: reactorKey ? senderOf(reactorKey).jid : 'unknown',
    fromMe: Boolean(reactorKey?.fromMe),
    emoji: r.reaction.text ?? '',
    ts: ms ? new Date(Number(ms)) : new Date(),
  };
}
