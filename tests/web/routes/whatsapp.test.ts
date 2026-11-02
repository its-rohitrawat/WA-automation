import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../../../src/util/logger.ts';
import { LinkSessions, type LinkDriver, type LinkHooks, type LinkOutcome } from '../../../src/wa/linkSession.ts';
import { renderQrSvg } from '../../../src/web/qrSvg.ts';
import type { OwnerContext } from '../../../src/web/routes/context.ts';
import { linkErrorMessage, WhatsAppLinkRoutes, type SseSink } from '../../../src/web/routes/whatsapp.ts';

const QR = '2@SECRET-QR-TEXT,abc,def,1';
const owner: OwnerContext = { actor: 'owner@studio.in', sessionId: 'session-a', requestId: 'aaaaaaaaaaaa' };
const other: OwnerContext = { actor: 'second@studio.in', sessionId: 'session-b', requestId: 'bbbbbbbbbbbb' };
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A driver the test drives: it hands over the hooks, and the test finishes it. */
function controlled() {
  let hooks!: LinkHooks;
  let finish!: (o: LinkOutcome) => void;
  const driver: LinkDriver = {
    run: (h, signal) =>
      new Promise((resolve) => {
        hooks = h;
        finish = resolve;
        signal.addEventListener('abort', () => resolve({ ok: false, code: 'aborted' }), { once: true });
      }),
  };
  return { driver, hooks: () => hooks, finish: (o: LinkOutcome) => finish(o) };
}

/** Records what the stream writes. */
class FakeRes implements SseSink {
  headers: Record<string, string> = {};
  chunks: string[] = [];
  ended = false;
  #onClose: (() => void) | undefined;
  setHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value;
  }
  write(chunk: string) {
    this.chunks.push(chunk);
  }
  end() {
    this.ended = true;
  }
  on(_event: 'close', fn: () => void) {
    this.#onClose = fn;
  }
  closeFromBrowser() {
    this.#onClose?.();
  }
  /** The events as { event, data }. */
  events() {
    return this.chunks
      .filter((c) => c.startsWith('event:'))
      .map((c) => {
        const [e, d] = c.trimEnd().split('\n');
        return { event: e!.slice('event: '.length), data: JSON.parse(d!.slice('data: '.length)) as Record<string, unknown> };
      });
  }
}

function setup() {
  const c = controlled();
  const sessions = new LinkSessions({ drivers: { founder: c.driver, spare: c.driver }, log: silentLogger(), audit: async () => {} });
  const routes = new WhatsAppLinkRoutes({ sessions, heartbeatMs: 20 });
  return { c, sessions, routes };
}

describe('WhatsAppLinkRoutes', () => {
  it('start needs a target and confirm: true', () => {
    const { routes } = setup();
    expect(routes.start(owner, { target: 'founder' }).status).toBe(400);
    expect(routes.start(owner, { target: 'other', confirm: true }).status).toBe(400);
    expect(routes.start(owner, { target: 'founder', confirm: true, extra: 1 }).status).toBe(400);
    const r = routes.start(owner, { target: 'founder', confirm: true });
    expect(r.status).toBe(200);
    expect((r.body as { linkId: string }).linkId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('a second start while one runs gives 409', () => {
    const { routes } = setup();
    routes.start(owner, { target: 'founder', confirm: true });
    expect(routes.start(owner, { target: 'spare', confirm: true })).toMatchObject({ status: 409, body: { error: { code: 'link_in_progress' } } });
  });

  it('the stream sends state, the QR as an SVG (never its text), then done, and closes', async () => {
    const { routes, c } = setup();
    const { linkId } = routes.start(owner, { target: 'founder', confirm: true }).body as { linkId: string };
    await tick();
    const res = new FakeRes();
    const streaming = routes.stream(owner, linkId, res) as Promise<void>;
    c.hooks().qr(QR);
    c.hooks().opening();
    c.finish({ ok: true, device: 'WA Agent - Tracker' });
    await streaming;
    expect(res.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store');
    const events = res.events();
    expect(events.map((e) => e.event)).toEqual(['state', 'qr', 'state', 'state', 'state', 'done']);
    expect(events[0]!.data).toEqual({ state: 'waiting_qr', label: 'Getting a code from WhatsApp…' });
    expect(events[1]!.data).toEqual({ svg: renderQrSvg(QR) });
    expect(events.at(-1)!.data).toEqual({ device: 'WA Agent - Tracker' });
    expect(res.chunks.join('')).not.toContain('SECRET-QR-TEXT');
    expect(res.ended).toBe(true);
  });

  it('another session gets 403 on the stream and on cancel, and nothing is written', async () => {
    const { routes } = setup();
    const { linkId } = routes.start(owner, { target: 'founder', confirm: true }).body as { linkId: string };
    const res = new FakeRes();
    expect(routes.stream(other, linkId, res)).toMatchObject({ status: 403 });
    expect(res.chunks).toEqual([]);
    expect(routes.cancel(other, { linkId })).toMatchObject({ status: 403 });
    expect(routes.stream(owner, 'f'.repeat(32), new FakeRes())).toMatchObject({ status: 404 });
  });

  it('cancel ends the link; the stream reports the restore message and closes', async () => {
    const { routes, sessions } = setup();
    const { linkId } = routes.start(owner, { target: 'founder', confirm: true }).body as { linkId: string };
    await tick();
    const res = new FakeRes();
    const streaming = routes.stream(owner, linkId, res) as Promise<void>;
    expect(routes.cancel(owner, { linkId })).toEqual({ status: 200, body: { cancelled: true } });
    await sessions.settled(linkId);
    await streaming;
    expect(res.events().at(-1)).toEqual({ event: 'error', data: { code: 'cancelled', message: "Cancelled. The founder's phone is linked as before." } });
  });

  it('a late subscriber gets only the latest QR; a browser that goes away leaves the link running', async () => {
    const { routes, c, sessions } = setup();
    const { linkId } = routes.start(owner, { target: 'spare', confirm: true }).body as { linkId: string };
    await tick();
    c.hooks().qr('first-code');
    c.hooks().qr('second-code');
    const res = new FakeRes();
    const streaming = routes.stream(owner, linkId, res) as Promise<void>;
    expect(res.events().filter((e) => e.event === 'qr').map((e) => e.data.svg)).toEqual([renderQrSvg('second-code')]);
    res.closeFromBrowser();
    await streaming;
    expect(sessions.info(linkId)!.state).toBe('qr');
    c.finish({ ok: true, device: 'D' });
    await sessions.settled(linkId);
  });

  it('sends a heartbeat comment while waiting', async () => {
    const { routes } = setup();
    const { linkId } = routes.start(owner, { target: 'founder', confirm: true }).body as { linkId: string };
    const res = new FakeRes();
    const streaming = routes.stream(owner, linkId, res) as Promise<void>;
    await new Promise((r) => setTimeout(r, 50));
    expect(res.chunks).toContain(': ping\n\n');
    res.closeFromBrowser();
    await streaming;
  });

  it('closing the stream clears its heartbeat timer and its subscription', async () => {
    vi.useFakeTimers();
    try {
      const { routes, sessions } = setup();
      const unsubscribed: string[] = [];
      const real = sessions.subscribe.bind(sessions);
      vi.spyOn(sessions, 'subscribe').mockImplementation((id, fn) => {
        const off = real(id, fn);
        return off ? () => { unsubscribed.push(id); off(); } : off;
      });
      const { linkId } = routes.start(owner, { target: 'founder', confirm: true }).body as { linkId: string };
      const before = vi.getTimerCount();
      const res = new FakeRes();
      const streaming = routes.stream(owner, linkId, res) as Promise<void>;
      expect(vi.getTimerCount()).toBe(before + 1);
      res.closeFromBrowser();
      await streaming;
      expect(vi.getTimerCount()).toBe(before);
      expect(unsubscribed).toEqual([linkId]);
      routes.cancel(owner, { linkId });
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a browser that left before the stream started: nothing is written and no timer is left', async () => {
    const { routes } = setup();
    const { linkId } = routes.start(owner, { target: 'founder', confirm: true }).body as { linkId: string };
    const res = Object.assign(new FakeRes(), { destroyed: true });
    await (routes.stream(owner, linkId, res) as Promise<void>);
    expect(res.chunks).toEqual([]);
    expect(res.headers).toEqual({});
  });

  it('a link replaced by a newer one meanwhile: the stream says it is gone and closes', async () => {
    const { routes, sessions, c } = setup();
    const { linkId } = routes.start(owner, { target: 'founder', confirm: true }).body as { linkId: string };
    await tick();
    c.finish({ ok: true, device: 'D' });
    await sessions.settled(linkId);
    sessions.start({ target: 'spare', actor: 'cli' }); // a newer link, not through these routes
    const res = new FakeRes();
    await (routes.stream(owner, linkId, res) as Promise<void>);
    expect(res.events()).toEqual([{ event: 'error', data: { code: 'gone', message: 'This link has ended. Start a new one if the phone still needs linking.' } }]);
    expect(res.ended).toBe(true);
  });

  it('error messages: founder failures say the phone is linked as before; spare refusals reuse the spare messages', () => {
    expect(linkErrorMessage('founder', 'logged_out')).toMatch(/linked as before/);
    expect(linkErrorMessage('founder', 'something-new')).toMatch(/Something went wrong/);
    expect(linkErrorMessage('spare', 'founder_number')).toMatch(/scanned with the founder's phone/);
    expect(linkErrorMessage('spare', 'timed_out')).toMatch(/5 minutes/);
  });
});

describe('renderQrSvg', () => {
  it('is a plain SVG image: no script, no link, no QR text', () => {
    const svg = renderQrSvg(QR);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    expect(svg).not.toMatch(/<script|href|on[a-z]+=|SECRET/i);
    expect(svg).toMatch(/^<svg[^>]*><rect [^>]*\/><path d="(M\d+ \d+h1v1h-1z)+" fill="#000000"\/><\/svg>$/);
  });

  it('a fixed input gives the standard size: "HELLO" is a version 1 code (21 modules, plus a 4-module border)', () => {
    expect(renderQrSvg('HELLO')).toContain('viewBox="0 0 29 29"');
    // The three finder squares: a 7×7 dark ring at each of three corners (top-left checked here).
    const svg = renderQrSvg('HELLO');
    for (let i = 0; i < 7; i++) expect(svg).toContain(`M${4 + i} 4h1v1h-1z`);
  });

  it('is the same for the same text and different for another', () => {
    expect(renderQrSvg('a')).toBe(renderQrSvg('a'));
    expect(renderQrSvg('a')).not.toBe(renderQrSvg('b'));
  });
});
