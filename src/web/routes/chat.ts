import { z } from 'zod';
import { chatPage, outboxItem, type ChatOutboxItem, type ChatPage } from '../../control/chatQueries.ts';
import type { GroupDirectory } from '../../control/groups.ts';
import type { ClientConfig } from '../../config/groups.ts';
import { getClientByCode, type ClientRow } from '../../store/clients.ts';
import type { Db } from '../../store/db.ts';
import { claimedSince, claimOutbox, finishOutbox, lastClaimedAt, markSending, outboxByUuid, type OutboxRow } from '../../store/outbox.ts';
import type { Clock } from '../../util/clock.ts';
import type { Logger } from '../../util/logger.ts';
import { sendGroupText, type GroupSocketSource, type QuotedMessage, type SendOutcome } from '../../wa/groupSend.ts';
import { fail, ok, type ApiError, type ApiResult, type AuditFn, type OwnerContext } from './context.ts';

// Open chat (owner request, 29 Oct 2026). Reading: a client's stored messages, a page at a time (control/chatQueries.ts).
// Sending: the one deliberate exception to "the agent never sends from the founder's WhatsApp". It goes out only when
// the owner switched sending on in Settings, confirmed this exact text in the dialog, and the client is approved; the
// browser names the client by its code, never a group id; at most one message every 3 seconds to a group and 30 an
// hour in all. The browser's uuid makes a repeated request find the first one instead of sending again. The order is
// fixed: claim the row, write "sending" and log the attempt, ask WhatsApp, record the outcome, audit (no text).

export interface ChatDeps {
  db: Db;
  /** The approved groups (allowed-groups.json as the agent runs it). */
  configs: () => ClientConfig[];
  /** "Allow sending from the dashboard" (Settings), off by default. */
  sendingOn: () => boolean;
  /** WhatsApp is connected (the founder gateway is open). */
  connected: () => boolean;
  /** The founder gateway's socket for an approved group while open (gateway.groupSocket). */
  groupSocket: GroupSocketSource;
  /** Only its last list is read, for the group's name. */
  directory: Pick<GroupDirectory, 'cachedGroups'>;
  audit: AuditFn;
  log: Logger;
  clock: Clock;
  /** Tests only: how long one send may take. */
  sendTimeoutMs?: number;
}

export const SEND_TEXT_MAX = 4096;
/** At least this long between two messages to the same group. */
export const SEND_GAP_MS = 3_000;
/** At most this many messages an hour, to every group together. */
export const SEND_HOURLY_MAX = 30;
const CODE = /^[A-Z]{3,4}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The approved, active client with this code, or null. */
async function approvedClient(deps: ChatDeps, code: string): Promise<ClientRow | null> {
  if (typeof code !== 'string' || !CODE.test(code)) return null;
  const c = await getClientByCode(deps.db, code);
  if (!c || !c.active) return null;
  return deps.configs().some((x) => x.groupId === c.groupId && x.code === c.code) ? c : null;
}

const notFound = () => fail(404, 'not_found', 'There is no approved client with this code.');

export type ChatView = ChatPage & {
  client: { code: string; name: string; groupName: string };
  /** Sending is switched on in Settings. */
  sendingOn: boolean;
  connected: boolean;
};

/** GET /dashboard/api/clients/:code/chat?before=<message>&limit=<1..100> */
export async function chatReadHandler(deps: ChatDeps, _ctx: OwnerContext, code: string, search: { before?: string | null; limit?: string | null }): Promise<ApiResult<ChatView | ApiError>> {
  const c = await approvedClient(deps, code);
  if (!c) return notFound();
  const whole = (v: string | null | undefined) => (v && /^\d{1,9}$/.test(v) ? Number(v) : undefined);
  if ((search.before && whole(search.before) === undefined) || (search.limit && whole(search.limit) === undefined)) {
    return fail(400, 'invalid', 'before and limit must be whole numbers.');
  }
  const before = whole(search.before);
  const limit = whole(search.limit);
  const page = await chatPage(deps.db, c, deps.clock.now(), { ...(before !== undefined ? { before } : {}), ...(limit !== undefined ? { limit } : {}) });
  const groupName = (deps.directory.cachedGroups() ?? []).find((g) => g.id === c.groupId)?.subject || c.name;
  return ok({ client: { code: c.code, name: c.name, groupName }, sendingOn: deps.sendingOn(), connected: deps.connected(), ...page });
}

const SendBody = z.strictObject({
  uuid: z.string().regex(UUID, 'must be a message id made by the dashboard'),
  text: z
    .string()
    .max(SEND_TEXT_MAX, `must be at most ${SEND_TEXT_MAX} characters`)
    .refine((t) => t.trim().length > 0, 'must not be empty'),
  replyTo: z.number().int().positive().nullable().optional(),
  // The dashboard sends true only from the confirm dialog's Send button.
  confirm: z.literal(true, { message: 'must be confirmed in the dialog' }),
});

/** The first problem, by field. Never the value; an unknown field is not named either (it is the sender's text). */
function problem(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'The message is not valid.';
  if (issue.code === 'unrecognized_keys') return 'The message has a field that is not allowed.';
  const where = issue.path.map(String).join('.');
  return `The message is not valid: ${where === '' ? '' : `${where} `}${issue.message}.`;
}

const OUTCOME_WORDS: Record<SendOutcome['state'], string> = { sent: 'sent', failed: 'not sent', unknown: 'may have been sent (check WhatsApp)' };

export type SendView = { message: ChatOutboxItem; replayed: boolean };

/**
 * POST /dashboard/api/clients/:code/chat/send with { uuid, text, replyTo?, confirm: true }. 200 with the message's state
 * (sent, failed, unknown; or claimed/sending for a repeat of one still in flight); 400 a bad body; 404 not an approved
 * client; 409 sending switched off, or the uuid used for another message; 429 too soon or too many.
 */
export async function chatSendHandler(deps: ChatDeps, ctx: OwnerContext, code: string, body: unknown): Promise<ApiResult<SendView | ApiError>> {
  const parsed = SendBody.safeParse(body);
  if (!parsed.success) {
    const confirmMissing = parsed.error.issues.some((i) => i.path[0] === 'confirm');
    return confirmMissing ? fail(400, 'not_confirmed', 'Confirm the message before it is sent.') : fail(400, 'invalid', problem(parsed.error));
  }
  if (!deps.sendingOn()) return fail(409, 'sending_off', 'Sending from the dashboard is switched off. Switch it on in Settings first.');
  const c = await approvedClient(deps, code);
  if (!c) return notFound();
  const { uuid, text } = parsed.data;
  const replyTo = parsed.data.replyTo ?? null;

  // The same uuid again: the first request's message, never a second send.
  const replay = async (row: OutboxRow): Promise<ApiResult<SendView | ApiError>> =>
    row.clientId === c.id && row.text === text && row.replyTo === replyTo
      ? ok({ message: await outboxItem(deps.db, row), replayed: true })
      : fail(409, 'uuid_reused', 'This message id was already used for another message. Write the message again.');
  const earlier = await outboxByUuid(deps.db, uuid);
  if (earlier) return await replay(earlier);

  let quoted: QuotedMessage | null = null;
  if (replyTo !== null) {
    const q = await deps.db.get<{ waId: string; senderJid: string; fromMe: number; text: string | null }>(
      'SELECT wa_id AS waId, sender_jid AS senderJid, from_me AS fromMe, text FROM messages WHERE id = ? AND client_id = ? AND revoked = 0',
      [replyTo, c.id],
    );
    if (!q) return fail(400, 'invalid', 'The message you are replying to is not in this chat.');
    quoted = { key: { remoteJid: c.groupId, id: q.waId, fromMe: q.fromMe === 1, participant: q.senderJid }, message: { conversation: q.text ?? '' } };
  }

  // The limits and the claim in one write transaction: two requests at once cannot both pass.
  const now = deps.clock.now();
  const claim = await deps.db.tx(async (tx): Promise<{ row: OutboxRow } | { limited: ApiResult<ApiError> } | { taken: OutboxRow }> => {
    const again = await outboxByUuid(tx, uuid);
    if (again) return { taken: again };
    const last = await lastClaimedAt(tx, c.id);
    const gap = last === null ? Infinity : now.getTime() - Date.parse(last);
    if (gap < SEND_GAP_MS) {
      return { limited: fail(429, 'rate_limited', 'Wait a few seconds between messages to the same group.', { retryAfterSec: Math.ceil((SEND_GAP_MS - gap) / 1000) }) };
    }
    if ((await claimedSince(tx, new Date(now.getTime() - 3_600_000).toISOString())) >= SEND_HOURLY_MAX) {
      return { limited: fail(429, 'rate_limited', `At most ${SEND_HOURLY_MAX} messages an hour can be sent from the dashboard. Try again later.`, { retryAfterSec: 600 }) };
    }
    return { row: await claimOutbox(tx, { uuid, clientId: c.id, text, replyTo, actor: ctx.actor, at: now.toISOString() }) };
  });
  if ('taken' in claim) return await replay(claim.taken);
  if ('limited' in claim) return claim.limited;

  // Logged before WhatsApp is asked: a crash mid-send leaves the row "sending" (unknown at the next start), and this line.
  await markSending(deps.db, claim.row.id, deps.clock.now().toISOString());
  deps.log.info({ client: c.code, outbox: claim.row.id, chars: text.length, requestId: ctx.requestId }, 'dashboard send: asking WhatsApp');
  const outcome = await sendGroupText(deps.groupSocket, c.groupId, text, quoted, deps.sendTimeoutMs);
  const done = await finishOutbox(deps.db, claim.row.id, {
    state: outcome.state, waId: outcome.state === 'sent' ? outcome.waId : null, errorCode: outcome.state === 'sent' ? null : outcome.code,
    at: deps.clock.now().toISOString(),
  });
  deps.log.info({ client: c.code, outbox: claim.row.id, outcome: outcome.state, code: outcome.state === 'sent' ? null : outcome.code, requestId: ctx.requestId }, 'dashboard send: done');
  try {
    deps.audit({
      actor: ctx.actor, kind: 'ops', requestId: ctx.requestId,
      event: `Message ${OUTCOME_WORDS[outcome.state]} · ${c.name} (${c.code})`,
      detail: `${text.length} characters${replyTo !== null ? ', a reply' : ''}${outcome.state === 'sent' ? '' : ` · ${outcome.code}`}`,
    });
  } catch (e) {
    deps.log.warn({ code: (e as Error | null)?.name ?? 'Error', requestId: ctx.requestId }, 'audit line for a dashboard send could not be written');
  }
  return ok({ message: await outboxItem(deps.db, done), replayed: false });
}
