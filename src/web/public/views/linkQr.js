// A WhatsApp link shown inline in Getting started (steps 1 and 3, SaaS S4.6 C): the steps to take on the phone, the
// QR code, the scan, and the result. It starts, follows and cancels the link through a LinkApi, so the screen does not
// depend on where the link session lives: today the dashboard's routes; for a customer, their own link session (plan
// S4.6 A) on the same routes, chosen by the session. Every value from the agent goes through textContent or esc().
import { ApiError, post } from '../api.js';
import { $, esc, icon } from '../dom.js';

/** @typedef {'founder' | 'spare'} LinkTarget */
/**
 * How the panel starts, follows and cancels a link.
 * @typedef {{
 *   start(target: LinkTarget): Promise<string>,
 *   events(linkId: string): EventSource,
 *   cancel(linkId: string, keepalive?: boolean): void,
 * }} LinkApi
 */

const LINK_ID = /^[0-9a-f]{32}$/;

/** The dashboard's link routes (src/web/routes/whatsapp.ts), for the signed-in session's own phones. @type {LinkApi} */
export const DASHBOARD_LINKS = {
  async start(target) {
    const r = await post('/whatsapp/link/start', { target, confirm: true });
    const id = typeof r?.linkId === 'string' && LINK_ID.test(r.linkId) ? r.linkId : null;
    if (!id) throw new ApiError(502, 'no_link', 'The agent did not start the link. Try again.');
    return id;
  },
  events: (linkId) => new EventSource(`/dashboard/api/whatsapp/link/stream?id=${encodeURIComponent(linkId)}`),
  cancel: (linkId, keepalive = false) => void post('/whatsapp/link/cancel', { linkId }, { keepalive }).catch(() => {}),
};

const WHO = /** @type {Record<LinkTarget, string>} */ ({
  founder: 'the phone with the WhatsApp number that is in your client groups',
  spare: 'your spare phone',
});

/**
 * Shows a link in `box` at once and runs it. Returns stop(): it ends the panel's part (and cancels a link still waiting
 * for its scan, so the phone stays as it was). onDone gets the linked device's name; onCancel: the person pressed Cancel.
 * @param {HTMLElement} box
 * @param {{ target: LinkTarget, api?: LinkApi, onDone: (device: string) => void, onCancel?: () => void }} o
 * @returns {{ stop(): void }}
 */
export function mountLinkQr(box, o) {
  const api = o.api ?? DASHBOARD_LINKS;
  /** @type {string | null} */
  let linkId = null;
  /** @type {EventSource | null} */
  let stream = null;
  /** The agent ended the link itself (linked, or refused): nothing is left to cancel. */
  let ended = false;
  let stopped = false;

  const close = () => {
    stream?.close();
    stream = null;
  };
  const cancel = (keepalive = false) => {
    if (linkId && !ended) api.cancel(linkId, keepalive);
    linkId = null;
  };
  // Leaving the page mid-link (reload, a closed tab) cancels it, so no link waits on a code nobody sees.
  const onPageHide = () => cancel(true);
  addEventListener('pagehide', onPageHide);

  /** @param {string} text */
  const status = (text) => {
    const t = $('[data-link-status]', box);
    if (t && t.textContent !== text) t.textContent = text;
  };

  /** @param {string} message @param {boolean} byAgent */
  const fail = (message, byAgent) => {
    close();
    if (byAgent) ended = true;
    else cancel();
    box.innerHTML = `<div class="pf-link-fail">${icon('alert', 18)}<span>${esc(message)}</span></div>
      <div class="pf-row"><button class="btn btn-primary btn-sm" type="button" data-link-again>Try again</button></div>`;
  };

  async function start() {
    cancel();
    ended = false;
    box.innerHTML = `<ol class="steps"><li><span>On <b>${esc(WHO[o.target])}</b>, open WhatsApp → <b>Settings</b> → <b>Linked devices</b> → <b>Link a device</b>.</span></li><li><span>Point the phone at this code.</span></li></ol>
      <div class="qr qr-wait" data-link-qr><span class="spin"></span></div>
      <div class="qr-status"><span class="spin"></span><span data-link-status role="status">Getting a code from WhatsApp…</span></div>
      <div class="pf-row pf-link-foot"><button class="btn btn-ghost btn-sm" type="button" data-link-cancel>Cancel</button></div>`;
    try {
      const id = await api.start(o.target);
      if (stopped) return api.cancel(id); // left while the agent was starting it
      linkId = id;
    } catch (e) {
      if (!stopped) fail(e instanceof ApiError ? e.message : 'The agent could not be reached. Try again.', true);
      return;
    }
    follow();
  }

  function follow() {
    close();
    stream = api.events(/** @type {string} */ (linkId));
    /** @param {Event} e */
    const data = (e) => {
      try {
        return JSON.parse(/** @type {MessageEvent} */ (e).data);
      } catch {
        return {};
      }
    };
    stream.addEventListener('qr', (e) => {
      const svg = data(e).svg;
      const qr = $('[data-link-qr]', box);
      if (typeof svg !== 'string' || !qr || !svg.startsWith('<svg')) return;
      const img = document.createElement('img');
      img.alt = 'QR code to scan with the phone';
      img.width = 196;
      img.height = 196;
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      qr.classList.remove('qr-wait', 'qr-dim');
      qr.replaceChildren(img);
      status('Waiting for the scan');
    });
    stream.addEventListener('state', (e) => {
      const d = data(e);
      if (d.state === 'opening') {
        $('[data-link-qr]', box)?.classList.add('qr-dim');
        status('Scanned. Linking and loading your groups…');
      } else if (d.state === 'waiting_qr') status('Getting a code from WhatsApp…');
    });
    stream.addEventListener('done', (e) => {
      ended = true;
      close();
      const device = String(data(e).device ?? '').slice(0, 80) || 'WA Agent';
      box.innerHTML = `<div class="pf-link-done">${icon('ok', 22)}<span>Linked as "${esc(device)}".</span></div>`;
      o.onDone(device);
    });
    stream.addEventListener('error', (e) => {
      // A named "error" from the agent has data; the browser's own (the connection) has none.
      const d = /** @type {MessageEvent} */ (e).data ? data(e) : null;
      if (d) return fail(typeof d.message === 'string' ? d.message : 'The link did not work. Try again.', true);
      if (stream && stream.readyState === EventSource.CLOSED && !ended) fail('Lost contact with the agent during the link. Try again.', false);
    });
  }

  const onClick = (/** @type {Event} */ e) => {
    const t = /** @type {Element} */ (e.target);
    if (t.closest('[data-link-again]')) void start();
    else if (t.closest('[data-link-cancel]')) {
      stop();
      o.onCancel?.();
    }
  };
  box.addEventListener('click', onClick);

  function stop() {
    if (stopped) return;
    stopped = true;
    close();
    cancel();
    removeEventListener('pagehide', onPageHide);
    box.removeEventListener('click', onClick);
  }

  void start();
  return { stop };
}
