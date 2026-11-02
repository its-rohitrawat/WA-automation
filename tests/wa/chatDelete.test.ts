import { describe, expect, it, vi } from 'vitest';
import { asChatDeleteSocket, deleteGroupChat, lastMessageOf, type ChatDeleteSocket } from '../../src/wa/chatDelete.ts';
import { SHARMA } from '../helpers/db.ts';

// Delete chat (November release, owner decision 2 Nov): one delete of one approved group's chat on the founder's phone,
// with the newest stored message's key and time. Fake sockets only: nothing reaches WhatsApp.

const G = SHARMA.groupId;
const last = lastMessageOf(G, { waId: 'WA9', fromMe: false, senderJid: '919800000001@s.whatsapp.net', ts: '2026-11-02T06:30:15.900Z' });

function socket(impl: ChatDeleteSocket['chatModify'] = async () => {}) {
  const chatModify = vi.fn(impl);
  return { sock: { chatModify } as ChatDeleteSocket, chatModify };
}

describe('lastMessageOf', () => {
  it("gives the message's key in this group and its time in whole seconds", () => {
    expect(last).toEqual({ key: { remoteJid: G, id: 'WA9', fromMe: false, participant: '919800000001@s.whatsapp.net' }, messageTimestamp: 1793601015 });
    expect(Date.parse('2026-11-02T06:30:15.000Z') / 1000).toBe(1793601015);
  });

  it("names no participant for the founder's own message", () => {
    expect(lastMessageOf(G, { waId: 'WA10', fromMe: true, senderJid: '919800000099@s.whatsapp.net', ts: '2026-11-02T06:31:00.000Z' }).key)
      .toEqual({ remoteJid: G, id: 'WA10', fromMe: true });
  });
});

describe('deleteGroupChat', () => {
  it('deletes once, up to the last message, through the socket the gateway gave for this group', async () => {
    const { sock, chatModify } = socket();
    const source = vi.fn(() => sock);
    expect(await deleteGroupChat(source, G, last)).toEqual({ state: 'deleted' });
    expect(source).toHaveBeenCalledWith(G);
    expect(chatModify).toHaveBeenCalledTimes(1);
    expect(chatModify).toHaveBeenCalledWith({ delete: true, lastMessages: [last] }, G);
  });

  it('asks nothing for an id that is not a group, or a last message from another chat', async () => {
    const { sock, chatModify } = socket();
    const source = vi.fn(() => sock);
    for (const jid of ['919800000001@s.whatsapp.net', '123@lid', 'x@g.us', '']) {
      expect(await deleteGroupChat(source, jid, { ...last, key: { ...last.key, remoteJid: jid } })).toEqual({ state: 'failed', code: 'not_a_group' });
    }
    expect(await deleteGroupChat(source, G, { ...last, key: { ...last.key, remoteJid: '120363999999999999@g.us' } })).toEqual({ state: 'failed', code: 'not_a_group' });
    expect(source).not.toHaveBeenCalled();
    expect(chatModify).not.toHaveBeenCalled();
  });

  it('asks nothing when the gateway gives no socket (not open, or not an approved group)', async () => {
    expect(await deleteGroupChat(() => null, G, last)).toEqual({ state: 'failed', code: 'whatsapp_not_connected' });
  });

  it('an error, or no answer in time, is unknown: it may have been done; never asked again', async () => {
    const thrown = socket(async () => {
      throw new Error(`chat ${G} could not be changed`);
    });
    expect(await deleteGroupChat(() => thrown.sock, G, last)).toEqual({ state: 'unknown', code: 'delete_error' });
    expect(thrown.chatModify).toHaveBeenCalledTimes(1);
    const hung = socket(() => new Promise<void>(() => {}));
    expect(await deleteGroupChat(() => hung.sock, G, last, 20)).toEqual({ state: 'unknown', code: 'timeout' });
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
