import { GROUP_JID } from './groupSend.ts';

// Delete chat (November release, owner decision 2 Nov 2026): the one change the dashboard makes to a chat on the founder's
// WhatsApp. As WhatsApp's own Delete chat does, it removes one approved group's chat from the founder's phone, up to its
// newest message; the group itself, and every message the agent keeps, stay. The owner confirmed it in the dashboard for
// this group; the dashboard's route checked the client and logged the attempt. Here: one delete, for one group the
// founder gateway calls approved and open, once. Nothing here retries. tests/wa/sendScan.test.ts keeps every other
// module from naming the method.

/** The part of a Baileys socket this module uses: its own account, and deleting one chat, up to its newest message. */
export interface ChatDeleteSocket {
  /** The account the socket is linked as (Baileys' sock.user): its phone-number id and, when known, its hidden-number id. */
  readonly user?: { id?: string | null; lid?: string | null } | null | undefined;
  chatModify(mod: { delete: true; lastMessages: LastMessage[] }, jid: string): Promise<void>;
}

/** The chat's newest message as WhatsApp needs it for a delete: its key, and its time in whole seconds. */
export interface LastMessage {
  key: { remoteJid: string; id: string; fromMe: boolean; participant?: string };
  messageTimestamp: number;
}

/** The founder gateway's socket for an approved group while WhatsApp is open; null otherwise. */
export type ChatDeleteSocketSource = (groupId: string) => ChatDeleteSocket | null;

export type DeleteOutcome =
  | { state: 'deleted' }
  /** Surely not done: nothing reached WhatsApp. */
  | { state: 'failed'; code: 'not_a_group' | 'whatsapp_not_connected' }
  /**
   * Asked, but no clear answer: it may have been done. check_phone: WhatsApp took it, but the key named the newest
   * message as another phone saw it, or could not be checked against this phone's account.
   */
  | { state: 'unknown'; code: 'timeout' | 'delete_error' | 'check_phone' };

/**
 * The chat's newest stored message as the store keeps it. fromMe and senderJid are as the phone that READ it saw them
 * (the agent's own messages are stored with no sender); samePhone: it was stored since the group's last change of phone.
 */
export interface StoredLast {
  waId: string;
  fromMe: boolean;
  senderJid: string;
  ts: string;
  samePhone: boolean;
}

/** A socket's own account, without device parts. */
export interface OwnIds {
  id: string | null;
  lid: string | null;
}

/** How long one delete may take before its outcome is unknown. */
export const DELETE_TIMEOUT_MS = 30_000;

/** The socket as a ChatDeleteSocket, when it has the method; null for a socket that cannot (a test fake). */
export function asChatDeleteSocket(sock: object): ChatDeleteSocket | null {
  return typeof (sock as Partial<ChatDeleteSocket>).chatModify === 'function' ? (sock as ChatDeleteSocket) : null;
}

/** A person's id: digits, an optional device part (dropped), and a phone-number or hidden-number server. */
const PERSON = /^(\d{5,20})(?::\d{1,3})?@(s\.whatsapp\.net|lid)$/;

/** The id without its device part when it is a person's of that server, else null. */
function person(v: unknown, server: 's.whatsapp.net' | 'lid'): string | null {
  const m = typeof v === 'string' ? PERSON.exec(v) : null;
  return m && m[2] === server ? `${m[1]}@${m[2]}` : null;
}

/** The socket's own account, or null when it gives none (no key can then be checked against it). */
export function ownIdsOf(sock: ChatDeleteSocket): OwnIds | null {
  const id = person(sock.user?.id, 's.whatsapp.net');
  const lid = person(sock.user?.lid, 'lid');
  return id || lid ? { id, lid } : null;
}

/**
 * The delete's key for the newest stored message, as the deleting phone's own account sees it (final review, item 2): a
 * message whose sender is that account is its own (fromMe, no participant). sure: the key matches what that phone has,
 * so a done delete is "deleted"; else WhatsApp is still asked, and the answer is "check the phone". Not sure: the
 * account is unknown; the message was this phone's own but stored by another phone; or it was an own message stored
 * before the group changed phone (then another phone's own).
 */
export function lastMessageFor(groupId: string, m: StoredLast, own: OwnIds | null): { last: LastMessage; sure: boolean } {
  const messageTimestamp = Math.floor(Date.parse(m.ts) / 1000);
  const sender = person(m.senderJid, 's.whatsapp.net') ?? person(m.senderJid, 'lid');
  const ownSender = !m.fromMe && own !== null && sender !== null && (sender === own.id || sender === own.lid);
  if (m.fromMe || ownSender) {
    return { last: { key: { remoteJid: groupId, id: m.waId, fromMe: true }, messageTimestamp }, sure: own !== null && m.fromMe && m.samePhone };
  }
  return { last: { key: { remoteJid: groupId, id: m.waId, fromMe: false, participant: m.senderJid }, messageTimestamp }, sure: own !== null };
}

/**
 * Deletes one group's chat on the group's phone. `source` is the gateways' check: it gives the group's own phone's
 * socket only for an approved group while open. Failed means nothing was asked; unknown means WhatsApp was asked and did
 * not clearly answer, or the key could not be made sure for that phone.
 */
export async function deleteGroupChat(
  source: ChatDeleteSocketSource,
  groupId: string,
  newest: StoredLast,
  timeoutMs = DELETE_TIMEOUT_MS,
): Promise<DeleteOutcome> {
  if (!GROUP_JID.test(groupId)) return { state: 'failed', code: 'not_a_group' };
  const sock = source(groupId);
  if (!sock) return { state: 'failed', code: 'whatsapp_not_connected' };
  const { last, sure } = lastMessageFor(groupId, newest, ownIdsOf(sock));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    const done = await Promise.race([sock.chatModify({ delete: true, lastMessages: [last] }, groupId).then(() => 'done' as const), timeout]);
    if (done === 'timeout') return { state: 'unknown', code: 'timeout' };
    return sure ? { state: 'deleted' } : { state: 'unknown', code: 'check_phone' };
  } catch {
    // No error text is kept: it can hold the group's id.
    return { state: 'unknown', code: 'delete_error' };
  } finally {
    clearTimeout(timer);
  }
}
