import type { ClientRow } from '../store/clients.ts';
import type { Db } from '../store/db.ts';
import { outboxToShow, type OutboxRow, type OutboxState } from '../store/outbox.ts';
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
function messageQuote(db: Db, clientId: number, id: number): ChatOutboxItem['quote'] {
  const r = db.raw.prepare(`${SELECT} WHERE m.client_id = ? AND m.id = ?`).get(clientId, id) as RawMessage | undefined;
  if (!r) return null;
  const m = toMessage(r);
  return { sender: m.sender, text: oneLine(m.text, QUOTE_MAX), kind: m.kind };
}

/**
 * A page of the chat: the `limit` messages before the message `before` (by time, then row), newest first, or the newest
 * when `before` is not given; and the dashboard's own messages still to show. Parameterised reads only.
 */
export function chatPage(db: Db, c: ClientRow, now: Date, o: { before?: number; limit?: number } = {}): ChatPage {
  const limit = Math.max(1, Math.min(CHAT_PAGE_MAX, Math.floor(o.limit ?? CHAT_PAGE)));
  let rows: RawMessage[];
  if (o.before !== undefined) {
    const cursor = db.raw.prepare('SELECT ts, id FROM messages WHERE client_id = ? AND id = ?').get(c.id, o.before) as { ts: string; id: number } | undefined;
    rows = cursor
      ? (db.raw.prepare(`${SELECT} WHERE m.client_id = @client AND (m.ts < @ts OR (m.ts = @ts AND m.id < @id)) ORDER BY m.ts DESC, m.id DESC LIMIT @limit`)
        .all({ client: c.id, ts: cursor.ts, id: cursor.id, limit: limit + 1 }) as RawMessage[])
      : [];
  } else {
    rows = db.raw.prepare(`${SELECT} WHERE m.client_id = ? ORDER BY m.ts DESC, m.id DESC LIMIT ?`).all(c.id, limit + 1) as RawMessage[];
  }
  const since = new Date(now.getTime() - OUTBOX_DAYS * 86_400_000).toISOString();
  const outbox = o.before === undefined ? outboxToShow(db, c.id, since).map((row) => outboxItem(db, row)) : [];
  return { messages: rows.slice(0, limit).map(toMessage), hasOlder: rows.length > limit, outbox };
}

/** A dashboard message as the chat shows it. */
export function outboxItem(db: Db, row: OutboxRow): ChatOutboxItem {
  return { uuid: row.uuid, at: row.createdAt, text: row.text, state: row.state, quote: row.replyTo === null ? null : messageQuote(db, row.clientId, row.replyTo) };
}
