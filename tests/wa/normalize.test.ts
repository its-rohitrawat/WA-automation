import { proto, WAMessageStubType, type WAMessageUpdate } from 'baileys';
import { describe, expect, it } from 'vitest';
import { AllowList } from '../../src/wa/allowlist.ts';
import { normalizeMessage, normalizeReaction, normalizeUpdate, SELF_JID } from '../../src/wa/normalize.ts';
import { SHARMA } from '../helpers/db.ts';
import { RAHUL_LID, RAHUL_PN, SHARMA_LID, TS, waRaw, waText } from '../helpers/wa.ts';

const G = SHARMA.groupId;
const at = new Date(TS * 1000);

describe('AllowList', () => {
  it('matches exact group ids only', () => {
    const allow = new AllowList([G]);
    expect(allow.has(G)).toBe(true);
    expect(allow.has('120363000000000009@g.us')).toBe(false);
    expect(allow.has(undefined)).toBe(false);
    allow.replace([]);
    expect(allow.has(G)).toBe(false);
  });
});

describe('normalizeMessage', () => {
  it('normalizes a text message and prefers the phone-number sender', () => {
    expect(normalizeMessage(waText('m1', 'hello'))).toEqual({
      kind: 'message', groupId: G, waId: 'm1', senderJid: '919800000001@s.whatsapp.net', senderNumber: '919800000001',
      senderName: 'Mr. Sharma', fromMe: false, ts: at, text: 'hello', quotedWaId: null, mediaType: null,
    });
  });

  it('keeps the LID when WhatsApp shares no phone number', () => {
    expect(normalizeMessage(waText('m1', 'hi', { participantAlt: null }))).toMatchObject({ senderJid: SHARMA_LID, senderNumber: null });
  });

  it("marks the founder's own messages", () => {
    expect(normalizeMessage(waText('m2', 'ok', { fromMe: true, name: 'Founder' }))).toMatchObject({ fromMe: true, senderJid: SELF_JID, senderName: 'Founder' });
  });

  it('captures quoted replies', () => {
    expect(normalizeMessage(waText('m3', 'done', { quoted: 'm1' }))).toMatchObject({ text: 'done', quotedWaId: 'm1' });
  });

  it('captures media type and caption', () => {
    expect(normalizeMessage(waRaw('m4', { imageMessage: { caption: 'see this' } }))).toMatchObject({ mediaType: 'image', text: 'see this' });
    expect(normalizeMessage(waRaw('m5', { audioMessage: { ptt: true } }))).toMatchObject({ mediaType: 'voice', text: null });
    expect(normalizeMessage(waRaw('m6', { documentMessage: { fileName: 'brief.pdf' } }))).toMatchObject({ mediaType: 'document' });
  });

  it('turns delete-for-everyone into a revoke event', () => {
    const e = normalizeMessage(waRaw('p1', { protocolMessage: { type: proto.Message.ProtocolMessage.Type.REVOKE, key: { id: 'm1' } } }));
    expect(e).toEqual({ kind: 'revoke', groupId: G, waId: 'm1', ts: at });
  });

  it('turns an edit into an edit event', () => {
    const e = normalizeMessage(waRaw('p2', {
      protocolMessage: { type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT, key: { id: 'm1' }, editedMessage: { conversation: 'new text' } },
    }));
    expect(e).toEqual({ kind: 'edit', groupId: G, waId: 'm1', text: 'new text', ts: at });
  });

  it('turns a reaction message into a reaction event', () => {
    const e = normalizeMessage(waRaw('r1', { reactionMessage: { key: { id: 'm1' }, text: '✅' } }, { participant: RAHUL_LID, participantAlt: RAHUL_PN }));
    expect(e).toEqual({ kind: 'reaction', groupId: G, targetWaId: 'm1', reactorJid: RAHUL_PN, fromMe: false, emoji: '✅', ts: at });
  });

  it('ignores key-distribution-only messages', () => {
    expect(normalizeMessage(waRaw('k1', { senderKeyDistributionMessage: { groupId: G } }))).toBeNull();
  });
});

describe('normalizeUpdate and normalizeReaction', () => {
  it('reads edits and revokes from messages.update', () => {
    const edit = { key: { remoteJid: G, id: 'm1' }, update: { message: { editedMessage: { message: { conversation: 'fixed' } } }, messageTimestamp: TS } } as WAMessageUpdate;
    expect(normalizeUpdate(edit)).toEqual({ kind: 'edit', groupId: G, waId: 'm1', text: 'fixed', ts: at });
    const revoke = { key: { remoteJid: G, id: 'm1' }, update: { message: null, messageStubType: WAMessageStubType.REVOKE, messageTimestamp: TS } } as WAMessageUpdate;
    expect(normalizeUpdate(revoke)).toEqual({ kind: 'revoke', groupId: G, waId: 'm1', ts: at });
    expect(normalizeUpdate({ key: { remoteJid: G, id: 'm1' }, update: { status: 3 } } as WAMessageUpdate)).toBeNull();
  });

  it('reads messages.reaction events', () => {
    const e = normalizeReaction({
      key: { remoteJid: G, id: 'm1' },
      reaction: { key: { remoteJid: G, participant: RAHUL_LID, participantAlt: RAHUL_PN, fromMe: false } as proto.IMessageKey, text: '👍', senderTimestampMs: TS * 1000 },
    });
    expect(e).toEqual({ kind: 'reaction', groupId: G, targetWaId: 'm1', reactorJid: RAHUL_PN, fromMe: false, emoji: '👍', ts: at });
  });
});

describe('hardening', () => {
  it('ignores plain-text messages.update', () => {
    expect(normalizeUpdate({ key: { remoteJid: G, id: 'm1' }, update: { message: { conversation: 'x' } } } as WAMessageUpdate)).toBeNull();
  });

  it('skips bookkeeping types and labels media stably', () => {
    expect(normalizeMessage(waRaw('b1', { pollUpdateMessage: {} }))).toBeNull();
    expect(normalizeMessage(waRaw('b2', { locationMessage: {} }))).toMatchObject({ mediaType: 'location' });
    expect(normalizeMessage(waRaw('b3', { fooBarMessage: {} } as never))).toMatchObject({ mediaType: 'unsupported' });
  });

  it('strips the device suffix from phone-number senders', () => {
    expect(normalizeMessage(waText('d1', 'hi', { participantAlt: '919800000001:12@s.whatsapp.net' }))).toMatchObject({
      senderJid: '919800000001@s.whatsapp.net', senderNumber: '919800000001',
    });
  });

  it('does not produce a 1970 date for timestamp 0', () => {
    const e = normalizeMessage(waText('t1', 'hi', { ts: 0 }));
    expect(e && e.kind === 'message' ? Math.abs(e.ts.getTime() - Date.now()) : Infinity).toBeLessThan(60_000);
  });

  it('keeps an empty reaction emoji', () => {
    const e = normalizeMessage(waRaw('r2', { reactionMessage: { key: { id: 'm1' }, text: '' } }));
    expect(e).toMatchObject({ kind: 'reaction', emoji: '' });
  });

  it('drops a quoted id that is not a plain id', () => {
    expect(normalizeMessage(waText('q1', 'hi', { quoted: 'x\ny' }))).toMatchObject({ kind: 'message', quotedWaId: null });
  });

  it('drops a reaction whose target id is not a plain id', () => {
    expect(normalizeMessage(waRaw('r3', { reactionMessage: { key: { id: 'm1 evil' }, text: '✅' } }))).toBeNull();
  });

  it('cuts a long reaction emoji to 16 code points', () => {
    const e = normalizeMessage(waRaw('r4', { reactionMessage: { key: { id: 'm1' }, text: '😀'.repeat(40) } }));
    expect(e).toMatchObject({ kind: 'reaction', emoji: '😀'.repeat(16) });
  });
});
