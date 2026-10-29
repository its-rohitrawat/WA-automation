import { z } from 'zod';
import { PlatformError } from '../../platform/errors.ts';
import {
  cancelInvite, createInvite, INVITES_PER_DAY, linksLeftToday, listInvites, markSending, newLink, recordSend, type InviteView,
} from '../../platform/invites.ts';
import type { InviteMailer, MailOutcome } from '../../platform/mailer.ts';
import type { Sql } from '../../store/engine/types.ts';
import type { Clock } from '../../util/clock.ts';
import type { Logger } from '../../util/logger.ts';
import type { RequestContext } from '../router.ts';
import { fail, ok, type ApiResult, type OwnerContext } from './context.ts';

// The platform API (SaaS S5): the founder's invites, and later the Customers screen. Plain handlers, mounted through the
// dashboard's own read/change registrars (owner guard; for a change also Origin, CSRF and the action limit), so this file
// adds no route of its own until mountRoutes.ts calls mountPlatformRoutes (see the hookups doc). Founder only.
// The invite link (it holds the token) goes only to the founder, in the answer that made it; it is never logged.

export interface PlatformRouteDeps {
  db: Sql;
  clock: Clock;
  log: Logger;
  /** The site's public address, for the link: https://agent.example.com (no trailing slash). */
  publicUrl: string;
  /** The founder's name, for the email. */
  founderName: string;
  /** Whether this signed-in owner is the platform owner (the founder). */
  isFounder: (o: OwnerContext) => boolean;
  /**
   * The founder's Gmail, when connected with gmail.send; null: invites go by Copy link only. Read on every request, so a
   * reconnect with the permission applies at once.
   */
  mailer: () => InviteMailer | null;
}

/** How the dashboard's own registrars look (src/web/mountRoutes.ts). */
export interface PlatformMount {
  read: (path: string, answer: (ctx: RequestContext, o: OwnerContext) => ApiResult | Promise<ApiResult>) => void;
  change: (path: string, answer: (ctx: RequestContext, o: OwnerContext, body: unknown) => ApiResult | Promise<ApiResult>) => void;
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const notFounder = () => fail(403, 'forbidden', 'Only the platform owner can do this.');
const notFound = () => fail(404, 'not_found', 'There is no such invite.');

/** A PlatformError as its answer; anything else goes on to the server's 500. */
async function answer(fn: () => Promise<ApiResult>): Promise<ApiResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PlatformError) return fail(e.status, e.code, e.message);
    throw e;
  }
}

const NewInvite = z.strictObject({ business: z.string().max(200), email: z.string().max(300), send: z.boolean() });

export type EmailResult = MailOutcome['state'] | 'not_connected';

export interface InvitesView {
  invites: InviteView[];
  /** Links the founder can still make today, and the daily limit. */
  left: number;
  perDay: number;
  gmail: { connected: boolean; from: string | null };
}

export function mountPlatformRoutes(m: PlatformMount, d: PlatformRouteDeps): void {
  const link = (token: string) => `${d.publicUrl.replace(/\/+$/, '')}/signup?invite=${token}`;

  const view = async (o: OwnerContext): Promise<InvitesView> => ({
    invites: await listInvites(d), left: await linksLeftToday(d, o.actor), perDay: INVITES_PER_DAY,
    gmail: { connected: d.mailer() !== null, from: d.mailer()?.from ?? null },
  });

  /**
   * Emails a link through the founder's Gmail: 'sending' is written (and audited) first, then the call, then the
   * outcome. Never retried here: an unclear answer is 'unknown'.
   */
  const email = async (o: OwnerContext, invite: InviteView, token: string): Promise<EmailResult> => {
    const mailer = d.mailer();
    if (!mailer) return 'not_connected';
    await markSending(d, o.actor, invite.id, o.requestId);
    d.log.info({ invite: invite.id, requestId: o.requestId }, 'invite email: asking Gmail');
    let outcome: MailOutcome;
    try {
      outcome = await mailer.send({ to: invite.email, business: invite.business, founderName: d.founderName, link: link(token), expiresAt: invite.expiresAt });
    } catch {
      // A sender that throws gave no clear answer. No error text is kept: it can hold the address.
      outcome = { state: 'unknown', code: 'send_error' };
    }
    await recordSend(d, o.actor, invite.id, outcome.state === 'sent' ? { state: 'sent' } : { state: outcome.state, code: outcome.code }, o.requestId);
    d.log.info({ invite: invite.id, outcome: outcome.state, requestId: o.requestId }, 'invite email: done');
    return outcome.state;
  };

  m.read('/dashboard/api/platform/invites', async (_ctx, o) => (d.isFounder(o) ? ok(await view(o)) : notFounder()));

  // A new invite: { business, email, send }. send false is Copy link: the link comes back and nothing is emailed.
  m.change('/dashboard/api/platform/invites', (_ctx, o, body) => answer(async () => {
    if (!d.isFounder(o)) return notFounder();
    const parsed = NewInvite.safeParse(body);
    if (!parsed.success) return fail(400, 'invalid', 'Send the business name, their Gmail address and whether to email it.');
    const made = await createInvite(d, o.actor, parsed.data, o.requestId);
    const sent = parsed.data.send ? await email(o, made.invite, made.token) : 'not_sent';
    return ok({ invite: (await listInvites(d)).find((v) => v.id === made.invite.id), link: link(made.token), email: sent });
  }));

  // Copy link on a row: a new link (the old one stops working), nothing emailed.
  m.change('/dashboard/api/platform/invites/:id/link', ({ params }, o) => answer(async () => {
    if (!d.isFounder(o)) return notFounder();
    if (!ID.test(params.id ?? '')) return notFound();
    const made = await newLink(d, o.actor, params.id!, o.requestId);
    return ok({ invite: made.invite, link: link(made.token) });
  }));

  // Resend (or Send again after it expired): a new link, emailed. Without Gmail it is refused: use Copy link.
  m.change('/dashboard/api/platform/invites/:id/resend', ({ params }, o) => answer(async () => {
    if (!d.isFounder(o)) return notFounder();
    if (!ID.test(params.id ?? '')) return notFound();
    if (!d.mailer()) return fail(409, 'gmail_not_connected', 'Gmail is not connected. Use Copy link and send it yourself.');
    const made = await newLink(d, o.actor, params.id!, o.requestId);
    const sent = await email(o, made.invite, made.token);
    return ok({ invite: (await listInvites(d)).find((v) => v.id === made.invite.id), email: sent });
  }));

  m.change('/dashboard/api/platform/invites/:id/cancel', ({ params }, o) => answer(async () => {
    if (!d.isFounder(o)) return notFounder();
    if (!ID.test(params.id ?? '')) return notFound();
    return ok({ invite: await cancelInvite(d, o.actor, params.id!, o.requestId) });
  }));
}
