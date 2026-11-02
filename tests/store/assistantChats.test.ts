import { describe, expect, it } from 'vitest';
import {
  addQuestion, BODY_MAX, chatMessages, cleanTitle, createChat, deleteChat, finishAnswer, getChat, listChats, renameChat, saveAnswer, setCardState,
  startAnswer, titleFrom, type StoredCard,
} from '../../src/store/assistantChats.ts';
import type { Db } from '../../src/store/db.ts';
import { testDb } from '../helpers/db.ts';
import { onPg, openTestTenantDb } from '../helpers/pg.ts';

// The assistant's chats (November release, changes 1 and 8), on SQLite and on Postgres (npm run test:pg), where each
// test's database is a customer of its own under row-level security.

const AT = (m: number) => `2026-11-02T08:${String(m).padStart(2, '0')}:00.000Z`;
const CARD: StoredCard = { id: 'c'.repeat(24), title: 'Add a task for ACM', lines: ['Title: Book the shoot'], expiresAt: '2026-11-02T08:20:00.000Z', state: 'waiting' };

async function withDb(fn: (db: Db) => Promise<void>): Promise<void> {
  const db = await testDb();
  try {
    await fn(db);
  } finally {
    await db.close();
  }
}

describe('titles', () => {
  it('a new chat is titled by its first question, folded and cut to 60 characters', () => {
    expect(titleFrom('  Summarise\n today  ')).toBe('Summarise today');
    expect(titleFrom('')).toBe('New chat');
    const long = titleFrom('word '.repeat(30));
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith('…')).toBe(true);
  });

  it('a title the owner types: 1 to 80 characters once folded', () => {
    expect(cleanTitle('  Acme   plan ')).toBe('Acme plan');
    for (const bad of ['', '   ', 'x'.repeat(81), 42, null]) expect(cleanTitle(bad), String(bad)).toBeUndefined();
    expect(cleanTitle('x'.repeat(80))).toHaveLength(80);
  });
});

describe('the chat store', () => {
  it('creates, lists (most recent first), renames and reads a chat', () =>
    withDb(async (db) => {
      const a = await createChat(db, { createdBy: 'owner@example.com', title: 'First', at: AT(1) });
      const b = await createChat(db, { createdBy: 'other@example.com', title: 'Second', at: AT(2) });
      expect((await listChats(db)).map((c) => c.title)).toEqual(['Second', 'First']);
      await addQuestion(db, a.id, 'Hello again', AT(3)); // using a chat moves it up
      expect((await listChats(db)).map((c) => c.id)).toEqual([a.id, b.id]);
      expect(await renameChat(db, a.id, '  Acme  plan ', AT(4))).toBe(true);
      expect(await getChat(db, a.id)).toEqual({ id: a.id, title: 'Acme plan', createdBy: 'owner@example.com', createdAt: AT(1), updatedAt: AT(4) });
      await expect(renameChat(db, a.id, '', AT(5))).rejects.toThrow('1 to 80');
      expect(await renameChat(db, 999_999_999, 'x', AT(5))).toBe(false);
      expect(await getChat(db, 999_999_999)).toBeUndefined();
    }));

  it('keeps a question, then an answer as it runs, and as it ended', () =>
    withDb(async (db) => {
      const c = await createChat(db, { createdBy: 'owner@example.com', title: 'Today', at: AT(1) });
      await addQuestion(db, c.id, 'Summarise today', AT(1));
      const id = await startAnswer(db, c.id, AT(2));
      expect((await chatMessages(db, c.id)).map((m) => [m.role, m.status, m.body])).toEqual([['user', 'done', 'Summarise today'], ['assistant', 'running', '']]);
      await saveAnswer(db, id, { body: 'Today at a', cards: [CARD], links: [], at: AT(3) });
      expect((await chatMessages(db, c.id))[1]).toMatchObject({ status: 'running', body: 'Today at a', cards: [CARD] });
      await finishAnswer(db, id, { chatId: c.id, body: 'Today at a glance.', status: 'done', note: null, costUsd: 0.02, cards: [CARD], links: [{ screen: 'tasks', search: '?status=overdue', label: 'tasks (status overdue)' }], at: AT(4) });
      const done = (await chatMessages(db, c.id))[1]!;
      expect(done).toMatchObject({ status: 'done', body: 'Today at a glance.', costUsd: 0.02, note: null });
      expect(done.links).toEqual([{ screen: 'tasks', search: '?status=overdue', label: 'tasks (status overdue)' }]);
      // A finished answer is never written over by a late save.
      await saveAnswer(db, id, { body: 'late', cards: [], links: [], at: AT(5) });
      expect((await chatMessages(db, c.id))[1]!.body).toBe('Today at a glance.');
      expect((await getChat(db, c.id))!.updatedAt).toBe(AT(4));
    }));

  it('records what became of a card, and a stopped answer keeps its text and note', () =>
    withDb(async (db) => {
      const c = await createChat(db, { createdBy: 'owner@example.com', title: 'Task', at: AT(1) });
      const id = await startAnswer(db, c.id, AT(1));
      await finishAnswer(db, id, { chatId: c.id, body: 'Here it is', status: 'stopped', note: 'Stopped.', costUsd: 0.01, cards: [CARD, { ...CARD, id: 'd'.repeat(24) }], links: [], at: AT(2) });
      expect(await setCardState(db, id, CARD.id, 'confirmed', 'ACM-006 added.', AT(3))).toBe(true);
      expect(await setCardState(db, id, 'd'.repeat(24), 'cancelled', undefined, AT(3))).toBe(true);
      expect(await setCardState(db, id, 'e'.repeat(24), 'cancelled', undefined, AT(3))).toBe(false);
      const m = (await chatMessages(db, c.id))[0]!;
      expect(m).toMatchObject({ status: 'stopped', note: 'Stopped.', body: 'Here it is' });
      expect(m.cards.map((x) => [x.state, x.said])).toEqual([['confirmed', 'ACM-006 added.'], ['cancelled', undefined]]);
    }));

  it('a card decided while its answer still runs stays decided through the answer\'s later saves and its end', () =>
    withDb(async (db) => {
      const c = await createChat(db, { createdBy: 'owner@example.com', title: 'Task', at: AT(1) });
      const id = await startAnswer(db, c.id, AT(1));
      const other: StoredCard = { ...CARD, id: 'd'.repeat(24) };
      await saveAnswer(db, id, { body: 'Drafted', cards: [CARD, other], links: [], at: AT(2) });
      expect(await setCardState(db, id, CARD.id, 'confirmed', 'ACM-006 added.', AT(3))).toBe(true);
      expect(await setCardState(db, id, other.id, 'cancelled', undefined, AT(3))).toBe(true);
      // The run's own copy still says waiting, and it drafted one more since: the save keeps both decisions, adds the new one.
      const later: StoredCard = { ...CARD, id: 'e'.repeat(24) };
      const cards = async () => (await chatMessages(db, c.id))[0]!.cards.map((x) => [x.id, x.state, x.said]);
      const decided = [[CARD.id, 'confirmed', 'ACM-006 added.'], [other.id, 'cancelled', undefined], [later.id, 'waiting', undefined]];
      await saveAnswer(db, id, { body: 'Drafted, and more', cards: [CARD, other, later], links: [], at: AT(4) });
      expect(await cards()).toEqual(decided);
      expect((await chatMessages(db, c.id))[0]).toMatchObject({ status: 'running', body: 'Drafted, and more' });
      await finishAnswer(db, id, { chatId: c.id, body: 'Done.', status: 'done', costUsd: 0.01, cards: [CARD, other, later], links: [], at: AT(5) });
      expect(await cards()).toEqual(decided);
      expect((await chatMessages(db, c.id))[0]).toMatchObject({ status: 'done', body: 'Done.' });
      expect((await getChat(db, c.id))!.updatedAt).toBe(AT(5));
    }));

  it('cuts a long answer to its limit, and reads damaged JSON as nothing rather than failing', () =>
    withDb(async (db) => {
      const c = await createChat(db, { createdBy: 'owner@example.com', title: 'Long', at: AT(1) });
      const id = await startAnswer(db, c.id, AT(1));
      await finishAnswer(db, id, { chatId: c.id, body: 'x'.repeat(BODY_MAX + 50), status: 'done', costUsd: 0, cards: [], links: [], at: AT(2) });
      expect((await chatMessages(db, c.id))[0]!.body).toHaveLength(BODY_MAX);
      await db.run("UPDATE assistant_messages SET cards = '{not json', links = '[{\"x\":1}]' WHERE id = ?", [id]);
      expect((await chatMessages(db, c.id))[0]).toMatchObject({ cards: [], links: [] });
    }));

  it('deletes a chat with its messages, and only that chat', () =>
    withDb(async (db) => {
      const a = await createChat(db, { createdBy: 'owner@example.com', title: 'Gone', at: AT(1) });
      const b = await createChat(db, { createdBy: 'owner@example.com', title: 'Kept', at: AT(1) });
      await addQuestion(db, a.id, 'one', AT(1));
      await addQuestion(db, b.id, 'two', AT(1));
      expect(await deleteChat(db, a.id)).toBe(true);
      expect(await deleteChat(db, a.id)).toBe(false);
      expect(await getChat(db, a.id)).toBeUndefined();
      expect(await chatMessages(db, a.id)).toEqual([]);
      expect((await chatMessages(db, b.id)).map((m) => m.body)).toEqual(['two']);
    }));
});

describe.runIf(onPg)('the chat store on Postgres: each workspace sees only its own chats (row-level security)', () => {
  it('another workspace cannot list, read, rename, write to, mark a card in or delete a chat', async () => {
    const a = await openTestTenantDb('a');
    const b = await openTestTenantDb('b');
    const mine = await createChat(a, { createdBy: 'owner@a.example', title: 'Private', at: AT(1) });
    await addQuestion(a, mine.id, 'a secret question', AT(1));
    const answer = await startAnswer(a, mine.id, AT(2));
    await finishAnswer(a, answer, { chatId: mine.id, body: 'secret', status: 'done', costUsd: 0, cards: [CARD], links: [], at: AT(2) });

    expect(await listChats(b)).toEqual([]);
    expect(await getChat(b, mine.id)).toBeUndefined();
    expect(await chatMessages(b, mine.id)).toEqual([]);
    expect(await renameChat(b, mine.id, 'taken', AT(3))).toBe(false);
    expect(await setCardState(b, answer, CARD.id, 'confirmed', 'no', AT(3))).toBe(false);
    expect(await deleteChat(b, mine.id)).toBe(false);
    // B cannot put a message into A's chat: the foreign key is (tenant_id, chat_id), and A's chat is not B's.
    await expect(addQuestion(b, mine.id, 'injected', AT(3))).rejects.toThrow();

    expect(await getChat(a, mine.id)).toMatchObject({ title: 'Private' });
    expect((await chatMessages(a, mine.id)).map((m) => [m.body, m.cards[0]?.state])).toEqual([['a secret question', undefined], ['secret', 'waiting']]);
  });
});
