import { randomUUID } from 'node:crypto';
import type { Sql } from '../store/engine/types.ts';
import type { Clock } from '../util/clock.ts';
import { PlatformError } from './errors.ts';
import { addMembership, auditCount, createTenant, platformAudit, setTenantStatus, upsertUser } from './store.ts';
import { INVITE_TTL_MS, inviteTokenHash, newInviteToken, normalizeEmail } from './tokens.ts';

// Invites (SaaS design section 5). The founder invites a business by name and Gmail address: a customer (status invited)
// and an invite are made together. The token goes to the founder once (in the link to send or copy); the database keeps
// only its hash. A link works once, for that email only, for 7 days. Resend and Copy link make a new link (the old one
// stops working). Redeem is one transaction: the invite is used up, the user and the owner membership are made, and the
// customer moves to onboarding. Every change is in platform_audit.

/** Links (new invites, resends, copied links) one founder can make in 24 hours. */
export const INVITES_PER_DAY = 20;
const NAME_MAX = 80;
/** The audit events that make a new link: they count toward the daily limit. */
const LINK_EVENTS = ['invite.created', 'invite.new_link'] as const;

export type SendState = 'none' | 'sending' | 'sent' | 'failed' | 'unknown';

/** An invite as the founder's screen shows it. Never the token or its hash. */
export interface InviteView {
  id: string;
  tenantId: string;
  business: string;
  email: string;
  /** open, accepted, cancelled, or expired (open but past its time). */
  status: 'open' | 'accepted' | 'cancelled' | 'expired';
  send: SendState;
  createdAt: string;
  expiresAt: string;
  sentAt: string | null;
  usedAt: string | null;
}

interface RawInvite {
  id: string;
  tenant_id: string;
  business: string;
  email: string;
  status: 'open' | 'accepted' | 'cancelled';
  send_state: SendState;
  created_at: string;
  expires_at: string;
  sent_at: string | null;
  used_at: string | null;
  created_by: string;
}

const SELECT = 'SELECT i.*, t.name AS business FROM invites i JOIN tenants t ON t.id = i.tenant_id';

function view(r: RawInvite, now: Date): InviteView {
  const expired = r.status === 'open' && Date.parse(r.expires_at) <= now.getTime();
  return {
    id: r.id, tenantId: r.tenant_id, business: r.business, email: r.email, status: expired ? 'expired' : r.status, send: r.send_state,
    createdAt: r.created_at, expiresAt: r.expires_at, sentAt: r.sent_at, usedAt: r.used_at,
  };
}

export interface InviteDeps {
  db: Sql;
  clock: Clock;
}

/** The business name as stored: one line of plain text, 1 to 80 characters. */
function cleanBusiness(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // Control characters, line and paragraph breaks and direction marks (Bidi_Control) become spaces.
  const one = raw.replace(/[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return one.length >= 1 && one.length <= NAME_MAX ? one : null;
}

/** `ka••••@example.com`: enough for the audit log to tell invites apart, never the whole address. */
export function maskAddress(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '••••';
  const local = Array.from(email.slice(0, at));
  return `${local.slice(0, local.length > 3 ? 2 : 1).join('')}••••${email.slice(at)}`;
}

async function checkDailyLimit(q: Sql, actor: string, now: Date): Promise<void> {
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  if ((await auditCount(q, { actor, events: LINK_EVENTS, since })) >= INVITES_PER_DAY) {
    throw new PlatformError(429, 'invite_limit', `At most ${INVITES_PER_DAY} invite links a day. Try again tomorrow.`);
  }
}

/**
 * A new customer (invited) and its invite. Returns the invite and the token, which the caller puts in the link and then
 * forgets. Refused: a bad name or address (400), an open invite for that address already (409), the daily limit (429).
 */
export async function createInvite(d: InviteDeps, actor: string, input: { business: unknown; email: unknown }, requestId?: string): Promise<{ invite: InviteView; token: string }> {
  const business = cleanBusiness(input.business);
  if (!business) throw new PlatformError(400, 'invalid', `Enter the business name (1 to ${NAME_MAX} characters).`);
  const email = normalizeEmail(input.email);
  if (!email) throw new PlatformError(400, 'invalid', 'Enter their Gmail address, like name@example.com.');
  const now = d.clock.now();
  const at = now.toISOString();
  const { token, hash } = newInviteToken();
  const id = await d.db.tx(async (q) => {
    await checkDailyLimit(q, actor, now);
    const open = await q.get<{ id: string }>('SELECT id FROM invites WHERE email = ? AND status = ? AND expires_at > ?', [email, 'open', at]);
    if (open) throw new PlatformError(409, 'already_open', 'That address already has an open invite. Resend it from the list.');
    const tenant = await createTenant(q, { name: business, status: 'invited', at });
    const inviteId = randomUUID();
    await q.run('INSERT INTO invites (id, tenant_id, email, token_hash, status, send_state, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      inviteId, tenant.id, email, hash, 'open', 'none', actor, at, new Date(now.getTime() + INVITE_TTL_MS).toISOString(),
    ]);
    await platformAudit(q, { at, actor, event: 'invite.created', tenantId: tenant.id, detail: `${business} · ${maskAddress(email)}`, requestId: requestId ?? null });
    return inviteId;
  });
  return { invite: (await getInvite(d, id))!, token };
}

export async function getInvite(d: InviteDeps, id: string): Promise<InviteView | undefined> {
  const r = await d.db.get<RawInvite>(`${SELECT} WHERE i.id = ?`, [id]);
  return r ? view(r, d.clock.now()) : undefined;
}

/** Every invite, newest first. */
export async function listInvites(d: InviteDeps): Promise<InviteView[]> {
  const now = d.clock.now();
  return (await d.db.all<RawInvite>(`${SELECT} ORDER BY i.created_at DESC, i.id`)).map((r) => view(r, now));
}

/** How many more links this founder can make today. */
export async function linksLeftToday(d: InviteDeps, actor: string): Promise<number> {
  const since = new Date(d.clock.now().getTime() - 86_400_000).toISOString();
  return Math.max(0, INVITES_PER_DAY - (await auditCount(d.db, { actor, events: LINK_EVENTS, since })));
}

/**
 * A new link for an invite that is not used or cancelled (Resend, Copy link, Send again after it expired): a new token,
 * 7 more days, and the send state back to none. The old link stops working.
 */
export async function newLink(d: InviteDeps, actor: string, id: string, requestId?: string): Promise<{ invite: InviteView; token: string }> {
  const now = d.clock.now();
  const at = now.toISOString();
  const { token, hash } = newInviteToken();
  await d.db.tx(async (q) => {
    const r = await q.get<RawInvite>(`${SELECT} WHERE i.id = ?`, [id]);
    if (!r) throw new PlatformError(404, 'not_found', 'There is no such invite.');
    if (r.status !== 'open') throw new PlatformError(409, 'not_open', r.status === 'accepted' ? 'This invite was already used.' : 'This invite was cancelled.');
    await checkDailyLimit(q, actor, now);
    await q.run("UPDATE invites SET token_hash = ?, expires_at = ?, send_state = 'none', send_code = NULL WHERE id = ? AND status = 'open'", [
      hash, new Date(now.getTime() + INVITE_TTL_MS).toISOString(), id,
    ]);
    await platformAudit(q, { at, actor, event: 'invite.new_link', tenantId: r.tenant_id, detail: `${r.business} · ${maskAddress(r.email)}`, requestId: requestId ?? null });
  });
  return { invite: (await getInvite(d, id))!, token };
}

/** Cancels an open invite: its link stops working. The customer stays, invited, until invited again. */
export async function cancelInvite(d: InviteDeps, actor: string, id: string, requestId?: string): Promise<InviteView> {
  const at = d.clock.now().toISOString();
  await d.db.tx(async (q) => {
    const r = await q.get<RawInvite>(`${SELECT} WHERE i.id = ?`, [id]);
    if (!r) throw new PlatformError(404, 'not_found', 'There is no such invite.');
    if (r.status !== 'open') throw new PlatformError(409, 'not_open', r.status === 'accepted' ? 'This invite was already used.' : 'This invite was already cancelled.');
    await q.run("UPDATE invites SET status = 'cancelled', cancelled_at = ? WHERE id = ? AND status = 'open'", [at, id]);
    await platformAudit(q, { at, actor, event: 'invite.cancelled', tenantId: r.tenant_id, detail: `${r.business} · ${maskAddress(r.email)}`, requestId: requestId ?? null });
  });
  return (await getInvite(d, id))!;
}

/**
 * Records the email send around the Gmail call: 'sending' is written (and audited) BEFORE the call, then the outcome.
 * An outcome that is not clear is 'unknown', and nothing here sends it again.
 */
export async function markSending(d: InviteDeps, actor: string, id: string, requestId?: string): Promise<void> {
  const at = d.clock.now().toISOString();
  await d.db.tx(async (q) => {
    const r = await q.run("UPDATE invites SET send_state = 'sending', send_code = NULL WHERE id = ? AND status = 'open'", [id]);
    if (r.changes !== 1) throw new PlatformError(409, 'not_open', 'This invite is no longer open.');
    const t = await q.get<{ tenant_id: string }>('SELECT tenant_id FROM invites WHERE id = ?', [id]);
    await platformAudit(q, { at, actor, event: 'invite.email_attempt', tenantId: t?.tenant_id ?? null, requestId: requestId ?? null });
  });
}

export async function recordSend(d: InviteDeps, actor: string, id: string, outcome: { state: 'sent' | 'failed' | 'unknown'; code?: string }, requestId?: string): Promise<InviteView> {
  const at = d.clock.now().toISOString();
  await d.db.tx(async (q) => {
    await q.run("UPDATE invites SET send_state = ?, send_code = ?, sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END WHERE id = ? AND send_state = 'sending'", [
      outcome.state, outcome.code ?? null, outcome.state, at, id,
    ]);
    const t = await q.get<{ tenant_id: string }>('SELECT tenant_id FROM invites WHERE id = ?', [id]);
    await platformAudit(q, { at, actor, event: `invite.email_${outcome.state}`, tenantId: t?.tenant_id ?? null, detail: outcome.code ?? '', requestId: requestId ?? null });
  });
  return (await getInvite(d, id))!;
}

/** What the sign-up page shows for a link that works; null for any link that does not (the page says nothing more). */
export async function inviteForSignup(d: InviteDeps, token: unknown): Promise<{ business: string; expiresAt: string } | null> {
  const hash = inviteTokenHash(token);
  if (!hash) return null;
  const r = await d.db.get<RawInvite>(`${SELECT} WHERE i.token_hash = ?`, [hash]);
  if (!r || r.status !== 'open' || Date.parse(r.expires_at) <= d.clock.now().getTime()) return null;
  return { business: r.business, expiresAt: r.expires_at };
}

export type RedeemResult = { ok: true; tenantId: string; userId: string } | { ok: false; reason: 'invalid' | 'wrong_account' };

/**
 * Uses an invite for a Google-verified email. 'invalid' for a link that does not work (unknown, used, cancelled, expired:
 * the caller says only that); 'wrong_account' when the verified email is not the invited one (compared lower-cased).
 * On success, in one transaction: the invite is used up (exactly once, even with two tries at the same moment), the user
 * and the owner membership are made, and the customer moves from invited to onboarding.
 */
export async function redeemInvite(d: InviteDeps, o: { token: unknown; email: string; name?: string | null; requestId?: string }): Promise<RedeemResult> {
  const hash = inviteTokenHash(o.token);
  const email = normalizeEmail(o.email);
  if (!hash || !email) return { ok: false, reason: 'invalid' };
  const now = d.clock.now();
  const at = now.toISOString();
  return d.db.tx(async (q): Promise<RedeemResult> => {
    const r = await q.get<RawInvite>(`${SELECT} WHERE i.token_hash = ?`, [hash]);
    if (!r || r.status !== 'open' || Date.parse(r.expires_at) <= now.getTime()) return { ok: false, reason: 'invalid' };
    if (r.email !== email) {
      await platformAudit(q, { at, actor: maskAddress(email), event: 'signup.wrong_account', tenantId: r.tenant_id, requestId: o.requestId ?? null });
      return { ok: false, reason: 'wrong_account' };
    }
    // Every check that can refuse is above: only now is the invite claimed, before anything else is written. Two redeems
    // at once (Postgres, two connections): the second waits on this row until the first ends, then finds it used and gets
    // what a used link gets. Everything below is in this transaction, so a later step that fails gives the claim back.
    const claimed = await q.run("UPDATE invites SET status = 'accepted', used_at = ? WHERE id = ? AND status = 'open'", [at, r.id]);
    if (claimed.changes !== 1) return { ok: false, reason: 'invalid' };
    const user = await upsertUser(q, { email, name: o.name ?? null, at });
    await q.run('UPDATE invites SET used_by = ? WHERE id = ?', [user.id, r.id]);
    await addMembership(q, { tenantId: r.tenant_id, userId: user.id, role: 'owner', at });
    await setTenantStatus(q, r.tenant_id, ['invited'], 'onboarding', at);
    await q.run('UPDATE tenants SET signed_up_at = COALESCE(signed_up_at, ?), last_activity_at = ? WHERE id = ?', [at, at, r.tenant_id]);
    await platformAudit(q, { at, actor: email, event: 'signup.redeemed', tenantId: r.tenant_id, detail: r.business, requestId: o.requestId ?? null });
    return { ok: true, tenantId: r.tenant_id, userId: user.id };
  });
}
