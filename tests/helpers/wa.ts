import type { proto, WAMessage } from 'baileys';
import { SHARMA } from './db.ts';

export const TS = 1_791_619_200; // 2026-10-10 08:00 UTC = 13:30 IST
export const SHARMA_LID = '201234567890123@lid';
export const SHARMA_PN = '919800000001@s.whatsapp.net';
export const RAHUL_LID = '209876543210987@lid';
export const RAHUL_PN = '919800000002@s.whatsapp.net';

export interface MsgOpts {
  group?: string;
  participant?: string;
  /** null = WhatsApp did not share a phone number */
  participantAlt?: string | null;
  name?: string;
  ts?: number;
  fromMe?: boolean;
}

function keyFor(id: string, o: MsgOpts): WAMessage['key'] {
  if (o.fromMe) return { remoteJid: o.group ?? SHARMA.groupId, id, fromMe: true };
  return {
    remoteJid: o.group ?? SHARMA.groupId,
    id,
    fromMe: false,
    participant: o.participant ?? SHARMA_LID,
    ...(o.participantAlt === null ? {} : { participantAlt: o.participantAlt ?? SHARMA_PN }),
  };
}

export function waRaw(id: string, message: proto.IMessage, o: MsgOpts = {}): WAMessage {
  return { key: keyFor(id, o), message, messageTimestamp: o.ts ?? TS, pushName: o.name ?? 'Mr. Sharma' } as WAMessage;
}

export function waText(id: string, text: string, o: MsgOpts & { quoted?: string } = {}): WAMessage {
  const message: proto.IMessage = o.quoted ? { extendedTextMessage: { text, contextInfo: { stanzaId: o.quoted } } } : { conversation: text };
  return waRaw(id, message, o);
}
