import { z } from 'zod';
import { afterMark, chatHidden, chatHiddenKey, chatMembers, chatPage, outboxItem, type ChatHidden, type ChatMember, type ChatOutboxItem, type ChatPage } from '../../control/chatQueries.ts';
import type { GroupDirectory } from '../../control/groups.ts';
import type { ClientConfig } from '../../config/groups.ts';
import { getClientByCode, type ClientRow } from '../../store/clients.ts';
import type { Db } from '../../store/db.ts';
import { deleteKv, setKv } from '../../store/kv.ts';
import { claimedSince, claimOutbox, finishOutbox, lastClaimedAt, markSending, outboxByUuid, type OutboxRow } from '../../store/outbox.ts';
import type { Clock } from '../../util/clock.ts';
import type { Logger } from '../../util/logger.ts';
import { deleteGroupChat, lastMessageOf, type ChatDeleteSocketSource, type DeleteOutcome } from '../../wa/chatDelete.ts';
import { mentionTags, tagOf, type GroupMembersSource } from '../../wa/groupMembers.ts';
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
  /** WhatsApp is connected for this group: its own phone is open (more phones, November release, lane C). */
  connected: (groupId: string) => boolean;
  /** The founder gateway's socket for an approved group while open (gateway.groupSocket). */
  groupSocket: GroupSocketSource;
  /** The founder gateway's members of an approved group while open (gateway.groupMembers); not wired: none known. */
  groupMembers?: GroupMembersSource;
  /** The socket for Delete chat, for an approved group while open (gateway.chatDeleteSocket); not wired: no delete. */
  chatDeleteSocket?: ChatDeleteSocketSource;
  /** Only its last list is read, for the group's name. */
  directory: Pick<GroupDirectory, 'cachedGroups'>;
  audit: AuditFn;
  log: Logger;
  clock: Clock;
  /** Tests only: how long one send may take. */
  sendTimeoutMs?: number;
  /** Tests only: how long one delete may take. */
  deleteTimeoutMs?: number;
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
  return ok({ client: { code: c.code, name: c.name, groupName: groupNameOf(deps, c) }, sendingOn: deps.sendingOn(), connected: deps.connected(c.groupId), ...page });
}

/** The group's name as WhatsApp last listed it, else the client's own name. */
const groupNameOf = (deps: ChatDeps, c: ClientRow) => (deps.directory.cachedGroups() ?? []).find((g) => g.id === c.groupId)?.subject || c.name;

export type MembersView =
  | { known: true; groupName: string; members: ChatMember[] }
  | { known: false; groupName: string; reason: 'whatsapp_not_connected' | 'members_unavailable'; members: [] };

/**
 * GET /dashboard/api/clients/:code/chat/members: the group info panel (November release, change 2). Only an approved
 * client of this workspace (its own database), and only that client's group is asked about: one read of WhatsApp's group
 * data through the founder gateway, kept 5 minutes there. Not connected: nothing is asked.
 */
export async function chatMembersHandler(deps: ChatDeps, _ctx: OwnerContext, code: string): Promise<ApiResult<MembersView | ApiError>> {
  const c = await approvedClient(deps, code);
  if (!c) return notFound();
  const groupName = groupNameOf(deps, c);
  if (!deps.connected(c.groupId)) return ok({ known: false, groupName, reason: 'whatsapp_not_connected', members: [] });
  const found = deps.groupMembers ? await deps.groupMembers(c.groupId) : null;
  if (!found) return ok({ known: false, groupName, reason: 'members_unavailable', members: [] });
  return ok({ known: true, groupName, members: await chatMembers(deps.db, c, found) });
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

  // Tags (November release): "@<digits>" in the confirmed text names a member, and the message tags exactly the group's
  // members named so. The members can't be read: refused here, before anything is claimed, so nothing goes untagged.
  let mentions: string[] = [];
  const tags = mentionTags(text);
  if (tags.size > 0) {
    const members = deps.connected(c.groupId) && deps.groupMembers ? await deps.groupMembers(c.groupId) : null;
    if (!members) {
      return fail(409, 'mentions_unavailable', "The group's members can't be read from WhatsApp right now, so the tags can't be checked. Nothing was sent. Try again in a minute.");
    }
    mentions = members.filter((m) => tags.has(tagOf(m.id))).map((m) => m.id);
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
  deps.log.info({ client: c.code, outbox: claim.row.id, chars: text.length, tagged: mentions.length, requestId: ctx.requestId }, 'dashboard send: asking WhatsApp');
  const outcome = await sendGroupText(deps.groupSocket, c.groupId, text, quoted, deps.sendTimeoutMs, mentions);
  const done = await finishOutbox(deps.db, claim.row.id, {
    state: outcome.state, waId: outcome.state === 'sent' ? outcome.waId : null, errorCode: outcome.state === 'sent' ? null : outcome.code,
    at: deps.clock.now().toISOString(),
  });
  deps.log.info({ client: c.code, outbox: claim.row.id, outcome: outcome.state, code: outcome.state === 'sent' ? null : outcome.code, requestId: ctx.requestId }, 'dashboard send: done');
  try {
    await deps.audit({
      actor: ctx.actor, kind: 'ops', requestId: ctx.requestId,
      event: `Message ${OUTCOME_WORDS[outcome.state]} · ${c.name} (${c.code})`,
      detail: `${text.length} characters${replyTo !== null ? ', a reply' : ''}${mentions.length > 0 ? `, ${mentions.length} tagged` : ''}${outcome.state === 'sent' ? '' : ` · ${outcome.code}`}`,
    });
  } catch (e) {
    deps.log.warn({ code: (e as Error | null)?.name ?? 'Error', requestId: ctx.requestId }, 'audit line for a dashboard send could not be written');
  }
  return ok({ message: await outboxItem(deps.db, done), replayed: false });
}

const DeleteBody = z.strictObject({
  // The dashboard sends true only from the confirm dialog's Delete chat button.
  confirm: z.literal(true, { message: 'must be confirmed in the dialog' }),
});

/** At least this long between two deletes of the same chat: a guard against a double tap, not a quota. */
export const DELETE_GAP_MS = 60_000;
/** A delete still marked "asking" after this long never finished (the service stopped mid-way): its outcome is unknown. */
const ASKING_MAX_MS = 90_000;

export type DeleteView = { state: DeleteOutcome['state']; code: string | null };

const DELETE_WORDS: Record<DeleteOutcome['state'], { event: string; detail: (code: string | null) => string }> = {
  deleted: { event: 'Chat deleted', detail: () => 'on the phone and here; the saved messages stay' },
  unknown: { event: 'Chat delete may not have reached the phone', detail: (code) => `hidden here · ${code ?? 'unknown'}` },
  failed: { event: 'Chat not deleted', detail: (code) => code ?? 'failed' },
};

/**
 * POST /dashboard/api/clients/:code/chat/delete with { confirm: true } (November release, owner decision 2 Nov 2026):
 * deletes the chat on the founder's phone's WhatsApp, up to its newest stored message, and hides it here until a new
 * message comes. The saved messages and tasks stay, and the group stays approved. Not gated on the sending switch: it
 * changes only the owner's own phone. The order, as for a send: the checks, the claim (the mark, written "asking"), the
 * log line, WhatsApp, the outcome, the audit (never a message's text). 200 with the outcome (a repeat with nothing new:
 * the earlier one's, and WhatsApp is not asked again); 400 not confirmed; 404 not an approved client; 409 nothing to
 * delete, a delete in progress, or Delete not wired in; 429 again within a minute.
 */
export async function chatDeleteHandler(deps: ChatDeps, ctx: OwnerContext, code: string, body: unknown): Promise<ApiResult<DeleteView | ApiError>> {
  const parsed = DeleteBody.safeParse(body);
  if (!parsed.success) {
    return parsed.error.issues.some((i) => i.code === 'unrecognized_keys')
      ? fail(400, 'invalid', 'The request has a field that is not allowed.')
      : fail(400, 'not_confirmed', 'Confirm in the dialog before the chat is deleted.');
  }
  const c = await approvedClient(deps, code);
  if (!c) return notFound();
  const source = deps.chatDeleteSocket;
  if (!source) return fail(409, 'delete_unavailable', 'Delete chat is not available here yet.');
  const newest = await deps.db.get<{ id: number; waId: string; fromMe: number; senderJid: string; ts: string }>(
    'SELECT id, wa_id AS waId, from_me AS fromMe, sender_jid AS senderJid, ts FROM messages WHERE client_id = ? ORDER BY ts DESC, id DESC LIMIT 1',
    [c.id],
  );
  if (!newest) return fail(409, 'nothing_to_delete', 'There are no messages in this chat to delete.');

  // The claim in one write transaction (on Postgres, under the customer's lock): two requests at once cannot both ask.
  const now = deps.clock.now();
  const key = chatHiddenKey(c.id);
  const claim = await deps.db.tx(async (tx): Promise<{ mark: ChatHidden; before: ChatHidden | null } | { done: ApiResult<DeleteView | ApiError> }> => {
    const before = await chatHidden(tx, c.id);
    if (before && !afterMark(newest, before)) {
      // Nothing new since the last delete: its outcome again, and WhatsApp is not asked.
      if (before.state === 'asking' && now.getTime() - Date.parse(before.at) < ASKING_MAX_MS) {
        return { done: fail(409, 'delete_in_progress', 'This chat is being deleted. Wait a moment.') };
      }
      return { done: ok(before.state === 'deleted' ? { state: 'deleted', code: null } : { state: 'unknown', code: before.state === 'asking' ? 'timeout' : before.code }) };
    }
    if (before && now.getTime() - Date.parse(before.at) < DELETE_GAP_MS) {
      return { done: fail(429, 'rate_limited', 'This chat was deleted a moment ago. Try again in a minute.', { retryAfterSec: 60 }) };
    }
    const mark: ChatHidden = { uptoTs: newest.ts, uptoId: newest.id, at: now.toISOString(), state: 'asking', code: null };
    await setKv(tx, key, JSON.stringify(mark));
    return { mark, before };
  });
  if ('done' in claim) return claim.done;

  // Logged before WhatsApp is asked: a crash mid-way leaves the mark "asking" (unknown later), and this line.
  deps.log.info({ client: c.code, requestId: ctx.requestId }, 'dashboard delete: asking WhatsApp');
  const last = lastMessageOf(c.groupId, { waId: newest.waId, fromMe: newest.fromMe === 1, senderJid: newest.senderJid, ts: newest.ts });
  const outcome = await deleteGroupChat(source, c.groupId, last, deps.deleteTimeoutMs);
  const codeOf = outcome.state === 'deleted' ? null : outcome.code;
  if (outcome.state === 'failed') {
    // Surely not done: the chat shows as it was before this request.
    if (claim.before) await setKv(deps.db, key, JSON.stringify(claim.before));
    else await deleteKv(deps.db, key);
  } else {
    await setKv(deps.db, key, JSON.stringify({ ...claim.mark, state: outcome.state, code: codeOf }));
  }
  deps.log.info({ client: c.code, outcome: outcome.state, code: codeOf, requestId: ctx.requestId }, 'dashboard delete: done');
  try {
    const words = DELETE_WORDS[outcome.state];
    await deps.audit({ actor: ctx.actor, kind: 'ops', requestId: ctx.requestId, event: `${words.event} · ${c.name} (${c.code})`, detail: words.detail(codeOf) });
  } catch (e) {
    deps.log.warn({ code: (e as Error | null)?.name ?? 'Error', requestId: ctx.requestId }, 'audit line for a dashboard delete could not be written');
  }
  return ok({ state: outcome.state, code: codeOf });
}
