// Connections (status only in this update): one card per connection with its real state. The action buttons show but
// are disabled until the next update; nothing here pretends to do anything.
import { esc, icon } from '../dom.js';

/** @typedef {ReturnType<typeof import('../contract.js').readConnections>[number]} Card */

const ICON = { founder: 'bubble', spare: 'phone', google: 'mail', drive: 'folder', claude: 'ai', monitoring: 'pulse' };
const ACTION = {
  founder: ['refresh', 'Reconnect'],
  spare: ['phone', 'Link phone'],
  google: ['refresh', 'Reconnect'],
  drive: ['cloud', 'Upload tracker now'],
  claude: ['flash', 'Test connection'],
  monitoring: ['pulse', 'Send test beat'],
};
const PILL = { ok: 'p-done', warn: 'p-warn', down: 'p-overdue', off: 'p-muted' };
const DEFAULT_LABEL = { ok: 'Connected', warn: 'Needs attention', down: 'Disconnected', off: 'Off' };

const later = (/** @type {string} */ ic, /** @type {string} */ label) =>
  `<button class="btn btn-sm btn-ghost" type="button" disabled title="Available in the next update" data-tip="Available in the next update">${icon(ic, 15)}${esc(label)}</button>`;

/** @param {Card[] | null} cards @param {unknown} [error] */
export function renderConnections(cards, error) {
  if (!cards) return `<p class="loading">${error ? 'The connections could not be loaded. Trying again shortly.' : 'Loading the connections…'}</p>`;
  if (!cards.length) return '<p class="empty-note">No connections to show yet.</p>';
  const card = (/** @type {Card} */ c) => {
    const kind = /** @type {keyof typeof ICON} */ (c.kind);
    const [aic, alabel] = ACTION[kind] ?? ['refresh', 'Reconnect'];
    return `<article class="card conn" data-conn="${esc(c.id)}"><div class="top-row"><div class="badge">${icon(ICON[kind] ?? 'plug', 21)}</div>
        <div class="grow-1"><h3>${esc(c.title)}</h3><div class="sub">${esc(c.subtitle)}</div></div>
        <span class="pill ${PILL[c.state]}"><i></i>${esc(c.stateLabel || DEFAULT_LABEL[c.state])}</span></div>
      <dl class="kv">${c.rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
      ${c.note ? `<div class="note">${icon('info', 16)}<span>${esc(c.note)}</span></div>` : ''}
      <div class="conn-act">${later(aic, alabel)}</div></article>`;
  };
  return `<div class="toolbar"><span class="grow-1"></span>${later('mail', 'Add Google account')}</div>
    <div class="conns">${cards.map(card).join('')}</div>
    <p class="muted-note">Every reconnect runs inside the agent on the Mac. Sign-in tokens and keys stay there and are never shown here. Each action is recorded in Audit logs.</p>`;
}
