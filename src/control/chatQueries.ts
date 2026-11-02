import type { ClientRow } from '../store/clients.ts';
import type { Db } from '../store/db.ts';
import { outboxToShow, type OutboxRow, type OutboxState } from '../store/outbox.ts';
import { mentionTags, tagOf, type GroupMember } from '../wa/groupMembers.ts';
import { messageKind, oneLine, senderLabel, type ClientMessage } from './clientQueries.ts';

// Open chat (owner request, 29 Oct 2026): a client's group as stored, a page at a time, newest first. Least data: a
// message is its row number (the cursor, and what Reply names), time, side, the sender's shown name, text and kind.
// Never a phone number, a WhatsApp id or a JID. Text is untrusted: the browser shows it as text only.

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
   * The agent's name for each tag ("@<digits>") the page's texts hold, when it knows one (November release). The digits
   * are the text's own; no number is added.
   */
  names: Record<string, string>;
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
 * when `before` is not given; and the dashboard's own messages still to show. Parameterised reads only.
 */
export async function chatPage(db: Db, c: ClientRow, now: Date, o: { before?: number; limit?: number } = {}): Promise<ChatPage> {
  const limit = Math.max(1, Math.min(CHAT_PAGE_MAX, Math.floor(o.limit ?? CHAT_PAGE)));
  let rows: RawMessage[];
  if (o.before !== undefined) {
    const cursor = await db.get<{ ts: string; id: number }>('SELECT ts, id FROM messages WHERE client_id = ? AND id = ?', [c.id, o.before]);
    rows = cursor
      ? await db.all<RawMessage>(
        `${SELECT} WHERE m.client_id = @client AND (m.ts < @ts OR (m.ts = @ts AND m.id < @id)) ORDER BY m.ts DESC, m.id DESC LIMIT @limit`,
        { client: c.id, ts: cursor.ts, id: cursor.id, limit: limit + 1 },
      )
      : [];
  } else {
    rows = await db.all<RawMessage>(`${SELECT} WHERE m.client_id = ? ORDER BY m.ts DESC, m.id DESC LIMIT ?`, [c.id, limit + 1]);
  }
  const since = new Date(now.getTime() - OUTBOX_DAYS * 86_400_000).toISOString();
  const outbox: ChatOutboxItem[] = [];
  if (o.before === undefined) for (const row of await outboxToShow(db, c.id, since)) outbox.push(await outboxItem(db, row));
  const messages = rows.slice(0, limit).map(toMessage);
  const texts = [...messages, ...outbox].flatMap((x) => [x.text, x.quote?.text ?? '']);
  return { messages, hasOlder: rows.length > limit, outbox, names: await tagNames(db, c, texts) };
}

/**
 * The names of the tags in some texts: for each "@<digits>", this client's person whose id or number has those digits,
 * named as the chat would name it. Only names the agent knows. Parameterised reads only, and only this client's rows.
 */
async function tagNames(db: Db, c: ClientRow, texts: readonly string[]): Promise<Record<string, string>> {
  const tags = new Set(texts.flatMap((t) => [...mentionTags(t)]));
  const names: Record<string, string> = {};
  if (tags.size === 0) return names;
  const people = await db.all<{ jid: string; number: string | null; name: string | null }>('SELECT jid, number, name FROM people WHERE client_id = ?', [c.id]);
  for (const p of people) {
    const name = memberName(p.name);
    if (!name) continue;
    for (const key of [tagOf(p.jid), p.number]) if (key && tags.has(key) && !Object.hasOwn(names, key)) names[key] = name;
  }
  return names;
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
  const byJid = new Map(people.map((p) => [p.jid, p]));
  const byNumber = new Map(people.filter((p) => p.number).map((p) => [p.number!, p]));
  const out = members.map((m): ChatMember => {
    const digits = m.phoneNumber ? m.phoneNumber.split('@')[0]! : null;
    const p = byJid.get(m.id) ?? (m.phoneNumber ? byJid.get(m.phoneNumber) : undefined) ?? (m.lid ? byJid.get(m.lid) : undefined) ?? (digits ? byNumber.get(digits) : undefined);
    return { name: memberName(p?.name ?? null), number: m.phoneNumber ? shownNumber(m.phoneNumber) : null, tag: tagOf(m.id), admin: m.admin };
  });
  const rank = (x: ChatMember) => (x.admin ? 0 : 3) + (x.name ? 0 : x.number ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b) || (a.name ?? a.number ?? '').localeCompare(b.name ?? b.number ?? '', 'en'));
}
