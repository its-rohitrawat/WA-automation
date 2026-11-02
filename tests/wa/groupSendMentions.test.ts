import { describe, expect, it, vi } from 'vitest';
import { MENTIONS_MAX, sendGroupText, type GroupSendSocket } from '../../src/wa/groupSend.ts';
import { mentionTags } from '../../src/wa/groupMembers.ts';
import { SHARMA } from '../helpers/db.ts';

// Tagging (November release, change 2): a sent message carries real WhatsApp mentions. Fake sockets only.

const G = SHARMA.groupId;

function socket() {
  const sendMessage = vi.fn(async () => ({ key: { id: '3EB0000000000000000001' } }));
  return { sock: { sendMessage } as unknown as GroupSendSocket, sendMessage };
}

describe('sendGroupText with mentions', () => {
  it('without mentions the content is the text alone, exactly as before', async () => {
    const { sock, sendMessage } = socket();
    expect(await sendGroupText(() => sock, G, 'Hello team', null)).toEqual({ state: 'sent', waId: '3EB0000000000000000001' });
    expect(sendMessage).toHaveBeenCalledWith(G, { text: 'Hello team' }, undefined);
    await sendGroupText(() => sock, G, 'Hello again', null, undefined, []);
    expect(sendMessage).toHaveBeenLastCalledWith(G, { text: 'Hello again' }, undefined);
  });

  it('puts each tagged member in the content by the id the group uses: a phone-number id or a hidden-number one', async () => {
    const { sock, sendMessage } = socket();
    await sendGroupText(() => sock, G, '@919800000001 and @203333333333333, please check', null, undefined, ['919800000001@s.whatsapp.net', '203333333333333@lid']);
    expect(sendMessage).toHaveBeenCalledWith(G, { text: '@919800000001 and @203333333333333, please check', mentions: ['919800000001@s.whatsapp.net', '203333333333333@lid'] }, undefined);
  });

  it('keeps each person once, drops what is not a person (a group, a device id, junk), and tags at most 50', async () => {
    const { sock, sendMessage } = socket();
    await sendGroupText(() => sock, G, 'hi', null, undefined, ['919800000001@s.whatsapp.net', '919800000001@s.whatsapp.net', G, '919800000002:4@s.whatsapp.net', 'x@lid', '']);
    expect(sendMessage).toHaveBeenLastCalledWith(G, { text: 'hi', mentions: ['919800000001@s.whatsapp.net'] }, undefined);
    const many = Array.from({ length: 60 }, (_, i) => `9198000${String(i).padStart(5, '0')}@s.whatsapp.net`);
    await sendGroupText(() => sock, G, 'all', null, undefined, many);
    expect((sendMessage.mock.lastCall as unknown as [string, { mentions: string[] }])[1].mentions).toHaveLength(MENTIONS_MAX);
    expect(MENTIONS_MAX).toBe(50);
  });

  it('still checks the group and the gateway first: nothing is asked for a bad id or no socket', async () => {
    const { sock, sendMessage } = socket();
    expect(await sendGroupText(() => sock, '919800000001@s.whatsapp.net', 'hi', null, undefined, ['919800000001@s.whatsapp.net'])).toEqual({ state: 'failed', code: 'not_a_group' });
    expect(await sendGroupText(() => null, G, 'hi', null, undefined, ['919800000001@s.whatsapp.net'])).toEqual({ state: 'failed', code: 'whatsapp_not_connected' });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('mentionTags', () => {
  it('finds the digits after each "@" that WhatsApp reads as a tag, once each', () => {
    expect([...mentionTags('@919800000001 and @203333333333333, then @919800000001 again')]).toEqual(['919800000001', '203333333333333']);
    expect([...mentionTags('mail me at a@b.com, @1234 is too short, @Rahul is a name, 9198@x')]).toEqual([]);
    expect([...mentionTags('(@919800000001)')]).toEqual(['919800000001']);
    expect([...mentionTags('@1234567890123456789012')]).toEqual([]); // longer than any id
  });
});
