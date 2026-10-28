// Connections: one card per connection with its real state and the button that fixes or tests it (views/connect.js).
// After Google sends the owner back, the address says how it went (?connected=<label> or ?google_error=<code>).
import { get } from '../api.js';
import { readConnections } from '../contract.js';
import { esc, icon, toast } from '../dom.js';
import { CONNECTIONS_CHANGED, actionRunning, googleErrorMessage } from './connect.js';
import { attentionBanner } from './overview.js';

/** @typedef {ReturnType<typeof readConnections>[number]} Card */

const CONNECTIONS_MS = 10_000;
const ICON = { founder: 'bubble', spare: 'phone', google: 'mail', drive: 'folder', claude: 'ai', monitoring: 'pulse' };
const PILL = { ok: 'p-done', warn: 'p-warn', down: 'p-overdue', off: 'p-muted' };
const DEFAULT_LABEL = { ok: 'Connected', warn: 'Needs attention', down: 'Disconnected', off: 'Off' };

const button = (/** @type {string} */ attrs, /** @type {string} */ ic, /** @type {string} */ label, primary = false) =>
  `<button class="btn btn-sm ${primary ? 'btn-primary' : 'btn-ghost'}" type="button" ${attrs}>${icon(ic, 15)}${esc(label)}</button>`;

/** The card's button: a dialog (data-fix) or a quick action (data-action). @param {Card} c */
function action(c) {
  const broken = c.state === 'down' || c.state === 'warn';
  if (c.kind === 'founder') {
    return c.stateLabel === 'Not linked' ? button('data-fix="founder-link"', 'phone', 'Link phone', true) : button('data-fix="founder"', 'refresh', 'Reconnect', broken);
  }
  if (c.kind === 'spare') return c.state === 'ok' ? button('data-fix="spare"', 'refresh', 'Reconnect') : button('data-fix="spare-link"', 'phone', 'Link phone', true);
  if (c.kind === 'google') return button(`data-fix="${esc(c.id)}"`, 'refresh', 'Reconnect', broken);
  if (c.kind === 'drive') return quick('upload-tracker', 'cloud', 'Upload tracker now');
  if (c.kind === 'claude') return quick('test-claude', 'flash', 'Test connection');
  if (c.state === 'off') return '<button class="btn btn-sm btn-ghost" type="button" disabled data-tip="Set up the heartbeat on the Mac first">' + icon('pulse', 15) + 'Send test beat</button>';
  return quick('test-heartbeat', 'pulse', 'Send test beat');
}

/** A quick action's button; still busy if the action runs while the cards are drawn again. @param {string} name @param {string} ic @param {string} label */
function quick(name, ic, label) {
  if (actionRunning(name)) return `<button class="btn btn-sm btn-ghost" type="button" disabled data-action="${name}"><span class="spin"></span>Working…</button>`;
  return button(`data-action="${name}"`, ic, label);
}

/** @param {Card[] | null} cards @param {unknown} [error] */
export function renderConnections(cards, error) {
  if (!cards) return `<p class="loading">${error ? 'The connections could not be loaded. Trying again shortly.' : 'Loading the connections…'}</p>`;
  if (!cards.length) return '<p class="empty-note">No connections to show yet.</p>';
  const card = (/** @type {Card} */ c) => {
    const kind = /** @type {keyof typeof ICON} */ (c.kind);
    return `<article class="card conn" data-conn="${esc(c.id)}"${c.email ? ` data-email="${esc(c.email)}"` : ''}${c.meetings ? ' data-meetings="1"' : ''}><div class="top-row"><div class="badge">${icon(ICON[kind] ?? 'plug', 21)}</div>
        <div class="grow-1"><h3>${esc(c.title)}</h3><div class="sub">${esc(c.subtitle)}</div></div>
        <span class="pill ${PILL[c.state]}"><i></i>${esc(c.stateLabel || DEFAULT_LABEL[c.state])}</span></div>
      <dl class="kv">${c.rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
      ${c.note ? `<div class="note">${icon('info', 16)}<span>${esc(c.note)}</span></div>` : ''}
      <div class="conn-act">${action(c)}${c.link ? `<a class="btn btn-sm btn-ghost" href="${esc(c.link)}" target="_blank" rel="noopener noreferrer" data-open-drive>${icon('ext', 15)}Open in Drive</a>` : ''}</div></article>`;
  };
  return `<div class="toolbar"><span class="grow-1"></span>${button('data-fix="google-add"', 'mail', 'Add Google account')}</div>
    <div class="conns">${cards.map(card).join('')}</div>
    <p class="muted-note">Every reconnect runs inside the agent on the Mac. Sign-in tokens and keys stay there and are never shown here. Each action is recorded in Audit logs.</p>`;
}

/** @param {import('./registry.js').ScreenCtx} ctx */
export function mountConnections(ctx) {
  // Back from Google: say how it went once, then clean the address.
  const params = new URLSearchParams(location.search);
  const connected = params.get('connected');
  const googleError = params.get('google_error');
  if (connected !== null || googleError !== null) history.replaceState(null, '', location.pathname);
  if (connected !== null && /^[a-z0-9][a-z0-9-]{0,19}$/.test(connected)) toast(connected === 'main' ? 'Connected. The main Google account is signed in.' : `Connected. Google account ${connected} is signed in.`);
  const notice = googleError === null ? '' : `<div class="attn" role="alert">${icon('alert', 20)}<div class="grow-1"><b>Google sign-in didn't finish</b><div>${esc(googleErrorMessage(googleError.slice(0, 40)))}</div></div></div>`;

  /** @type {Card[] | null} */
  let cards = null;
  /** @type {unknown} */
  let error = null;
  const draw = () => ctx.redraw(notice + attentionBanner(/** @type {any} */ (ctx.status())) + renderConnections(cards, error));
  const load = async () => {
    try {
      const next = readConnections(await get('/connections'));
      if (!ctx.live()) return;
      cards = next;
      error = null;
    } catch (e) {
      if (!ctx.live() || cards) return;
      error = e;
    }
    draw();
  };
  // The banner follows the status, but only redraws when what it shows changed (not on every 10 s check).
  const statusKey = () => JSON.stringify({ ...ctx.status(), checkedAt: null });
  let drawnStatus = statusKey();
  ctx.onStatus(() => {
    if (statusKey() === drawnStatus) return;
    drawnStatus = statusKey();
    draw();
  });
  draw();
  ctx.poll(load, CONNECTIONS_MS);
  const onChanged = () => void load();
  addEventListener(CONNECTIONS_CHANGED, onChanged);
  return () => removeEventListener(CONNECTIONS_CHANGED, onChanged);
}
