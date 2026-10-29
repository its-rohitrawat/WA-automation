// The one place a message leaves on the founder's WhatsApp (Open chat, owner request 29 Oct 2026). The owner confirmed
// this exact text for this group in the dashboard; the dashboard's route checked the setting, the client and the limits,
// and claimed the outbox row. Here: one text message, to one group the founder gateway calls approved and open, once.
// Nothing here retries. tests/wa/sendScan.test.ts keeps every other module from naming a send method.

/** The part of a Baileys socket this module uses: one text message to a group, optionally quoting one. */
export interface GroupSendSocket {
  sendMessage(jid: string, content: { text: string }, options?: { quoted: QuotedMessage }): Promise<{ key?: { id?: string | null } | null } | undefined>;
}

/** A quoted message as WhatsApp needs it: the original's key and its text. */
export interface QuotedMessage {
  key: { remoteJid: string; id: string; fromMe: boolean; participant?: string };
  message: { conversation: string };
}

/** The founder gateway's socket for an approved group while WhatsApp is open; null otherwise. */
export type GroupSocketSource = (groupId: string) => GroupSendSocket | null;

export type SendOutcome =
  | { state: 'sent'; waId: string }
  /** Surely not sent: nothing reached WhatsApp. */
  | { state: 'failed'; code: 'not_a_group' | 'whatsapp_not_connected' }
  /** Asked, but no clear answer: it may have gone. Never sent again. */
  | { state: 'unknown'; code: 'timeout' | 'send_error' | 'no_message_id' };

/** A group's id: digits, an optional "-digits" (old groups), then @g.us. Nothing else is ever sent to. */
export const GROUP_JID = /^\d{6,20}(-\d{6,20})?@g\.us$/;

/** How long one send may take before its outcome is unknown. */
export const SEND_TIMEOUT_MS = 30_000;

/** The socket as a GroupSendSocket, when it has the method; null for a socket that cannot send (a test fake). */
export function asGroupSendSocket(sock: object): GroupSendSocket | null {
  return typeof (sock as Partial<GroupSendSocket>).sendMessage === 'function' ? (sock as GroupSendSocket) : null;
}

/**
 * Sends one text to one group. `source` is the founder gateway's check: it gives a socket only for an approved group while
 * open. Failed means nothing was sent; unknown means WhatsApp was asked and did not clearly answer.
 */
export async function sendGroupText(
  source: GroupSocketSource,
  groupId: string,
  text: string,
  quoted: QuotedMessage | null,
  timeoutMs = SEND_TIMEOUT_MS,
): Promise<SendOutcome> {
  if (!GROUP_JID.test(groupId)) return { state: 'failed', code: 'not_a_group' };
  const sock = source(groupId);
  if (!sock) return { state: 'failed', code: 'whatsapp_not_connected' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    const sent = await Promise.race([sock.sendMessage(groupId, { text }, quoted ? { quoted } : undefined), timeout]);
    if (sent === 'timeout') return { state: 'unknown', code: 'timeout' };
    const id = sent?.key?.id;
    return typeof id === 'string' && id !== '' ? { state: 'sent', waId: id } : { state: 'unknown', code: 'no_message_id' };
  } catch {
    // No error text is kept: it can hold the group's id or the message.
    return { state: 'unknown', code: 'send_error' };
  } finally {
    clearTimeout(timer);
  }
}
