import { GROUP_JID } from './groupSend.ts';

// Delete chat (November release, owner decision 2 Nov 2026): the one change the dashboard makes to a chat on the founder's
// WhatsApp. As WhatsApp's own Delete chat does, it removes one approved group's chat from the founder's phone, up to its
// newest message; the group itself, and every message the agent keeps, stay. The owner confirmed it in the dashboard for
// this group; the dashboard's route checked the client and logged the attempt. Here: one delete, for one group the
// founder gateway calls approved and open, once. Nothing here retries. tests/wa/sendScan.test.ts keeps every other
// module from naming the method.

/** The part of a Baileys socket this module uses: deleting one chat, up to its newest message. */
export interface ChatDeleteSocket {
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
  /** Asked, but no clear answer: it may have been done. Never asked again. */
  | { state: 'unknown'; code: 'timeout' | 'delete_error' };

/** How long one delete may take before its outcome is unknown. */
export const DELETE_TIMEOUT_MS = 30_000;

/** The socket as a ChatDeleteSocket, when it has the method; null for a socket that cannot (a test fake). */
export function asChatDeleteSocket(sock: object): ChatDeleteSocket | null {
  return typeof (sock as Partial<ChatDeleteSocket>).chatModify === 'function' ? (sock as ChatDeleteSocket) : null;
}

/** A stored message of this group as the delete names it. The founder's own message names no participant. */
export function lastMessageOf(groupId: string, m: { waId: string; fromMe: boolean; senderJid: string; ts: string }): LastMessage {
  const key: LastMessage['key'] = { remoteJid: groupId, id: m.waId, fromMe: m.fromMe };
  if (!m.fromMe) key.participant = m.senderJid;
  return { key, messageTimestamp: Math.floor(Date.parse(m.ts) / 1000) };
}

/**
 * Deletes one group's chat on the founder's phone. `source` is the founder gateway's check: it gives a socket only for an
 * approved group while open. Failed means nothing was asked; unknown means WhatsApp was asked and did not clearly answer.
 */
export async function deleteGroupChat(
  source: ChatDeleteSocketSource,
  groupId: string,
  last: LastMessage,
  timeoutMs = DELETE_TIMEOUT_MS,
): Promise<DeleteOutcome> {
  if (!GROUP_JID.test(groupId) || last.key.remoteJid !== groupId) return { state: 'failed', code: 'not_a_group' };
  const sock = source(groupId);
  if (!sock) return { state: 'failed', code: 'whatsapp_not_connected' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    const done = await Promise.race([sock.chatModify({ delete: true, lastMessages: [last] }, groupId).then(() => 'done' as const), timeout]);
    return done === 'timeout' ? { state: 'unknown', code: 'timeout' } : { state: 'deleted' };
  } catch {
    // No error text is kept: it can hold the group's id.
    return { state: 'unknown', code: 'delete_error' };
  } finally {
    clearTimeout(timer);
  }
}
