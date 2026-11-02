// Connections: one card per connection with its real state and the button that fixes or tests it (views/connect.js).
// After Google sends the owner back, the address says how it went (?connected=<label> or ?google_error=<code>).
import { get, post } from '../api.js';
import { readConnections, readPhones } from '../contract.js';
import { $, esc, icon, toast } from '../dom.js';
import { CONNECTIONS_CHANGED, googleErrorMessage, linkWhatsApp, quickButton } from './connect.js';
import { closeDrawer, openModal } from './drawer.js';
import { attentionBanner } from './overview.js';

/** @typedef {ReturnType<typeof readConnections>[number]} Card */
/** @typedef {import('../contract.js').PhoneRow} PhoneRow */

// ---------- Reading phones (lane C, change 7) ----------

/** A phone's gateway state in words, and its pill. */
const PHONE_STATE = /** @type {Record<string, [keyof typeof PILL, string]>} */ ({
  open: ['ok', 'Connected'], connecting: ['warn', 'Connecting'], closed: ['warn', 'Reconnecting'], stopped: ['warn', 'Starting'],
  linking: ['warn', 'Linking'], not_linked: ['off', 'Not linked'], logged_out: ['down', 'Logged out on the phone'],
  replaced: ['down', 'Replaced by another session'], forbidden: ['down', 'Refused by WhatsApp'],
});
/** The link target of a phone: phone 1 is the founder's (its link as before), 2 to 5 by number. @param {number} id */
const targetOf = (id) => /** @type {'founder' | 'phone2' | 'phone3' | 'phone4' | 'phone5'} */ (id === 1 ? 'founder' : `phone${id}`);
const modalHead = (/** @type {string} */ eyebrow, /** @type {string} */ title) =>
  `<div class="m-head"><div><span class="eyebrow">${esc(eyebrow)}</span><h2>${esc(title)}</h2></div><button class="icon-btn" type="button" data-close aria-label="Close">${icon('close', 18)}</button></div>`;

/** One phone's card. Its label is owner text and its number already masked by the agent: both through esc(). @param {PhoneRow} p */
function phoneCard(p) {
  const [pill, word] = p.state === 'unlinked' ? /** @type {[keyof typeof PILL, string]} */ (['off', 'Unlinked']) : (PHONE_STATE[p.status ?? ''] ?? ['off', 'Not linked']);
  const linked = p.state === 'active' && p.status !== 'not_linked' && p.status !== null;
  const act = (/** @type {string} */ a, /** @type {string} */ ic, /** @type {string} */ label, primary = false) => button(`data-phone="${a}" data-id="${p.id}"`, ic, label, primary);
  const buttons = [
    linked ? act('relink', 'refresh', 'Relink', pill === 'down') : act('link', 'phone', 'Link phone', true),
    linked ? act('unlink', 'close', 'Unlink') : '',
    act('rename', 'edit', 'Rename'),
    p.id !== 1 && !linked && p.groups === 0 ? act('remove', 'trash', 'Remove') : '',
  ].join('');
  return `<article class="card conn" data-conn="phone-${p.id}"><div class="top-row"><div class="badge">${icon('bubble', 21)}</div>
      <div class="grow-1"><h3>${esc(p.label)}</h3><div class="sub">Phone ${p.id}${p.id === 1 ? ' · main' : ''} · reads the groups approved on it</div></div>
      <span class="pill ${PILL[pill]}"><i></i>${esc(word)}</span></div>
    <dl class="kv"><dt>Number</dt><dd>${esc(p.number ?? '—')}</dd><dt>Groups</dt><dd>${esc(`${p.groups} approved`)}</dd></dl>
    ${p.state === 'unlinked' && p.groups > 0 ? `<div class="note">${icon('info', 16)}<span>Its groups are not read while it is unlinked. Link it again, or move them to another phone in Groups.</span></div>` : ''}
    <div class="conn-act">${buttons}</div></article>`;
}

/** The reading phones, with Add phone while fewer than the limit. @param {{ phones: PhoneRow[], max: number }} list */
export function renderPhones(list) {
  const add = list.phones.length < list.max ? button('data-phone="add"', 'phone', 'Add phone') : '';
  return `<div class="toolbar"><h2 class="grow-1">WhatsApp phones</h2>${add}</div>
    <div class="conns">${list.phones.map(phoneCard).join('')}</div>
    <p class="muted-note">Up to ${list.max} phones. Each group is read through one phone, so a group in two phones is read once. The spare phone below sends the morning briefing only.</p>`;
}

/**
 * The phone dialogs: add (then link it at once), rename, unlink (named, with its masked number and what stays; phone 1
 * named as the main phone) and remove. Each answers through the agent's own checks; its error text is shown as it is.
 * @param {string} action @param {PhoneRow | undefined} p @param {() => void} done
 */
function phoneDialog(action, p, done) {
  const fail = (/** @type {unknown} */ e) => toast(e instanceof Error ? e.message : 'That did not work. Try again.', false);
  if (action === 'link' || action === 'relink') {
    if (p) linkWhatsApp(targetOf(p.id), { relink: action === 'relink', label: p.label });
    return;
  }
  if (action === 'add' || action === 'rename') {
    const m = openModal(`${modalHead('WhatsApp phone', action === 'add' ? 'Add a phone' : `Rename ${p?.label ?? 'the phone'}`)}<form class="m-body" novalidate>
        <label class="h4 g-label" for="m-phone-label">Name</label><div class="field"><input id="m-phone-label" name="label" class="grow-1" maxlength="40" required autocomplete="off" spellcheck="false" value="${esc(action === 'rename' ? p?.label ?? '' : '')}" placeholder="For example: Office phone"></div>
        <div class="m-foot"><button class="btn btn-ghost" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">${action === 'add' ? 'Add and link' : 'Save'}</button></div></form>`);
    const form = /** @type {HTMLFormElement} */ ($('form', m));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const label = String(new FormData(form).get('label') ?? '').trim();
      const path = action === 'add' ? '/whatsapp/phones' : `/whatsapp/phones/${p?.id}/rename`;
      post(path, { label })
        .then((r) => {
          closeDrawer(true);
          done();
          const phone = /** @type {{ phone?: { id?: number, label?: string } }} */ (r ?? {}).phone;
          if (action === 'add' && phone && Number.isInteger(phone.id)) linkWhatsApp(targetOf(/** @type {number} */ (phone.id)), { relink: false, label: phone.label ?? label });
          else toast('Saved.');
        })
        .catch(fail);
    });
    return;
  }
  if (!p) return;
  const main = p.id === 1;
  const what = action === 'unlink'
    ? `<p class="m-p">${main ? `<b>${esc(p.label)} is your main phone.</b> ` : ''}The agent logs ${esc(p.label)}${p.number ? ` (${esc(p.number)})` : ''} out of WhatsApp and stops reading it. Its messages, tasks and group approvals stay; its groups show as "phone unlinked" until you link it again or move them. The spare phone and the morning briefing are not affected.</p>`
    : `<p class="m-p">${esc(p.label)} is removed from the list, and its number can be used for a new phone.</p>`;
  const m = openModal(`${modalHead('WhatsApp phone', action === 'unlink' ? `Unlink ${p.label}?` : `Remove ${p.label}?`)}<div class="m-body">${what}
      <div class="m-foot"><button class="btn btn-ghost" type="button" data-close>Cancel</button><button class="btn btn-primary" type="button" data-confirm>${action === 'unlink' ? (main ? 'Unlink the main phone' : 'Unlink') : 'Remove'}</button></div></div>`);
  $('[data-confirm]', m).addEventListener('click', () => {
    post(`/whatsapp/phones/${p.id}/${action}`, { confirm: true })
      .then((r) => {
        closeDrawer(true);
        done();
        if (action === 'remove') toast(`${p.label} removed.`);
        else if (/** @type {{ loggedOut?: boolean }} */ (r ?? {}).loggedOut) toast(`${p.label} unlinked.`);
        else toast(`${p.label} unlinked here. WhatsApp did not answer: remove "WA Agent - Tracker" from the phone's Linked devices too.`, false);
      })
      .catch(fail);
  });
}

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
  if (c.kind === 'drive') return quickButton('upload-tracker', 'cloud', 'Upload tracker now');
  if (c.kind === 'claude') return quickButton('test-claude', 'flash', 'Test connection');
  if (c.state === 'off') return '<button class="btn btn-sm btn-ghost" type="button" disabled data-tip="Set up the heartbeat on the Mac first">' + icon('pulse', 15) + 'Send test beat</button>';
  return quickButton('test-heartbeat', 'pulse', 'Send test beat');
}


/**
 * The reading phones (when the agent lists them), then the other connections. With the phone list, phone 1's own card
 * is there, so the founder card is not shown twice.
 * @param {Card[] | null} cards @param {unknown} [error] @param {{ phones: PhoneRow[], max: number } | null} [phones]
 */
export function renderConnections(cards, error, phones = null) {
  if (!cards) return `<p class="loading">${error ? 'The connections could not be loaded. Trying again shortly.' : 'Loading the connections…'}</p>`;
  const shown = phones ? cards.filter((c) => c.kind !== 'founder') : cards;
  return (phones ? renderPhones(phones) : '') + otherConnections(shown);
}

/** @param {Card[]} cards */
function otherConnections(cards) {
  if (!cards.length) return '<p class="empty-note">No connections to show yet.</p>';
  const card = (/** @type {Card} */ c) => {
    const kind = /** @type {keyof typeof ICON} */ (c.kind);
    return `<article class="card conn" data-conn="${esc(c.id)}"${c.email ? ` data-email="${esc(c.email)}"` : ''}${c.meetings ? ' data-meetings="1"' : ''}><div class="top-row"><div class="badge">${icon(ICON[kind] ?? 'plug', 21)}</div>
        <div class="grow-1"><h3${c.email ? ` title="${esc(c.title)}"` : ''}>${esc(c.title)}</h3><div class="sub">${esc(c.subtitle)}</div></div>
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
  /** The reading phones; null until read, or when this agent has no phone list (the founder card is shown then). */
  /** @type {{ phones: PhoneRow[], max: number } | null} */
  let phones = null;
  const draw = () => ctx.redraw(notice + attentionBanner(/** @type {any} */ (ctx.status())) + renderConnections(cards, error, phones));
  const load = async () => {
    try {
      const [next, list] = await Promise.all([get('/connections'), get('/whatsapp/phones').catch(() => null)]);
      if (!ctx.live()) return;
      cards = readConnections(next);
      phones = list === null ? null : readPhones(list);
      error = null;
    } catch (e) {
      if (!ctx.live() || cards) return;
      error = e;
    }
    draw();
  };
  // The phone buttons (data-phone): each opens its dialog; a change reloads the list.
  const onClick = (/** @type {MouseEvent} */ e) => {
    const b = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest?.('[data-phone]'));
    if (!b || !ctx.live()) return;
    const id = Number(b.dataset.id);
    phoneDialog(b.dataset.phone ?? '', phones?.phones.find((p) => p.id === id), () => void load());
  };
  document.addEventListener('click', onClick);
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
  return () => {
    removeEventListener(CONNECTIONS_CHANGED, onChanged);
    document.removeEventListener('click', onClick);
  };
}
