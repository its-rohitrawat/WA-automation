import type { Db, Sql } from './db.ts';

// The assistant's chats (migration v13, Postgres P6; November release, changes 1 and 8). Kept per workspace: on Postgres
// every statement runs as the workspace's customer, so row-level security keeps each workspace to its own chats, and an
// id from another workspace is simply not found. A chat is a list of messages: a question (user, done) or an answer
// (assistant), which is running while the agent writes it, then done, stopped or failed. An answer's change cards and the
// screens it named are kept with it (JSON text) so a chat opened again shows them. Never logged: titles, questions and
// answers are the owner's words.

/** Past chats the list shows, newest first. */
export const CHATS_LIST_MAX = 200;
/** A title, after trimming. A new chat's title is its first question, cut to TITLE_FROM_QUESTION. */
export const TITLE_MAX = 80;
const TITLE_FROM_QUESTION = 60;
/** A message's text is kept to this length (the column's limit). */
export const BODY_MAX = 16_000;
const NOTE_MAX = 300;
const CARDS_MAX = 5;
const LINKS_MAX = 10;

export type MessageStatus = 'running' | 'done' | 'stopped' | 'failed';

export interface ChatSummary {
  id: number;
  title: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** A drafted change as the chat keeps it: waiting (its Confirm may still be live), confirmed or cancelled. */
export interface StoredCard {
  id: string;
  title: string;
  lines: string[];
  expiresAt: string;
  state: 'waiting' | 'confirmed' | 'cancelled';
  /** What Confirm said ("ACM-006 added."). */
  said?: string;
}

/** A screen the answer named, for its "Open …" link. */
export interface StoredLink {
  screen: string;
  search: string;
  label: string;
}

export interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  body: string;
  status: MessageStatus;
  note: string | null;
  costUsd: number;
  cards: StoredCard[];
  links: StoredLink[];
  createdAt: string;
  updatedAt: string;
}

interface RawChat {
  id: number;
  title: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface RawMessage {
  id: number;
  role: 'user' | 'assistant';
  body: string;
  status: MessageStatus;
  note: string | null;
  cost_usd: number;
  cards: string;
  links: string;
  created_at: string;
  updated_at: string;
}

const toChat = (r: RawChat): ChatSummary => ({ id: Number(r.id), title: r.title, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at });

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');

/** The cards as stored, made safe: anything malformed is dropped. */
function readCards(text: string): StoredCard[] {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  return v.slice(0, CARDS_MAX).flatMap((c): StoredCard[] => {
    if (typeof c !== 'object' || c === null) return [];
    const o = c as Record<string, unknown>;
    if (typeof o.id !== 'string' || !['waiting', 'confirmed', 'cancelled'].includes(String(o.state))) return [];
    return [{
      id: o.id.slice(0, 60), title: str(o.title, 200), lines: Array.isArray(o.lines) ? o.lines.slice(0, 12).map((l) => str(l, 300)) : [],
      expiresAt: str(o.expiresAt, 40), state: o.state as StoredCard['state'], ...(typeof o.said === 'string' ? { said: o.said.slice(0, 200) } : {}),
    }];
  });
}

function readLinks(text: string): StoredLink[] {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  return v.slice(0, LINKS_MAX).flatMap((l): StoredLink[] => {
    if (typeof l !== 'object' || l === null) return [];
    const o = l as Record<string, unknown>;
    return typeof o.screen === 'string' ? [{ screen: o.screen.slice(0, 40), search: str(o.search, 200), label: str(o.label, 80) }] : [];
  });
}

const toMessage = (r: RawMessage): ChatMessage => ({
  id: Number(r.id), role: r.role, body: r.body, status: r.status, note: r.note, costUsd: Number(r.cost_usd) || 0,
  cards: readCards(r.cards), links: readLinks(r.links), createdAt: r.created_at, updatedAt: r.updated_at,
});

/** Whitespace folded and trimmed. */
const fold = (s: string) => s.replace(/\s+/g, ' ').trim();

/** A new chat's title: its first question, folded and cut to 60 characters (with "…" when cut). */
export function titleFrom(question: string): string {
  const q = fold(question);
  if (q === '') return 'New chat';
  return q.length <= TITLE_FROM_QUESTION ? q : `${q.slice(0, TITLE_FROM_QUESTION - 1).trimEnd()}…`;
}

/** A title the owner typed: folded; undefined when empty or longer than TITLE_MAX. */
export function cleanTitle(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = fold(raw);
  return t.length >= 1 && t.length <= TITLE_MAX ? t : undefined;
}

const cardsText = (cards: readonly StoredCard[]) => JSON.stringify(cards.slice(0, CARDS_MAX));
const linksText = (links: readonly StoredLink[]) => JSON.stringify(links.slice(0, LINKS_MAX));
const noteText = (note: string | null | undefined) => (note ? note.slice(0, NOTE_MAX) : null);

/** The workspace's chats, the most recently used first. */
export async function listChats(db: Sql): Promise<ChatSummary[]> {
  return (await db.all<RawChat>(`SELECT id, title, created_by, created_at, updated_at FROM assistant_chats ORDER BY updated_at DESC, id DESC LIMIT ${CHATS_LIST_MAX}`)).map(toChat);
}

export async function getChat(db: Sql, id: number): Promise<ChatSummary | undefined> {
  const r = await db.get<RawChat>('SELECT id, title, created_by, created_at, updated_at FROM assistant_chats WHERE id = ?', [id]);
  return r ? toChat(r) : undefined;
}

/** A chat's messages, oldest first. */
export async function chatMessages(db: Sql, chatId: number): Promise<ChatMessage[]> {
  return (await db.all<RawMessage>(
    'SELECT id, role, body, status, note, cost_usd, cards, links, created_at, updated_at FROM assistant_messages WHERE chat_id = ? ORDER BY id',
    [chatId],
  )).map(toMessage);
}

export async function createChat(db: Sql, o: { createdBy: string; title: string; at: string }): Promise<ChatSummary> {
  const r = (await db.get<RawChat>(
    'INSERT INTO assistant_chats (created_by, title, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING id, title, created_by, created_at, updated_at',
    [o.createdBy.slice(0, 320), cleanTitle(o.title) ?? 'New chat', o.at, o.at],
  ))!;
  return toChat(r);
}

/** Renames a chat; false when there is no such chat (here). */
export async function renameChat(db: Sql, id: number, title: string, at: string): Promise<boolean> {
  const t = cleanTitle(title);
  if (t === undefined) throw new Error('a chat title must be 1 to 80 characters');
  return (await db.run('UPDATE assistant_chats SET title = ?, updated_at = ? WHERE id = ?', [t, at, id])).changes > 0;
}

/** Deletes a chat and its messages in one transaction; false when there is no such chat (here). */
export async function deleteChat(db: Db, id: number): Promise<boolean> {
  return db.tx(async (q) => {
    await q.run('DELETE FROM assistant_messages WHERE chat_id = ?', [id]);
    return (await q.run('DELETE FROM assistant_chats WHERE id = ?', [id])).changes > 0;
  });
}

/** The owner's question, stored as asked (cut to BODY_MAX); the chat moves to the top of the list. */
export async function addQuestion(db: Sql, chatId: number, text: string, at: string): Promise<number> {
  const r = (await db.get<{ id: number }>(
    "INSERT INTO assistant_messages (chat_id, role, body, status, created_at, updated_at) VALUES (?, 'user', ?, 'done', ?, ?) RETURNING id",
    [chatId, text.slice(0, BODY_MAX), at, at],
  ))!;
  await db.run('UPDATE assistant_chats SET updated_at = ? WHERE id = ?', [at, chatId]);
  return Number(r.id);
}

/** An answer the agent is about to write: empty and running. */
export async function startAnswer(db: Sql, chatId: number, at: string): Promise<number> {
  const r = (await db.get<{ id: number }>(
    "INSERT INTO assistant_messages (chat_id, role, body, status, created_at, updated_at) VALUES (?, 'assistant', '', 'running', ?, ?) RETURNING id",
    [chatId, at, at],
  ))!;
  return Number(r.id);
}

/** The answer so far, while it runs (it stays running). */
export async function saveAnswer(db: Sql, id: number, o: { body: string; cards: readonly StoredCard[]; links: readonly StoredLink[]; at: string }): Promise<void> {
  await db.run(
    "UPDATE assistant_messages SET body = ?, cards = ?, links = ?, updated_at = ? WHERE id = ? AND status = 'running'",
    [o.body.slice(0, BODY_MAX), cardsText(o.cards), linksText(o.links), o.at, id],
  );
}

/** The answer as it ended: done, stopped (the owner's Stop) or failed, with its note and cost; the chat moves up. */
export async function finishAnswer(
  db: Sql,
  id: number,
  o: { chatId: number; body: string; status: Exclude<MessageStatus, 'running'>; note?: string | null; costUsd: number; cards: readonly StoredCard[]; links: readonly StoredLink[]; at: string },
): Promise<void> {
  await db.run(
    'UPDATE assistant_messages SET body = ?, status = ?, note = ?, cost_usd = ?, cards = ?, links = ?, updated_at = ? WHERE id = ?',
    [o.body.slice(0, BODY_MAX), o.status, noteText(o.note), Number.isFinite(o.costUsd) && o.costUsd > 0 ? o.costUsd : 0, cardsText(o.cards), linksText(o.links), o.at, id],
  );
  await db.run('UPDATE assistant_chats SET updated_at = ? WHERE id = ?', [o.at, o.chatId]);
}

/**
 * What became of a card (Confirm or Cancel), in the answer that drafted it: read and written in one transaction, so two
 * cards of one answer decided at once both stay. False when the answer or the card is not here.
 */
export async function setCardState(db: Db, messageId: number, cardId: string, state: 'confirmed' | 'cancelled', said: string | undefined, at: string): Promise<boolean> {
  return db.tx(async (q) => {
    const r = await q.get<{ cards: string }>("SELECT cards FROM assistant_messages WHERE id = ? AND role = 'assistant'", [messageId]);
    if (!r) return false;
    const cards = readCards(r.cards);
    const card = cards.find((c) => c.id === cardId);
    if (!card) return false;
    card.state = state;
    if (said !== undefined) card.said = said.slice(0, 200);
    await q.run('UPDATE assistant_messages SET cards = ?, updated_at = ? WHERE id = ?', [cardsText(cards), at, messageId]);
    return true;
  });
}
