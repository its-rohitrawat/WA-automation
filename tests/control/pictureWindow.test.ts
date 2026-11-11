import { describe, expect, it } from 'vitest';
import { pictureWindow, withTagNames } from '../../src/control/chatQueries.ts';
import { getClientByCode } from '../../src/store/clients.ts';
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
    const { db, c, put, id } = await chat();
    await put({ waId: 'u1', ts: at(30), senderJid: '919800000099@s.whatsapp.net', senderNumber: '919800000099', senderName: '+91 98000 00099', text: 'who am I' });
    const w = (await pictureWindow(db, c, await id('u1')))!;
    expect(w.messages.at(-1)!.sender).toBe('Member');
    expect(JSON.stringify(w)).not.toMatch(/9800000099|98000 00099/);
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
});
