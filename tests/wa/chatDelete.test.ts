import { describe, expect, it, vi } from 'vitest';
import { asChatDeleteSocket, deleteGroupChat, lastMessageFor, ownIdsOf, type ChatDeleteSocket, type StoredLast } from '../../src/wa/chatDelete.ts';
import { SHARMA } from '../helpers/db.ts';

// Delete chat (November release, owner decision 2 Nov): one delete of one approved group's chat on the group's phone, with
// the newest stored message's key as THAT phone's account sees it, and its time. A key it cannot be sure of is still
// asked, but never answered "deleted" (final review, item 2). Fake sockets only: nothing reaches WhatsApp.

const G = SHARMA.groupId;
/** The deleting phone's own account: its number and its hidden-number id, each with a device part as Baileys gives them. */
const OWN = { id: '919800000099:12@s.whatsapp.net', lid: '201234567890123:12@lid' };
const member: StoredLast = { waId: 'WA9', fromMe: false, senderJid: '919800000001@s.whatsapp.net', ts: '2026-11-02T06:30:15.900Z', samePhone: true };
const own = ownIdsOf({ user: OWN, chatModify: async () => {} })!;

function socket(impl: ChatDeleteSocket['chatModify'] = async () => {}, user: ChatDeleteSocket['user'] = OWN) {
  const chatModify = vi.fn(impl);
  return { sock: { user, chatModify } as ChatDeleteSocket, chatModify };
}

describe('ownIdsOf', () => {
  it("is the socket's own number and hidden-number ids without the device part; null when it has neither", () => {
    expect(own).toEqual({ id: '919800000099@s.whatsapp.net', lid: '201234567890123@lid' });
    expect(ownIdsOf({ user: { id: '919800000099@s.whatsapp.net' }, chatModify: async () => {} })).toEqual({ id: '919800000099@s.whatsapp.net', lid: null });
    for (const user of [undefined, null, {}, { id: 'not-an-id' }, { id: '120363999999999999@g.us' }]) {
      expect(ownIdsOf({ user, chatModify: async () => {} } as ChatDeleteSocket), JSON.stringify(user)).toBeNull();
    }
  });
});

describe('lastMessageFor', () => {
  it("another member's message: its key in this group, with the member, and its time in whole seconds; sure", () => {
    expect(lastMessageFor(G, member, own)).toEqual({
      last: { key: { remoteJid: G, id: 'WA9', fromMe: false, participant: '919800000001@s.whatsapp.net' }, messageTimestamp: 1793601015 },
      sure: true,
    });
    expect(Date.parse('2026-11-02T06:30:15.000Z') / 1000).toBe(1793601015);
  });

  it("this phone's own message, stored since the group's last change of phone: no participant; sure", () => {
    const m: StoredLast = { ...member, waId: 'WA10', fromMe: true, senderJid: 'self' };
    expect(lastMessageFor(G, m, own)).toEqual({ last: { key: { remoteJid: G, id: 'WA10', fromMe: true }, messageTimestamp: 1793601015 }, sure: true });
  });

  it('an own message stored before the group changed phone was another phone’s: not sure', () => {
    expect(lastMessageFor(G, { ...member, fromMe: true, senderJid: 'self', samePhone: false }, own).sure).toBe(false);
  });

  it("a member's message that this phone sent itself (read by another phone): its own key, and not sure", () => {
    for (const senderJid of ['919800000099@s.whatsapp.net', '919800000099:3@s.whatsapp.net', '201234567890123@lid', '201234567890123:4@lid']) {
      expect(lastMessageFor(G, { ...member, senderJid }, own), senderJid).toEqual({ last: { key: { remoteJid: G, id: 'WA9', fromMe: true }, messageTimestamp: 1793601015 }, sure: false });
    }
  });

  it("without the phone's own account the key can't be sure", () => {
    expect(lastMessageFor(G, member, null).sure).toBe(false);
    expect(lastMessageFor(G, { ...member, fromMe: true, senderJid: 'self' }, null).sure).toBe(false);
  });
});

describe('deleteGroupChat', () => {
  it('deletes once, up to the last message, through the socket the gateway gave for this group, with that socket’s key', async () => {
    const { sock, chatModify } = socket();
    const source = vi.fn(() => sock);
    expect(await deleteGroupChat(source, G, member)).toEqual({ state: 'deleted' });
    expect(source).toHaveBeenCalledWith(G);
    expect(chatModify).toHaveBeenCalledTimes(1);
    expect(chatModify).toHaveBeenCalledWith({ delete: true, lastMessages: [lastMessageFor(G, member, own).last] }, G);
  });

  it("a key it can't be sure of is still asked, and answered unknown (check the phone), never deleted", async () => {
    const mine = socket();
    expect(await deleteGroupChat(() => mine.sock, G, { ...member, senderJid: '919800000099@s.whatsapp.net' })).toEqual({ state: 'unknown', code: 'check_phone' });
    expect(mine.chatModify.mock.calls[0]![0].lastMessages[0]!.key).toEqual({ remoteJid: G, id: 'WA9', fromMe: true });
    const nobody = socket(async () => {}, null);
    expect(await deleteGroupChat(() => nobody.sock, G, member)).toEqual({ state: 'unknown', code: 'check_phone' });
    expect(nobody.chatModify).toHaveBeenCalledTimes(1);
  });

  it('asks nothing for an id that is not a group', async () => {
    const { sock, chatModify } = socket();
    const source = vi.fn(() => sock);
    for (const jid of ['919800000001@s.whatsapp.net', '123@lid', 'x@g.us', '']) {
      expect(await deleteGroupChat(source, jid, member)).toEqual({ state: 'failed', code: 'not_a_group' });
    }
    expect(source).not.toHaveBeenCalled();
    expect(chatModify).not.toHaveBeenCalled();
  });

  it('asks nothing when the gateway gives no socket (not open, or not an approved group)', async () => {
    expect(await deleteGroupChat(() => null, G, member)).toEqual({ state: 'failed', code: 'whatsapp_not_connected' });
  });

  it('an error, or no answer in time, is unknown: it may have been done', async () => {
    const thrown = socket(async () => {
      throw new Error(`chat ${G} could not be changed`);
    });
    expect(await deleteGroupChat(() => thrown.sock, G, member)).toEqual({ state: 'unknown', code: 'delete_error' });
    expect(thrown.chatModify).toHaveBeenCalledTimes(1);
    const hung = socket(() => new Promise<void>(() => {}));
    expect(await deleteGroupChat(() => hung.sock, G, member, 20)).toEqual({ state: 'unknown', code: 'timeout' });
    expect(hung.chatModify).toHaveBeenCalledTimes(1);
  });
});

describe('asChatDeleteSocket', () => {
  it('is the socket itself when it can delete a chat; null for one that cannot (a test fake)', () => {
    const { sock } = socket();
    expect(asChatDeleteSocket(sock)).toBe(sock);
    expect(asChatDeleteSocket({})).toBeNull();
  });
});
