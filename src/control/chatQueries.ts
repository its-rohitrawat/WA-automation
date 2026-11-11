import type { ClientRow } from '../store/clients.ts';
import type { Db, Sql } from '../store/db.ts';
import { getKv, setKv } from '../store/kv.ts';
import { outboxToShow, type OutboxRow, type OutboxState } from '../store/outbox.ts';
import { memberTagged, mentionTags, peopleOfMember, peopleTagged, replaceTags, tagOf, type GroupMember } from '../wa/groupMembers.ts';
import { messageKind, oneLine, senderLabel, type ClientMessage } from './clientQueries.ts';

// Open chat (owner request, 29 Oct 2026): a client's group as stored, a page at a time, newest first. Least data: a
// message is its row number (the cursor, and what Reply names), time, side, the sender's shown name, text and kind.
// Never a WhatsApp id or a JID; a phone number only for a group member the agent has no name for (the group info panel
// and a tag naming them, as WhatsApp itself shows them). Text is untrusted: the browser shows it as text only.

export const CHAT_PAGE = 50;
export const CHAT_PAGE_MAX = 100;
/** A message's text in the chat: whole, up to WhatsApp's own limit. */
const TEXT_MAX = 4096;
const TRANSCRIPT_MAX = 2000;
const QUOTE_MAX = 140;
/** How far back the chat shows the dashboard's own messages that did not (surely) go. */
const OUTBOX_DAYS = 7;

export interface ChatMessage {
  id: number;
  at: string;
  /** Sent from the founder's WhatsApp (the phone, or this dashboard). */
  mine: boolean;
  sender: string;
  /** Empty for a deleted message, or media with no caption. */
  text: string;
  kind: ClientMessage['kind'];
  seconds: number | null;
  /** A voice note's or audio file's transcript, when there is one. */
  transcript: string | null;
  quote: { sender: string; text: string; kind: ClientMessage['kind'] } | null;
  edited: boolean;
  deleted: boolean;
}

/** A message from the dashboard that the chat shows on its own (see outboxToShow). */
export interface ChatOutboxItem {
  uuid: string;
  at: string;
  text: string;
  state: OutboxState;
  /** The message replied to, as a quote. */
  quote: { sender: string; text: string; kind: ClientMessage['kind'] } | null;
}

export interface ChatPage {
  messages: ChatMessage[];
  /** There are older messages than this page. */
  hasOlder: boolean;
  outbox: ChatOutboxItem[];
  /**
   * The agent's name for each tag ("@<digits>") the page's texts hold, when it knows one (November release): the
   * person's name, else the number WhatsApp gives for that group member (owner report, 11 Nov). A tag it cannot name
   * is left out.
   */
  names: Record<string, string>;
  /** The owner deleted this chat (Delete chat) and nothing has come since: the newest page is empty for that reason. */
  cleared: boolean;
}

// Line breaks stay (a chat message keeps its lines); other control and direction characters go.
const UNPRINTABLE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u2028\u2029\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]+/g;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** The text as shown: line breaks kept, at most max whole characters, "…" when cut. */
function chatText(text: string | null, max: number): string {
  const s = (text ?? '').replace(/\r\n?/g, '\n').replace(UNPRINTABLE, ' ').trim();
  const parts = Array.from(graphemes.segment(s), (g) => g.segment);
  return parts.length > max ? `${parts.slice(0, max - 1).join('').trimEnd()}…` : s;
}

interface RawMessage {
  id: number;
  at: string;
  fromMe: number;
  text: string | null;
  mediaType: string | null;
  edited: string | null;
  revoked: number;
  name: string | null;
  kind: string | null;
  seconds: number | null;
  mediaStatus: string | null;
  mediaText: string | null;
  qFromMe: number | null;
  qText: string | null;
  qMediaType: string | null;
  qKind: string | null;
  qName: string | null;
  qRevoked: number | null;
}

const SELECT = `SELECT m.id, m.ts AS at, m.from_me AS fromMe, m.text, m.media_type AS mediaType, m.edited_at AS edited, m.revoked,
    p.name, md.kind, md.seconds, md.status AS mediaStatus, md.text AS mediaText,
    q.from_me AS qFromMe, q.text AS qText, q.media_type AS qMediaType, qmd.kind AS qKind, qp.name AS qName, q.revoked AS qRevoked
  FROM messages m
  LEFT JOIN people p ON p.client_id = m.client_id AND p.jid = m.sender_jid
  LEFT JOIN media md ON md.message_id = m.id
  LEFT JOIN messages q ON q.client_id = m.client_id AND q.wa_id = m.quoted_wa_id
  LEFT JOIN people qp ON qp.client_id = q.client_id AND qp.jid = q.sender_jid
  LEFT JOIN media qmd ON qmd.message_id = q.id`;

function toMessage(r: RawMessage): ChatMessage {
  const kind = messageKind(r.kind, r.mediaType);
  const audio = kind === 'voice' || kind === 'audio';
  const deleted = r.revoked === 1;
  const quoted = r.qFromMe !== null;
  return {
    id: r.id, at: r.at, mine: r.fromMe === 1, sender: senderLabel(r.name, r.fromMe === 1),
    text: deleted ? '' : chatText(r.text, TEXT_MAX), kind,
    seconds: audio && Number.isInteger(r.seconds) ? r.seconds : null,
    transcript: !deleted && audio && r.mediaStatus === 'done' && r.mediaText ? chatText(r.mediaText, TRANSCRIPT_MAX) : null,
    quote: quoted && !deleted
      ? { sender: senderLabel(r.qName, r.qFromMe === 1), text: r.qRevoked === 1 ? '' : oneLine(r.qText, QUOTE_MAX), kind: messageKind(r.qKind, r.qMediaType) }
      : null,
    edited: r.edited !== null && !deleted, deleted,
  };
}

/** One stored message of this client, as the chat shows it, or null (a quote for a reply). */
async function messageQuote(db: Db, clientId: number, id: number): Promise<ChatOutboxItem['quote']> {
  const r = await db.get<RawMessage>(`${SELECT} WHERE m.client_id = ? AND m.id = ?`, [clientId, id]);
  if (!r) return null;
  const m = toMessage(r);
  return { sender: m.sender, text: oneLine(m.text, QUOTE_MAX), kind: m.kind };
}

/**
 * A page of the chat: the `limit` messages before the message `before` (by time, then row), newest first, or the newest
 * when `before` is not given; and the dashboard's own messages still to show. Parameterised reads only. `members`: the
 * group's members, asked for only when the client's people alone do not name every tag on the page.
 */
export async function chatPage(
  db: Db, c: ClientRow, now: Date, o: { before?: number; limit?: number; members?: () => Promise<readonly GroupMember[] | null> } = {},
): Promise<ChatPage> {
  const limit = Math.max(1, Math.min(CHAT_PAGE_MAX, Math.floor(o.limit ?? CHAT_PAGE)));
  let rows: RawMessage[];
  // After Delete chat, only what came after its mark (by time, then row); with no mark, everything.
  const hidden = await chatHidden(db, c.id);
  const floor = markParams(hidden);
  if (o.before !== undefined) {
    const cursor = await db.get<{ ts: string; id: number }>('SELECT ts, id FROM messages WHERE client_id = ? AND id = ?', [c.id, o.before]);
    rows = cursor
      ? await db.all<RawMessage>(
        `${SELECT} WHERE m.client_id = @client AND (m.ts < @ts OR (m.ts = @ts AND m.id < @id)) AND ${AFTER_MARK} ORDER BY m.ts DESC, m.id DESC LIMIT @limit`,
        { client: c.id, ts: cursor.ts, id: cursor.id, limit: limit + 1, ...floor },
      )
      : [];
  } else {
    rows = await db.all<RawMessage>(`${SELECT} WHERE m.client_id = @client AND ${AFTER_MARK} ORDER BY m.ts DESC, m.id DESC LIMIT @limit`, { client: c.id, limit: limit + 1, ...floor });
  }
  const since = new Date(now.getTime() - OUTBOX_DAYS * 86_400_000).toISOString();
  const outbox: ChatOutboxItem[] = [];
  if (o.before === undefined) {
    for (const row of await outboxToShow(db, c.id, since)) if (!hidden || row.createdAt > hidden.at) outbox.push(await outboxItem(db, row));
  }
  const messages = rows.slice(0, limit).map(toMessage);
  const texts = [...messages, ...outbox].flatMap((x) => [x.text, x.quote?.text ?? '']);
  return {
    messages, hasOlder: rows.length > limit, outbox, names: await tagNames(db, c, texts, o.members),
    cleared: hidden !== null && o.before === undefined && messages.length === 0 && outbox.length === 0,
  };
}

/**
 * Delete chat's mark for a client (November release, owner decision 2 Nov 2026), in the key-value store, so no schema
 * change: the newest message the delete reached (by time, then row), when it was asked, and how it went. The chat shows
 * only what came after it, so a new message brings the chat back. Nothing is removed from the agent's store.
 * uptoRow and floorTs (final review, item 1): the highest row and the oldest time stored at the press. A row stored later
 * shows even with an earlier WhatsApp time (a message written on a phone that was offline), unless it is older than
 * everything the chat had then: history backfill only ever stores such older messages, and those stay hidden.
 */
export interface ChatHidden {
  uptoTs: string;
  uptoId: number;
  uptoRow?: number;
  floorTs?: string;
  at: string;
  state: 'asking' | 'deleted' | 'unknown';
  code: string | null;
}

/** The messages a mark leaves showing (m is the messages table); no mark: every one. Its values: markParams. */
const AFTER_MARK = '(m.ts > @hts OR (m.ts = @hts AND m.id > @hid) OR (m.id > @hrow AND m.ts >= @hfloor))';

/** AFTER_MARK's values; a mark from before uptoRow (none in use) shows nothing stored later by row alone. */
const markParams = (h: ChatHidden | null) => ({
  hts: h?.uptoTs ?? '', hid: h?.uptoId ?? 0, hrow: h?.uptoRow ?? Number.MAX_SAFE_INTEGER, hfloor: h?.floorTs ?? '',
});

/** Whether a message shows after the mark: something new since that delete. */
export async function newSinceMark(db: Sql, clientId: number, h: ChatHidden): Promise<boolean> {
  return (await db.get<{ one: number }>(`SELECT 1 AS one FROM messages m WHERE m.client_id = @client AND ${AFTER_MARK} LIMIT 1`, { client: clientId, ...markParams(h) })) !== undefined;
}

export const chatHiddenKey = (clientId: number): string => `chat_hidden:${clientId}`;

const HIDDEN_STATES: readonly string[] = ['asking', 'deleted', 'unknown'];

/** The client's mark, or null (none, or one that can't be read: that hides nothing). */
export async function chatHidden(db: Sql, clientId: number): Promise<ChatHidden | null> {
  const raw = await getKv(db, chatHiddenKey(clientId));
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<ChatHidden>;
    if (typeof v.uptoTs === 'string' && typeof v.uptoId === 'number' && Number.isInteger(v.uptoId) && typeof v.at === 'string' && typeof v.state === 'string' && HIDDEN_STATES.includes(v.state)) {
      const row = typeof v.uptoRow === 'number' && Number.isInteger(v.uptoRow) && typeof v.floorTs === 'string' ? { uptoRow: v.uptoRow, floorTs: v.floorTs } : {};
      return { uptoTs: v.uptoTs, uptoId: v.uptoId, ...row, at: v.at, state: v.state, code: typeof v.code === 'string' ? v.code : null };
    }
  } catch {
    // an unreadable mark hides nothing
  }
  return null;
}

/**
 * When a group's phone changes (a move, or an approval of a group that already has messages), the highest row stored
 * until then: those were read by another phone, whose own messages are not the new phone's (final review, item 2).
 */
export const chatPhoneFromKey = (clientId: number): string => `chat_phone_from:${clientId}`;

/** Records a change of the client's group's phone: every row stored so far was read by another phone. */
export async function noteReadingPhoneChange(db: Sql, clientId: number): Promise<void> {
  const top = (await db.get<{ id: number | null }>('SELECT max(id) AS id FROM messages WHERE client_id = ?', [clientId]))?.id ?? null;
  if (top !== null) await setKv(db, chatPhoneFromKey(clientId), JSON.stringify({ fromRow: Number(top) }));
}

/** The highest row read by a phone before the group's current one, or null (no change of phone recorded). */
export async function readingPhoneFrom(db: Sql, clientId: number): Promise<number | null> {
  const raw = await getKv(db, chatPhoneFromKey(clientId));
  try {
    const v = raw ? (JSON.parse(raw) as { fromRow?: unknown }) : null;
    return v && typeof v.fromRow === 'number' && Number.isInteger(v.fromRow) ? v.fromRow : null;
  } catch {
    return Number.MAX_SAFE_INTEGER; // unreadable: no stored row is surely this phone's
  }
}

/**
 * The names of the tags in some texts: for each "@<digits>", the first of this client's people it names (peopleTagged)
 * that has a name, as the chat would name them; else, for a group member, the number WhatsApp gives. The members are
 * asked for only when the people alone leave a tag unnamed. Parameterised reads only, and only this client's rows.
 */
async function tagNames(db: Db, c: ClientRow, texts: readonly string[], members?: () => Promise<readonly GroupMember[] | null>): Promise<Record<string, string>> {
  const tags = new Set(texts.flatMap((t) => [...mentionTags(t)]));
  const names: Record<string, string> = {};
  if (tags.size === 0) return names;
  const people = await db.all<{ jid: string; number: string | null; name: string | null }>('SELECT jid, number, name FROM people WHERE client_id = ?', [c.id]);
  const nameOf = (tag: string, list: readonly GroupMember[] | null): string | null => {
    const name = peopleTagged(tag, people, list).map((p) => memberName(p.name)).find((n) => n !== null) ?? null;
    const number = memberTagged(tag, list)?.phoneNumber ?? null;
    return name ?? (number ? shownNumber(number) : null);
  };
  for (const tag of tags) {
    const name = nameOf(tag, null);
    if (name) names[tag] = name;
  }
  const unnamed = [...tags].filter((tag) => !Object.hasOwn(names, tag));
  const list = unnamed.length > 0 && members ? await members().catch(() => null) : null;
  for (const tag of list ? unnamed : []) {
    const name = nameOf(tag, list);
    if (name) names[tag] = name;
  }
  return names;
}

/**
 * The texts with every tag ("@<digits>") as the person's name, or "@member" when the agent has none: never a number,
 * not even the one WhatsApp gives for a group member. A chat picture and the tracker go beyond the dashboard (owner
 * decision, 11 Nov 2026). The members are asked for only when this client's people leave a tag unnamed, as tagNames does.
 */
export async function withTagNames(db: Db, c: ClientRow, texts: readonly string[], members?: () => Promise<readonly GroupMember[] | null>): Promise<string[]> {
  const names = await tagNames(db, c, texts, members);
  return texts.map((t) => replaceTags(t, (tag) => {
    const n = names[tag];
    // tagNames gives a group member's number, shown as "+91 …", when it has no name, so a name that looks like a number is not shown.
    return `@${n !== undefined && !LOOKS_LIKE_NUMBER.test(n) ? n : 'member'}`;
  }));
}

/** How many messages a chat picture shows before and after its source (owner decision, 11 Nov 2026). */
export const PICTURE_BEFORE = 4;
export const PICTURE_AFTER = 2;

/** A message in a chat picture: as Open chat shows it, and whether it is the task's source (the highlighted one). */
export type PictureMessage = ChatMessage & { source: boolean };

export interface PictureWindow {
  client: { code: string; name: string };
  /** Oldest first. */
  messages: PictureMessage[];
}

/**
 * The messages a task's chat picture shows (owner request, 11 Nov 2026): this client's message `messageId`, the
 * PICTURE_BEFORE before it and the PICTURE_AFTER after it (by time, then row), oldest first, as Open chat shows them.
 * Senders and tags are by name only: someone with no name is "Member", a tag with no name "@member", never a number. A
 * reply's quote comes with its message. Null when the message is not this client's. Parameterised reads only.
 *
 * After Delete chat, the messages around the source are only those its mark leaves showing, as in Open chat (chatPage).
 * The source itself is always shown. When the mark hides the source too, it is shown alone: what Open chat shows next
 * came after the delete, not around the source.
 */
export async function pictureWindow(db: Db, c: ClientRow, messageId: number, members?: () => Promise<readonly GroupMember[] | null>): Promise<PictureWindow | null> {
  const src = await db.get<RawMessage>(`${SELECT} WHERE m.client_id = ? AND m.id = ?`, [c.id, messageId]);
  if (!src) return null;
  const hidden = await chatHidden(db, c.id);
  const floor = markParams(hidden);
  const sourceShows = hidden === null
    || (await db.get<{ one: number }>(`SELECT 1 AS one FROM messages m WHERE m.client_id = @client AND m.id = @id AND ${AFTER_MARK}`, { client: c.id, id: src.id, ...floor })) !== undefined;
  const before = sourceShows
    ? await db.all<RawMessage>(
      `${SELECT} WHERE m.client_id = @client AND (m.ts < @ts OR (m.ts = @ts AND m.id < @id)) AND ${AFTER_MARK} ORDER BY m.ts DESC, m.id DESC LIMIT @limit`,
      { client: c.id, ts: src.at, id: src.id, limit: PICTURE_BEFORE, ...floor },
    )
    : [];
  const after = sourceShows
    ? await db.all<RawMessage>(
      `${SELECT} WHERE m.client_id = @client AND (m.ts > @ts OR (m.ts = @ts AND m.id > @id)) AND ${AFTER_MARK} ORDER BY m.ts, m.id LIMIT @limit`,
      { client: c.id, ts: src.at, id: src.id, limit: PICTURE_AFTER, ...floor },
    )
    : [];
  const shown = [...before.reverse(), src, ...after].map((r) => {
    const m = toMessage(r);
    // senderLabel's "Someone" (no name, or a name that is really a number) reads as a member of the group here.
    return { ...m, sender: !m.mine && m.sender === 'Someone' ? 'Member' : m.sender, source: r.id === src.id };
  });
  const named = await withTagNames(db, c, shown.flatMap((m) => [m.text, m.quote?.text ?? '']), members);
  return {
    client: { code: c.code, name: c.name },
    messages: shown.map((m, i) => ({ ...m, text: named[2 * i]!, quote: m.quote ? { ...m.quote, sender: m.quote.sender === 'Someone' ? 'Member' : m.quote.sender, text: named[2 * i + 1]! } : null })),
  };
}

/** A dashboard message as the chat shows it. */
export async function outboxItem(db: Db, row: OutboxRow): Promise<ChatOutboxItem> {
  return { uuid: row.uuid, at: row.createdAt, text: row.text, state: row.state, quote: row.replyTo === null ? null : await messageQuote(db, row.clientId, row.replyTo) };
}

/**
 * A group member as the group info panel shows it (November release, change 2). The one place Open chat shows a phone
 * number: a member the agent has no name for is shown by the number WhatsApp gives, as WhatsApp's own group info does
 * (owner request, 2 Nov 2026). A hidden number (an @lid member WhatsApp gives no number for) stays hidden, never
 * guessed. No WhatsApp id: `tag` is only the digits a mention uses.
 */
export interface ChatMember {
  name: string | null;
  number: string | null;
  tag: string;
  admin: boolean;
}

/** senderLabel's rule: one line, and never a "name" that is really a number. */
const LOOKS_LIKE_NUMBER = /(?:\d[\s().+-]*){7,}/;

function memberName(name: string | null): string | null {
  const n = oneLine(name, 60);
  return n && !LOOKS_LIKE_NUMBER.test(n) ? n : null;
}

/** A phone-number id as WhatsApp shows the number: "+91 98000 00001" for India, "+<digits>" otherwise. */
export function shownNumber(phoneNumberId: string): string {
  const d = phoneNumberId.split('@')[0]!;
  return d.length === 12 && d.startsWith('91') ? `+91 ${d.slice(2, 7)} ${d.slice(7)}` : `+${d}`;
}

/**
 * The members of this client's group as the panel lists them: admins first, then by name, then by number, then the
 * hidden ones. Each is named from this client's people: by the id the group uses, its phone-number or hidden-number id,
 * or its number. Parameterised reads only, and only this client's rows.
 */
export async function chatMembers(db: Db, c: ClientRow, members: readonly GroupMember[]): Promise<ChatMember[]> {
  const people = await db.all<{ jid: string; number: string | null; name: string | null }>('SELECT jid, number, name FROM people WHERE client_id = ?', [c.id]);
  const out = members.map((m): ChatMember => {
    // A number only for a member the agent has no name for (final review, item 3): least data, and as the owner was told.
    const name = peopleOfMember(m, people).map((p) => memberName(p.name)).find((n) => n !== null) ?? null;
    return { name, number: !name && m.phoneNumber ? shownNumber(m.phoneNumber) : null, tag: tagOf(m.id), admin: m.admin };
  });
  const rank = (x: ChatMember) => (x.admin ? 0 : 3) + (x.name ? 0 : x.number ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b) || (a.name ?? a.number ?? '').localeCompare(b.name ?? b.number ?? '', 'en'));
}
