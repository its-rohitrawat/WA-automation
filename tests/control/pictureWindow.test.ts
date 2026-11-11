import { describe, expect, it } from 'vitest';
import { chatHiddenKey, chatPage, pictureWindow, withTagNames, type ChatHidden } from '../../src/control/chatQueries.ts';
import { getClientByCode } from '../../src/store/clients.ts';
import { setKv } from '../../src/store/kv.ts';
import { applyRevoke, insertMessage, type NewMessage } from '../../src/store/messages.ts';
import { upsertPerson } from '../../src/store/people.ts';
import { seeded, SHARMA } from '../helpers/db.ts';

const RAHUL = '919800000002@s.whatsapp.net';
const at = (min: number) => new Date(Date.UTC(2026, 10, 3, 5, min)).toISOString();

async function chat() {
  const { db, ids } = await seeded();
  const c = (await getClientByCode(db, SHARMA.code))!;
  await upsertPerson(db, { clientId: ids.sharma, jid: RAHUL, number: '919800000002', name: 'Rahul', fromMe: false });
  const put = (o: Partial<NewMessage> & { waId: string; ts: string }) => insertMessage(db, {
    clientId: ids.sharma, senderJid: RAHUL, senderNumber: '919800000002', senderName: 'Rahul', fromMe: false, text: null, quotedWaId: null, mediaType: null, ...o,
  });
  for (let i = 1; i <= 9; i++) await put({ waId: `w${i}`, ts: at(i), text: `message ${i}` });
  await insertMessage(db, { waId: 'other', clientId: ids.mehta, senderJid: RAHUL, senderNumber: null, senderName: null, fromMe: false, ts: at(5), text: 'Mehta only', quotedWaId: null, mediaType: null });
  const id = async (waId: string, client = ids.sharma) => (await db.get<{ id: number }>('SELECT id FROM messages WHERE client_id = ? AND wa_id = ?', [client, waId]))!.id;
  return { db, c, ids, put, id };
}

describe('pictureWindow (a chat picture as each task’s source, 11 Nov 2026)', () => {
  it('shows the source, the 4 before it and the 2 after it, oldest first, with only the source marked', async () => {
    const { db, c, id } = await chat();
    const w = (await pictureWindow(db, c, await id('w5')))!;
    expect(w.client).toEqual({ code: 'SHA', name: 'Sharma Interiors' });
    expect(w.messages.map((m) => m.text)).toEqual(['message 1', 'message 2', 'message 3', 'message 4', 'message 5', 'message 6', 'message 7']);
    expect(w.messages.map((m) => m.source)).toEqual([false, false, false, false, true, false, false]);
    expect(w.messages.every((m) => m.sender === 'Rahul')).toBe(true);
  });

  it('at the start of the chat shows what there is', async () => {
    const { db, c, id } = await chat();
    expect((await pictureWindow(db, c, await id('w1')))!.messages.map((m) => m.text)).toEqual(['message 1', 'message 2', 'message 3']);
  });

  it('is null for another client’s message, which it never shows', async () => {
    const { db, c, ids, id } = await chat();
    expect(await pictureWindow(db, c, await id('other', ids.mehta))).toBeNull();
    const w = (await pictureWindow(db, c, await id('w9')))!;
    expect(w.messages.map((m) => m.text)).not.toContain('Mehta only');
  });

  it('names people only: someone with no name is Member, never a number', async () => {
    const { db, c, ids, put, id } = await chat();
    // A person whose saved name is a number: senderLabel turns it into "Someone", which a picture shows as "Member".
    await upsertPerson(db, { clientId: ids.sharma, jid: '919800000099@s.whatsapp.net', number: '919800000099', name: '+91 98000 00099', fromMe: false });
    await put({ waId: 'u1', ts: at(30), senderJid: '919800000099@s.whatsapp.net', senderNumber: '919800000099', text: 'who am I' });
    const w = (await pictureWindow(db, c, await id('u1')))!;
    expect(w.messages.at(-1)!.sender).toBe('Member');
    expect(JSON.stringify(w)).not.toMatch(/9800000099|98000 00099/);
  });

  it('a sender with no people row, and the sender of a quoted message, are Member too', async () => {
    const { db, c, put, id } = await chat();
    await put({ waId: 'n1', ts: at(30), senderJid: '919800000088@s.whatsapp.net', senderNumber: '919800000088', senderName: null, text: 'no row' });
    await put({ waId: 'n2', ts: at(31), text: 'reply', quotedWaId: 'n1' });
    const w = (await pictureWindow(db, c, await id('n2')))!;
    expect(w.messages.at(-2)!.sender).toBe('Member');
    expect(w.messages.at(-1)!.quote).toMatchObject({ sender: 'Member', text: 'no row' });
    expect(JSON.stringify(w)).not.toContain('9800000088');
  });

  it('after Delete chat, shows around the source only what Open chat shows; a source the mark hides is shown alone', async () => {
    const { db, c, id } = await chat();
    // Delete chat pressed when message 4 was the newest: messages 1 to 4 are hidden, 5 to 9 came after.
    const mark: ChatHidden = { uptoTs: at(4), uptoId: await id('w4'), uptoRow: await id('w4'), floorTs: at(1), at: at(4), state: 'deleted', code: null };
    await setKv(db, chatHiddenKey(c.id), JSON.stringify(mark));
    const w = (await pictureWindow(db, c, await id('w6')))!;
    expect(w.messages.map((m) => m.text)).toEqual(['message 5', 'message 6', 'message 7', 'message 8']);
    expect(w.messages.map((m) => m.source)).toEqual([false, true, false, false]);
    // Open chat agrees: the same messages show there, and none of the hidden ones.
    const page = await chatPage(db, c, new Date(at(30)));
    expect(page.messages.map((m) => m.text).reverse()).toEqual(['message 5', 'message 6', 'message 7', 'message 8', 'message 9']);
    const hiddenSource = (await pictureWindow(db, c, await id('w3')))!;
    expect(hiddenSource.messages.map((m) => [m.text, m.source])).toEqual([['message 3', true]]);
  });

  it('messages at the same time as the source come before and after it by row', async () => {
    const { db, c, put, id } = await chat();
    for (const t of ['tie a', 'tie src', 'tie b', 'tie c']) await put({ waId: t, ts: at(50), text: t });
    const w = (await pictureWindow(db, c, await id('tie src')))!;
    expect(w.messages.map((m) => m.text)).toEqual(['message 7', 'message 8', 'message 9', 'tie a', 'tie src', 'tie b', 'tie c']);
    expect(w.messages.map((m) => m.source)).toEqual([false, false, false, false, true, false, false]);
  });

  it('shows a tag as the person’s name, or @member, never the digits; in a reply’s quote too', async () => {
    const { db, c, ids, put, id } = await chat();
    await upsertPerson(db, { clientId: ids.sharma, jid: '201111111111111@lid', number: null, name: 'Priya', fromMe: false });
    await put({ waId: 't1', ts: at(40), text: '@201111111111111 please check, @209999999999999 too' });
    await put({ waId: 't2', ts: at(41), text: 'on it', quotedWaId: 't1' });
    const w = (await pictureWindow(db, c, await id('t2')))!;
    expect(w.messages.at(-2)!.text).toBe('@Priya please check, @member too');
    expect(w.messages.at(-1)!.quote?.text).toBe('@Priya please check, @member too');
    expect(JSON.stringify(w)).not.toContain('201111111111111');
  });

  it('a deleted message is shown as deleted, with no text', async () => {
    const { db, c, ids, id } = await chat();
    await applyRevoke(db, ids.sharma, 'w5');
    const w = (await pictureWindow(db, c, await id('w5')))!;
    expect(w.messages[4]).toMatchObject({ deleted: true, text: '', source: true });
  });
});

describe('withTagNames', () => {
  it('names each tag, or @member; never a number, even one WhatsApp gives', async () => {
    const { db, c } = await chat();
    expect(await withTagNames(db, c, ['hi @919800000002', '@919800000055 hello', 'no tags'])).toEqual(['hi @Rahul', '@member hello', 'no tags']);
  });

  it('a group member with no name is @member even when WhatsApp gives their number', async () => {
    const { db, c } = await chat();
    const members = async () => [{ id: '919800000055@s.whatsapp.net', phoneNumber: '919800000055@s.whatsapp.net', lid: null, admin: false }];
    expect(await withTagNames(db, c, ['@919800000055 hello'], members)).toEqual(['@member hello']);
  });

  it('a person whose saved name is a number is @member', async () => {
    const { db, c, ids } = await chat();
    await upsertPerson(db, { clientId: ids.sharma, jid: '919800000077@s.whatsapp.net', number: '919800000077', name: '+91 98000 00077', fromMe: false });
    expect(await withTagNames(db, c, ['hi @919800000077'])).toEqual(['hi @member']);
  });
});
