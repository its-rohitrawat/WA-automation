import { z } from 'zod';
import { SPARE_LINK_MESSAGES } from '../../report/senderLink.ts';
import { ControlError } from '../../control/errors.ts';
import { MAX_PHONES, phoneIdOf, type PhoneId } from '../../wa/authState.ts';
import type { UnlinkResult } from '../../wa/phoneControl.ts';
import type { PhoneEntry } from '../../wa/phoneList.ts';
import { LinkBusyError, type LinkEvent, type LinkSessions, type LinkState, type LinkTarget } from '../../wa/linkSession.ts';
import { jsonText } from '../http.ts';
import { renderQrSvg } from '../qrSvg.ts';
import { fail, ok, type ApiError, type ApiResult, type OwnerContext } from './context.ts';

// The dashboard's WhatsApp link API (D3 task 8), unmounted: start a link (the founder's phone or the spare phone),
// cancel it, and follow it over server-sent events. Only the owner session that started a link can see its QR codes or
// cancel it. A QR goes out only as an SVG image; it is never logged, audited or kept after the link ends (LinkSessions
// keeps the latest one in memory while the link runs).

const StartBody = z.object({ target: z.enum(['founder', 'phone2', 'phone3', 'phone4', 'phone5', 'spare']), confirm: z.literal(true) }).strict();
const CancelBody = z.object({ linkId: z.string().regex(/^[0-9a-f]{32}$/) }).strict();

/** What the dashboard shows for each state of a link. */
export const STATE_LABELS: Record<LinkState, string> = {
  idle: 'Ready',
  confirming: 'Confirm to continue',
  waiting_qr: 'Getting a code from WhatsApp…',
  qr: 'Scan the code with the phone',
  opening: 'Scanned. Linking…',
  linked: 'Linked',
  cancelled: 'Cancelled',
  timed_out: 'The code was not scanned in time',
  failed: 'The link did not work',
};

const FOUNDER_MESSAGES: Record<string, string> = {
  cancelled: "Cancelled. The founder's phone is linked as before.",
  timed_out: "The code was not scanned within 5 minutes. The founder's phone is linked as before.",
  stopped: "The agent was stopped during the link. The founder's phone is linked as before.",
  logged_out: "WhatsApp refused the link. The founder's phone is linked as before. Try again.",
  forbidden: "WhatsApp refused this number (403). The founder's phone is linked as before. Check the phone for a WhatsApp warning.",
  replaced: "Another session took over during the link. The founder's phone is linked as before. Close it, then try again.",
  error: "Something went wrong while linking. The founder's phone is linked as before. Try again.",
  number_in_use: "This number is already linked as another of your phones. The founder's phone is linked as before. Scan with a different phone.",
  phone_busy: "The founder's phone is being unlinked right now. Try again in a moment.",
};

/** Phones 2 to 5 (lane C): the founder's messages, about that phone. */
function phoneMessage(n: number, code: string): string {
  const as = `Phone ${n} is as it was before.`;
  const m: Record<string, string> = {
    cancelled: `Cancelled. ${as}`,
    timed_out: `The code was not scanned within 5 minutes. ${as}`,
    stopped: `The agent was stopped during the link. ${as}`,
    logged_out: `WhatsApp refused the link. ${as} Try again.`,
    forbidden: `WhatsApp refused this number (403). ${as} Check the phone for a WhatsApp warning.`,
    replaced: `Another session took over during the link. ${as} Close it, then try again.`,
    number_in_use: `This number is already linked as another of your phones. ${as} Scan with a different phone.`,
    phone_busy: `Phone ${n} is being unlinked or removed right now. Try again in a moment.`,
  };
  return m[code] ?? `Something went wrong while linking. ${as} Try again.`;
}

const SPARE_EXTRA: Record<string, string> = {
  cancelled: 'Cancelled. The spare phone is linked as before.',
  timed_out: 'The code was not scanned within 5 minutes. The spare phone is linked as before.',
  stopped: 'The agent was stopped during the link. The spare phone is linked as before.',
};

/** The plain message for a link that ended without a link. */
export function linkErrorMessage(target: LinkTarget, code: string): string {
  if (target === 'founder') return FOUNDER_MESSAGES[code] ?? FOUNDER_MESSAGES.error!;
  if (target !== 'spare') return phoneMessage(phoneIdOf(target), code);
  return SPARE_EXTRA[code] ?? SPARE_LINK_MESSAGES[code] ?? SPARE_LINK_MESSAGES.error!;
}

/** What the stream writes to: node's ServerResponse has all of it. */
export interface SseSink {
  setHeader(name: string, value: string): unknown;
  write(chunk: string): unknown;
  end(): unknown;
  on(event: 'close', listener: () => void): unknown;
  flushHeaders?(): void;
  /** True once the connection is gone (ServerResponse has it). */
  readonly destroyed?: boolean;
}

const HEARTBEAT_MS = 15_000;

export class WhatsAppLinkRoutes {
  readonly #sessions: LinkSessions;
  readonly #heartbeatMs: number;
  /** Link id → the owner session that started it. */
  readonly #owners = new Map<string, string>();
  readonly #targets = new Map<string, LinkTarget>();

  constructor(o: { sessions: LinkSessions; heartbeatMs?: number }) {
    this.#sessions = o.sessions;
    this.#heartbeatMs = o.heartbeatMs ?? HEARTBEAT_MS;
  }

  /** POST /dashboard/api/whatsapp/link/start, body { target, confirm: true }. LinkSessions audits the outcome. */
  start(ctx: OwnerContext, body: unknown): ApiResult<{ linkId: string } | ApiError> {
    const parsed = StartBody.safeParse(body);
    if (!parsed.success) return fail(400, 'invalid', 'Choose the phone to link, and confirm.');
    const { target } = parsed.data;
    // Phones 2 to 5 exist only once added (the phone list): one not added has no link.
    if (target !== 'founder' && target !== 'spare' && !this.#sessions.has(target)) {
      return fail(404, 'no_such_phone', `There is no Phone ${phoneIdOf(target)} yet. Add it first.`);
    }
    try {
      const link = this.#sessions.start({ target: parsed.data.target, actor: ctx.actor });
      // Only the newest link is kept: LinkSessions holds one at a time.
      this.#owners.clear();
      this.#targets.clear();
      this.#owners.set(link.id, ctx.sessionId);
      this.#targets.set(link.id, link.target);
      return ok({ linkId: link.id });
    } catch (e) {
      if (e instanceof LinkBusyError) return fail(409, 'link_in_progress', 'Another phone is being linked. Finish or cancel that link first.');
      return fail(503, 'unavailable', 'Linking this phone is not available right now.');
    }
  }

  /** POST /dashboard/api/whatsapp/link/cancel, body { linkId }. The driver restores what the link changed. */
  cancel(ctx: OwnerContext, body: unknown): ApiResult<{ cancelled: boolean } | ApiError> {
    const parsed = CancelBody.safeParse(body);
    if (!parsed.success) return fail(400, 'invalid', 'Unknown link.');
    const owner = this.#owners.get(parsed.data.linkId);
    if (owner === undefined) return fail(404, 'not_found', 'Unknown link.');
    if (owner !== ctx.sessionId) return fail(403, 'forbidden', 'This link was started from another browser.');
    return ok({ cancelled: this.#sessions.cancel(parsed.data.linkId) });
  }

  /**
   * GET /dashboard/api/whatsapp/link/stream?id=. Returns an error result (sent as JSON by the caller) without writing to
   * `res` when the link is unknown or another session's. Otherwise it streams, and resolves when the stream closes:
   * after done or error, or when the browser goes away (the link itself goes on; it can be cancelled or watched again).
   */
  stream(ctx: OwnerContext, id: string, res: SseSink): ApiResult<ApiError> | Promise<void> {
    const owner = this.#owners.get(id);
    if (owner === undefined) return fail(404, 'not_found', 'Unknown link.');
    if (owner !== ctx.sessionId) return fail(403, 'forbidden', 'This link was started from another browser.');
    const target = this.#targets.get(id)!;
    return new Promise<void>((resolve) => {
      let closed = false;
      let unsubscribe: (() => void) | undefined;
      let timer: ReturnType<typeof setInterval> | undefined;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        unsubscribe?.();
        try {
          res.end();
        } catch {
          // the browser already went away
        }
        resolve();
      };
      const send = (event: string, data: unknown) => {
        if (!closed) res.write(`event: ${event}\ndata: ${jsonText(data)}\n\n`);
      };
      // 'close' first: a browser that left before this point is noticed, not kept for the rest of the link.
      res.on('close', close);
      if (res.destroyed) {
        close();
        return;
      }
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();
      timer = setInterval(() => {
        if (!closed) res.write(': ping\n\n');
      }, this.#heartbeatMs);
      const onEvent = (e: LinkEvent) => {
        if (closed) return;
        if (e.type === 'qr') send('qr', { svg: renderQrSvg(e.qr) });
        else if (e.type === 'state') send('state', { state: e.state, label: STATE_LABELS[e.state] });
        else if (e.type === 'done') {
          send('done', { device: e.device });
          close();
        } else {
          send('error', { code: e.code, message: linkErrorMessage(target, e.code) });
          close();
        }
      };
      unsubscribe = this.#sessions.subscribe(id, onEvent);
      if (!unsubscribe) {
        // Ended and replaced by a newer link meanwhile: say so, so the page stops instead of reconnecting.
        send('error', { code: 'gone', message: 'This link has ended. Start a new one if the phone still needs linking.' });
        close();
      }
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The workspace's reading phones (lane C, change 7): list, add, rename, unlink and remove. Linking is the link API above.

/** One phone as the Connections screen shows it: never the full number. */
export interface PhoneRow {
  id: PhoneId;
  label: string;
  state: 'active' | 'unlinked';
  /** The linked number, masked (…0001); null when not linked. */
  number: string | null;
  /** Its gateway's state while active ('open', 'closed', 'not_linked', …); null when unlinked. */
  status: string | null;
  /** Approved groups on this phone. */
  groups: number;
  /** WhatsApp's own name for the linked account (runtime/phones.ts accountNameOf): never a number; null when not known or not linked. */
  accountName: string | null;
}

export interface PhoneRoutesDeps {
  list(): PhoneRow[];
  add(label: unknown, actor: string): Promise<PhoneEntry>;
  rename(id: PhoneId, label: unknown, actor: string): Promise<PhoneEntry>;
  unlink(id: PhoneId, actor: string): Promise<UnlinkResult>;
  remove(id: PhoneId, actor: string): Promise<PhoneEntry>;
}

const LabelBody = z.object({ label: z.unknown() }).strict();
const ConfirmBody = z.object({ confirm: z.literal(true) }).strict();
/** One digit from 1 to 5, exactly as written (security review N6: no "0x2", "2e0", "02" or " 2"). */
const PhoneParam = z.string().regex(/^[1-5]$/).transform(Number);

export class PhoneRoutes {
  readonly #d: PhoneRoutesDeps;

  constructor(d: PhoneRoutesDeps) {
    this.#d = d;
  }

  /** GET /dashboard/api/whatsapp/phones */
  list(): ApiResult<{ phones: PhoneRow[]; max: number }> {
    return ok({ phones: this.#d.list(), max: MAX_PHONES });
  }

  /** POST /dashboard/api/whatsapp/phones, body { label }. */
  add(ctx: OwnerContext, body: unknown): Promise<ApiResult<{ phone: PhoneEntry } | ApiError>> {
    const parsed = LabelBody.safeParse(body);
    if (!parsed.success) return Promise.resolve(fail(400, 'invalid', 'Give the phone a name.'));
    return answer(async () => ok({ phone: await this.#d.add(parsed.data.label, ctx.actor) }));
  }

  /** POST /dashboard/api/whatsapp/phones/:id/rename, body { label }. */
  rename(ctx: OwnerContext, id: unknown, body: unknown): Promise<ApiResult<{ phone: PhoneEntry } | ApiError>> {
    const n = PhoneParam.safeParse(id);
    const parsed = LabelBody.safeParse(body);
    if (!n.success || !parsed.success) return Promise.resolve(fail(400, 'invalid', 'Choose a phone and give it a name.'));
    return answer(async () => ok({ phone: await this.#d.rename(n.data as PhoneId, parsed.data.label, ctx.actor) }));
  }

  /**
   * POST /dashboard/api/whatsapp/phones/:id/unlink, body { confirm: true }: the page's confirm named the phone and its
   * masked number and said what stays (messages, tasks, approvals).
   */
  unlink(ctx: OwnerContext, id: unknown, body: unknown): Promise<ApiResult<{ phone: PhoneEntry; loggedOut: boolean } | ApiError>> {
    const n = PhoneParam.safeParse(id);
    if (!n.success || !ConfirmBody.safeParse(body).success) return Promise.resolve(fail(400, 'invalid', 'Choose a phone, and confirm.'));
    return answer(async () => {
      const r = await this.#d.unlink(n.data as PhoneId, ctx.actor);
      return ok({ phone: r.phone, loggedOut: r.loggedOut });
    });
  }

  /** POST /dashboard/api/whatsapp/phones/:id/remove, body { confirm: true }: frees its number (never phone 1). */
  remove(ctx: OwnerContext, id: unknown, body: unknown): Promise<ApiResult<{ phone: PhoneEntry } | ApiError>> {
    const n = PhoneParam.safeParse(id);
    if (!n.success || !ConfirmBody.safeParse(body).success) return Promise.resolve(fail(400, 'invalid', 'Choose a phone, and confirm.'));
    return answer(async () => ok({ phone: await this.#d.remove(n.data as PhoneId, ctx.actor) }));
  }
}

const CONTROL_CODES: Record<ControlError['status'], string> = { 400: 'bad_request', 404: 'not_found', 409: 'conflict', 422: 'invalid' };

/** Runs a phone change; a ControlError (fixed text, safe to show) becomes its answer; anything else goes to the server. */
async function answer<T>(fn: () => Promise<ApiResult<T>>): Promise<ApiResult<T | ApiError>> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ControlError) return fail(e.status, CONTROL_CODES[e.status], e.message, e.field ? { field: e.field } : {});
    throw e;
  }
}
