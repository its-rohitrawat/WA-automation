// Reconnecting from the dashboard (D3): the WhatsApp link dialog with the live QR code, the Google dialog, and the quick
// actions on the Connections cards. Every step runs in the agent on the Mac; this page only shows it. The QR code comes
// from the agent as an SVG image and is shown as an <img> (a data: URL), so nothing in it can run.
import { ApiError, get, post } from '../api.js';
import { readConnections } from '../contract.js';
import { $, esc, gsap, icon, reduceMotion, toast } from '../dom.js';
import { closeDrawer, focusFirst, openDrawerElement, openModal } from './drawer.js';

/** How long WhatsApp keeps a code: the first for about a minute, each next one about 20 seconds. */
const FIRST_CODE_S = 60;
const NEXT_CODE_S = 20;
// A Google account's name, as the agent checks it (src/output/googleAuth.ts).
const LABEL = /^[a-z0-9][a-z0-9-]{0,19}$/;

/** The window event sent after anything here may have changed a connection: the shell and Connections refresh. */
export const CONNECTIONS_CHANGED = 'wa-connections-changed';
const onChanged = () => dispatchEvent(new Event(CONNECTIONS_CHANGED));

const GOOGLE_SVG = `<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#4285F4" d="M45 24.5c0-1.6-.1-2.8-.4-4.1H24v7.7h12c-.2 2-1.6 5-4.6 7l7.1 5.5C42.7 36.7 45 31.1 45 24.5z"/><path fill="#34A853" d="M24 46c6 0 11-2 14.6-5.4l-7.1-5.5c-1.9 1.3-4.4 2.2-7.5 2.2-5.8 0-10.6-3.8-12.4-9.1l-7.3 5.7C7.9 41.1 15.4 46 24 46z"/><path fill="#FBBC05" d="M11.6 28.2c-.5-1.3-.7-2.7-.7-4.2s.3-2.9.7-4.2l-7.3-5.7C2.8 17.1 2 20.4 2 24s.8 6.9 2.3 9.9l7.3-5.7z"/><path fill="#EA4335" d="M24 10.7c4.1 0 6.9 1.8 8.5 3.3l6.2-6.1C34.9 4.4 30 2 24 2 15.4 2 7.9 6.9 4.3 14.1l7.3 5.7c1.8-5.3 6.6-9.1 12.4-9.1z"/></svg>`;

const head = (/** @type {string} */ eyebrow, /** @type {string} */ title) =>
  `<div class="m-head"><div><span class="eyebrow">${esc(eyebrow)}</span><h2>${esc(title)}</h2></div><button class="icon-btn" type="button" data-close aria-label="Close">${icon('close', 18)}</button></div>`;

/** @param {HTMLElement} m @param {string} html */
function step(m, html) {
  const body = $('.m-body', m);
  body.innerHTML = html;
  focusFirst(body);
}

// ---------- WhatsApp ----------

/**
 * The link dialog for the founder's or the spare phone. `relink` asks first (it replaces a working link).
 * @param {'founder' | 'spare'} target @param {{ relink: boolean }} opts
 */
export function linkWhatsApp(target, opts) {
  const founder = target === 'founder';
  const who = founder ? "the founder's phone" : 'the spare phone';
  /** @type {string | null} */
  let linkId = null;
  /** @type {EventSource | null} */
  let stream = null;
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let tick;
  /** The agent ended the link itself (linked, or refused with a reason): nothing is left to cancel. */
  let ended = false;

  const stop = () => {
    clearInterval(tick);
    stream?.close();
    stream = null;
  };
  /** @param {string} id @param {boolean} [keepalive] */
  const sendCancel = (id, keepalive = false) => void post('/whatsapp/link/cancel', { linkId: id }, { keepalive }).catch(() => {});
  /** Cancels the link this dialog started, if it still runs: the phone stays linked as before. */
  const cancelLink = () => {
    if (linkId && !ended) sendCancel(linkId);
    linkId = null;
  };
  // Leaving the page mid-link (reload, closed tab) cancels it too, so no link waits on a code nobody sees.
  const onPageHide = () => {
    if (linkId && !ended) sendCancel(linkId, true);
  };
  addEventListener('pagehide', onPageHide);
  // Closing the dialog (Close, Cancel, Escape, the scrim, another screen, sign-out) cancels a running link.
  const onClose = () => {
    stop();
    removeEventListener('pagehide', onPageHide);
    cancelLink();
  };

  const m = openModal(`${head(founder ? 'Founder WhatsApp' : 'Spare WhatsApp', `${opts.relink ? 'Reconnect' : 'Link'} ${who}`)}<div class="m-body"></div>`, { onClose });
  const live = () => openDrawerElement() === m;

  const confirmStep = () =>
    step(m, `<p class="m-p">Reconnecting replaces the current link. ${founder ? 'The agent pauses reading for the moment it takes to scan.' : 'The morning briefing pauses until you scan.'} If you don't scan, the phone stays linked as before.</p>
      <div class="m-foot"><button class="btn btn-ghost" type="button" data-close>Cancel</button><button class="btn btn-primary" type="button" data-step="start">Show QR code</button></div>`);

  /**
   * The link failed. `byAgent`: the agent ended it (nothing to cancel); otherwise (contact lost) it is cancelled now, so
   * Try again does not find it still running.
   * @param {string} message @param {boolean} byAgent
   */
  const failStep = (message, byAgent) => {
    stop();
    if (byAgent) ended = true;
    else cancelLink();
    step(m,`<div class="m-fail">${icon('alert', 22)}<p class="m-p">${esc(message)}</p></div>
      <div class="m-foot"><button class="btn btn-ghost" type="button" data-close>Close</button><button class="btn btn-primary" type="button" data-step="start">Try again</button></div>`);
  };

  async function start() {
    cancelLink();
    ended = false;
    step(m, `<div class="qr-status m-wait"><span class="spin"></span><span>Getting a code from WhatsApp…</span></div>`);
    try {
      const r = await post('/whatsapp/link/start', { target, confirm: true });
      const id = typeof r?.linkId === 'string' && /^[0-9a-f]{32}$/.test(r.linkId) ? r.linkId : null;
      // Closed while the agent was starting it: cancel the link that just began.
      if (!live()) {
        if (id) sendCancel(id);
        return;
      }
      linkId = id;
      if (!linkId) return failStep('The agent did not start the link. Try again.', true);
    } catch (e) {
      if (live()) failStep(e instanceof ApiError ? e.message : 'The agent could not be reached. Try again.', true);
      return;
    }
    step(m, `<ol class="steps"><li><span>On <b>${esc(who)}</b>, open WhatsApp → <b>Settings</b> → <b>Linked devices</b> → <b>Link a device</b>.</span></li><li><span>Point the phone at this code.</span></li></ol>
      ${founder ? '' : `<div class="note note-warn">${icon('alert', 16)}<span>Use the spare phone. A scan from the founder's phone is refused, because the report must come from a different number.</span></div>`}
      <div class="qr qr-wait" id="m-qr"><span class="spin"></span></div>
      <div class="qr-status"><span class="spin"></span><span><span id="m-qr-t" role="status">Getting a code from WhatsApp…</span><span id="m-qr-c" aria-hidden="true"></span></span></div>
      <div class="m-foot"><button class="btn btn-ghost" type="button" data-close>Cancel</button></div>`);
    listen();
  }

  function listen() {
    stream?.close();
    stream = new EventSource(`/dashboard/api/whatsapp/link/stream?id=${encodeURIComponent(linkId ?? '')}`);
    let codes = 0;
    let left = 0;
    // The status is read out when it changes; the countdown beside it is not (it changes every second).
    const status = (/** @type {string} */ text) => {
      const t = $('#m-qr-t', m);
      if (t && t.textContent !== text) t.textContent = text;
      const c = $('#m-qr-c', m);
      if (c) c.textContent = '';
    };
    const countdown = () => {
      status('Waiting for the scan');
      const c = $('#m-qr-c', m);
      if (c) c.innerHTML = ` · new code in <b class="mono">${Math.max(0, left)}</b> s`;
    };
    /** @param {MessageEvent} e */
    const data = (e) => {
      try {
        return JSON.parse(e.data);
      } catch {
        return {};
      }
    };
    stream.addEventListener('qr', (e) => {
      const svg = data(/** @type {MessageEvent} */ (e)).svg;
      const box = $('#m-qr', m);
      if (typeof svg !== 'string' || !box || !svg.startsWith('<svg')) return;
      const img = document.createElement('img');
      img.alt = 'QR code to scan with the phone';
      img.width = 196;
      img.height = 196;
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      box.classList.remove('qr-wait', 'qr-dim');
      box.replaceChildren(img);
      if (gsap && !reduceMotion) gsap.fromTo(img, { autoAlpha: 0.3 }, { autoAlpha: 1, duration: 0.3 });
      left = codes++ === 0 ? FIRST_CODE_S : NEXT_CODE_S;
      countdown();
      clearInterval(tick);
      tick = setInterval(() => {
        left--;
        countdown();
      }, 1000);
    });
    stream.addEventListener('state', (e) => {
      const d = data(/** @type {MessageEvent} */ (e));
      if (d.state === 'opening') {
        clearInterval(tick);
        $('#m-qr', m)?.classList.add('qr-dim');
        status(`Scanned. Linking and loading ${founder ? 'your groups' : 'the session'}…`);
      } else if (d.state === 'waiting_qr') status('Getting a code from WhatsApp…');
    });
    stream.addEventListener('done', (e) => {
      ended = true;
      stop();
      const device = String(data(/** @type {MessageEvent} */ (e)).device ?? '').slice(0, 80) || (founder ? 'WA Agent - Tracker' : 'WA Agent - Morning report');
      step(m, `<div class="m-done">${icon('ok', 40)}<h3>Linked as "${esc(device)}"</h3><p class="m-p">${founder ? 'The agent is reading the approved groups again.' : 'The spare phone can now send the morning briefing once it is switched on.'}</p></div>
        <div class="m-foot"><button class="btn btn-primary" type="button" data-close>Done</button></div>`);
      if (gsap && !reduceMotion) gsap.from($('.m-done', m), { scale: 0.9, autoAlpha: 0, duration: 0.4, ease: 'back.out(1.6)' });
      onChanged();
    });
    stream.addEventListener('error', (e) => {
      // A named "error" event from the agent has data; the browser's own (connection) error has none.
      const d = /** @type {MessageEvent} */ (e).data ? data(/** @type {MessageEvent} */ (e)) : null;
      if (d) return failStep(typeof d.message === 'string' ? d.message : 'The link did not work. Try again.', true);
      // The connection dropped: the browser retries by itself while it can; once it gives up, say so (and cancel).
      if (stream && stream.readyState === EventSource.CLOSED && !ended) failStep('Lost contact with the agent during the link. Try again.', false);
    });
  }

  m.addEventListener('click', (e) => {
    if (/** @type {Element} */ (e.target).closest('[data-step="start"]')) void start();
  });
  if (opts.relink) confirmStep();
  else void start();
}

// ---------- Google ----------

/** What the agent asks Google for, in words (src/output/googleAuth.ts: DRIVE_SCOPES and MEETING_SCOPES). @param {boolean} main @param {boolean} meetings */
function accessList(main, meetings) {
  const items = [];
  if (main) items.push('Drive · only files the agent itself creates (the tracker)');
  if (meetings) items.push('Meet recordings · read only', 'Calendar events · read only, to match meetings to clients', 'Meet recording files in Drive · read only');
  return `<div class="h4">The agent asks for</div><ul class="steps">${items.map((i) => `<li><span>${esc(i)}</span></li>`).join('')}</ul>`;
}

/**
 * Sends the owner to Google for an account: an existing one by its label, or a new one ({ add }).
 * @param {string | { add: string }} account
 */
async function goToGoogle(account) {
  const r = await post('/google/connect', { account });
  const url = typeof r?.url === 'string' ? r.url : '';
  // Only ever Google's own sign-in page.
  if (!url.startsWith('https://accounts.google.com/')) throw new ApiError(502, 'bad_url', 'The agent did not give a Google sign-in address. Try again.');
  location.assign(url);
}

/**
 * The Google dialog: reconnect an account, or (label null) add one.
 * @param {{ label: string | null, email?: string, meetings?: boolean }} a
 */
export async function connectGoogle(a) {
  // From Fix now there is no card: the account's email and use come from the agent's connections answer.
  if (a.label !== null && a.email === undefined) {
    try {
      const card = readConnections(await get('/connections')).find((c) => c.id === `google:${a.label}`);
      if (card) a = { ...a, email: card.email, meetings: card.meetings };
    } catch {
      // the dialog says less, nothing more
    }
  }
  const adding = a.label === null;
  const main = a.label === 'main';
  const title = adding ? 'Add a Google account' : `Reconnect ${a.email || (main ? 'the main account' : a.label)}`;
  const m = openModal(`${head(adding ? 'Google' : main ? 'Google account · main' : `Google account · ${a.label}`, title)}<form class="m-body" id="m-g-form" novalidate></form>`);
  const form = /** @type {HTMLFormElement} */ ($('#m-g-form', m));
  form.innerHTML = `<p class="m-p">${adding
    ? 'Add another Google account whose Meet recordings the agent should read. Give it a short name, then choose the account at Google.'
    : `You'll go to Google, choose <b>${esc(a.email || 'the account')}</b> and approve. You come straight back here; the agent saves the new sign-in on the Mac.`}</p>
    ${adding ? `<label class="h4 g-label" for="m-g-label">Account name</label><div class="field"><input id="m-g-label" class="grow-1" maxlength="20" autocomplete="off" spellcheck="false" placeholder="company2"></div>
      <p class="muted-note">Lower-case letters, digits or '-', up to 20. It names the account in the dashboard and the logs.</p>` : ''}
    ${accessList(main, adding || !main || Boolean(a.meetings))}
    <p class="g-error" role="alert" hidden></p>
    <div class="m-foot"><button class="btn btn-ghost" type="button" data-close>Cancel</button><button class="gbtn gbtn-inline" type="submit">${GOOGLE_SVG}Continue with Google</button></div>`;
  focusFirst(form);
  const err = $('.g-error', form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    let account = /** @type {string | { add: string }} */ (a.label ?? '');
    if (adding) {
      const label = /** @type {HTMLInputElement} */ ($('#m-g-label', form)).value.trim().toLowerCase();
      if (!LABEL.test(label) || label === 'main') {
        err.textContent = "The name must be 1–20 lower-case letters, digits or '-', start with a letter or digit, and not be 'main'. For example: company2";
        err.hidden = false;
        return;
      }
      account = { add: label };
    }
    const btn = /** @type {HTMLButtonElement} */ ($('button[type="submit"]', form));
    btn.disabled = true;
    try {
      await goToGoogle(account);
    } catch (x) {
      btn.disabled = false;
      err.textContent = x instanceof ApiError ? x.message : 'The agent could not be reached. Try again.';
      err.hidden = false;
    }
  });
}

/** The message for ?google_error=<code> after a refused Google sign-in. @param {string} code */
export function googleErrorMessage(code) {
  const m = /** @type {Record<string, string>} */ ({
    state: 'That Google sign-in expired or was started in another browser. Start it again from here.',
    denied: 'The Google sign-in was cancelled. Nothing changed.',
    exists: 'A Google account with that name is already connected.',
    not_found: 'That Google account is not set up any more.',
    exchange: "Google didn't accept the sign-in. Try again.",
    no_refresh_token: 'Google sent no lasting sign-in. Remove WA Agent at myaccount.google.com/permissions, then try again.',
    missing_scope: 'Some permissions were not ticked. Try again and tick every box Google shows.',
    save: 'The sign-in could not be saved on the Mac. Try again.',
  });
  return m[code] ?? "The Google sign-in didn't work. Try again.";
}

// ---------- quick actions ----------

/** @param {string} name @param {Record<string, unknown>} r */
function actionMessage(name, r) {
  if (name === 'upload-tracker') {
    if (r.ok) return 'Tracker.xlsx uploaded to Drive.';
    return r.reason === 'timeout' ? 'The upload is taking over a minute. It carries on in the background.' : "The upload didn't work. The agent tries again at the next update.";
  }
  if (name === 'test-claude') {
    if (r.ok) return `Claude answered in ${(Number(r.ms) / 1000).toFixed(1)} s. The connection is fine.`;
    if (r.reason === 'auth') return 'Claude refused the API key. Check ANTHROPIC_API_KEY on the Mac.';
    return r.reason === 'timeout' ? "Claude didn't answer within 15 seconds." : "Claude couldn't be reached from the Mac.";
  }
  if (r.ok) return 'Test heartbeat sent. UptimeRobot received it.';
  if (r.reason === 'not_configured') return 'The heartbeat is not set up on the Mac.';
  if (r.reason === 'not_up') return 'No heartbeat sent: the agent holds it back while a part is down, so UptimeRobot reports the problem.';
  if (r.reason === 'stopped') return 'No heartbeat sent: the agent is stopping.';
  return typeof r.status === 'number' ? `The heartbeat was refused (HTTP ${r.status}).` : "The heartbeat didn't go through.";
}

/** The quick actions running now: their buttons stay busy even when the cards are drawn again meanwhile. */
const running = new Set();
/** @param {string} name */
export const actionRunning = (name) => running.has(name);

/** Runs a quick action, its button busy meanwhile. @param {HTMLButtonElement} btn @param {string} name */
export async function runAction(btn, name) {
  if (running.has(name)) return;
  running.add(name);
  const old = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span>Working…';
  try {
    const r = /** @type {Record<string, unknown>} */ (await post(`/actions/${encodeURIComponent(name)}`) ?? {});
    toast(actionMessage(name, r), r.ok === true);
  } catch (e) {
    toast(e instanceof ApiError ? e.message : "The action didn't run. Try again.", false);
  } finally {
    running.delete(name);
    if (document.contains(btn)) {
      btn.innerHTML = old;
      btn.disabled = false;
    }
    onChanged();
  }
}

/**
 * What "Fix now" does for a part of the status: the dialog that fixes it, or null (then it opens Connections).
 * @param {{ key: string, state: string, detail: string }} part
 * @returns {string | null} a data-fix value
 */
export function fixFor(part) {
  if (part.key === 'whatsapp') {
    if (part.detail === 'Not linked') return 'founder-link';
    // Only a link that is gone needs a new one; Connecting or Reconnecting clears by itself.
    return part.state === 'down' && part.detail !== 'Disconnected' ? 'founder' : null;
  }
  if (part.key === 'tracker' && /google/i.test(part.detail)) return 'google:main';
  if (part.key === 'meetings') {
    if (/^Paused: Google needs meeting access/.test(part.detail)) return 'google:main';
    const lost = /^Google sign-in lost for ([a-z0-9][a-z0-9-]{0,19})(?:,|$)/.exec(part.detail);
    if (lost) return `google:${lost[1]}`;
  }
  return null;
}

/**
 * Opens the dialog for a data-fix value: founder or spare (relink, with a confirm step), founder-link or spare-link
 * (first link), google:<label>, or google-add.
 * @param {string} fix @param {{ email?: string, meetings?: boolean }} [about]
 */
export function openFix(fix, about = {}) {
  closeDrawer(true);
  if (fix === 'founder' || fix === 'spare') linkWhatsApp(fix, { relink: true });
  else if (fix === 'founder-link' || fix === 'spare-link') linkWhatsApp(fix === 'founder-link' ? 'founder' : 'spare', { relink: false });
  else if (fix === 'google-add') void connectGoogle({ label: null });
  else if (fix.startsWith('google:') && LABEL.test(fix.slice(7))) void connectGoogle({ label: fix.slice(7), ...about });
}
