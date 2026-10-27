import { z } from 'zod';
import { SPARE_LINK_MESSAGES } from '../../report/senderLink.ts';
import { LinkBusyError, type LinkEvent, type LinkSessions, type LinkState, type LinkTarget } from '../../wa/linkSession.ts';
import { renderQrSvg } from '../qrSvg.ts';
import { fail, ok, type ApiError, type ApiResult, type OwnerContext } from './context.ts';

// The dashboard's WhatsApp link API (D3 task 8), unmounted: start a link (the founder's phone or the spare phone),
// cancel it, and follow it over server-sent events. Only the owner session that started a link can see its QR codes or
// cancel it. A QR goes out only as an SVG image; it is never logged, audited or kept after the link ends (LinkSessions
// keeps the latest one in memory while the link runs).

const StartBody = z.object({ target: z.enum(['founder', 'spare']), confirm: z.literal(true) }).strict();
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
};

const SPARE_EXTRA: Record<string, string> = {
  cancelled: 'Cancelled. The spare phone is linked as before.',
  timed_out: 'The code was not scanned within 5 minutes. The spare phone is linked as before.',
  stopped: 'The agent was stopped during the link. The spare phone is linked as before.',
};

/** The plain message for a link that ended without a link. */
export function linkErrorMessage(target: LinkTarget, code: string): string {
  if (target === 'founder') return FOUNDER_MESSAGES[code] ?? FOUNDER_MESSAGES.error!;
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
    if (!parsed.success) return fail(400, 'invalid', 'Choose the founder or the spare phone, and confirm.');
    try {
      const link = this.#sessions.start({ target: parsed.data.target, actor: ctx.actor });
      // Only the newest link is kept: LinkSessions holds one at a time.
      this.#owners.clear();
      this.#targets.clear();
      this.#owners.set(link.id, ctx.sessionId);
      this.#targets.set(link.id, link.target);
      return ok({ linkId: link.id });
    } catch (e) {
      if (e instanceof LinkBusyError) return fail(409, 'link_in_progress', 'A phone link is already in progress. Finish or cancel it first.');
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
        if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
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
