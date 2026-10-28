// Clients (/dashboard/clients): one card per active client, and its drawer with open tasks and meetings. The Manage
// groups tab (/dashboard/clients/groups) is views/groups.js.
import { ApiError, get } from '../api.js';
import { readClientDetail, readClients } from '../contract.js';
import { esc, icon } from '../dom.js';
import { ago, when } from '../format.js';
import { CONNECTIONS_CHANGED, quickButton } from './connect.js';
import { openDrawer, openDrawerElement } from './drawer.js';
import { mountGroups } from './groups.js';

const CLIENTS_MS = 30_000;

/** The tracker's last successful upload (GET /tracker), for the Sync tracker now bars: undefined until the agent answers. */
let trackerAt = /** @type {string | null | undefined} */ (undefined);
const loadTrackerAt = async () => {
  try {
    const t = await get('/tracker');
    trackerAt = typeof t?.lastPublishedAt === 'string' && !Number.isNaN(Date.parse(t.lastPublishedAt)) ? t.lastPublishedAt : null;
  } catch {
    // keeps what it knew; nothing is claimed before the agent has answered
  }
};
const updated = () => (trackerAt === undefined ? '' : trackerAt ? `Updated ${ago(trackerAt)}` : 'Not uploaded yet');
const SYNC_NOTE = 'The tracker also updates by itself after the agent reads new messages.';

/** Sync tracker now: the upload-tracker quick action (same busy state, messages and limit as on Connections). */
const syncBar = () => `<div class="sync-bar">${quickButton('upload-tracker', 'refresh', 'Sync tracker now')}<span class="muted-note sync-at">${esc(updated())}</span>
    <span class="muted-note sync-note">${SYNC_NOTE}</span></div>`;

/** The Clients / Manage groups tabs. @param {string | null} sub */
const tabs = (sub) => `<div class="toolbar"><div class="seg" role="tablist" aria-label="Clients">
    <button type="button" role="tab" data-ctab="list" aria-selected="${sub !== 'groups'}" class="${sub !== 'groups' ? 'on' : ''}">Clients</button>
    <button type="button" role="tab" data-ctab="groups" aria-selected="${sub === 'groups'}" class="${sub === 'groups' ? 'on' : ''}">Manage groups</button></div></div>`;

/** "29 Oct" from "2026-10-29" (deadlines are dates). @param {string | null} d */
const day = (d) => {
  if (!d || !/^\d{4}-\d{2}-\d{2}/.test(d)) return 'no deadline';
  const [y, m, dd] = d.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' });
};
/** Today in India as YYYY-MM-DD. */
const todayIst = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

/** @param {{ status: string, deadline: string | null }} t */
function taskPill(t) {
  if (t.status === 'maybe_done') return '<span class="pill p-warn"><i></i>Needs review</span>';
  if (t.deadline && t.deadline.slice(0, 10) < todayIst()) return '<span class="pill p-overdue"><i></i>Overdue</span>';
  return '<span class="pill p-open"><i></i>Open</span>';
}

// The meeting statuses (src/store/meetings.ts) in words.
const MEETING_LABEL = /** @type {Record<string, string>} */ ({
  unassigned: 'Needs a client', internal: 'Internal', queued: 'Queued', done: 'Summarised', skipped: 'Skipped', too_long: 'Too long',
  no_access: 'No access', failed: 'Failed',
});

/** @param {ReturnType<typeof readClients>[number]} c */
function card(c) {
  const n = c.counts;
  return `<article class="card ccard" data-client="${esc(c.code)}" tabindex="0" role="button" aria-label="${esc(c.name)}, ${n.open} open, ${n.overdue} overdue">
      <div class="row"><div class="g-name"><h3>${esc(c.name)}</h3><div class="grp">${icon('bubble', 14)}<span class="t">${esc(c.groupName)}</span></div></div><span class="code">${esc(c.code)}</span></div>
      ${c.phases.length ? `<div class="phase">${c.phases.map((p, i) => `<i class="${i <= c.phaseIndex ? 'on' : ''}" data-tip="${esc(p)}"></i>`).join('')}</div>` : ''}
      <div class="nums"><div><b>${n.open}</b><small>Open</small></div><div><b class="${n.overdue ? 'od' : ''}">${n.overdue}</b><small>Overdue</small></div><div><b>${n.review}</b><small>Review</small></div></div>
      <div class="foot"><span>${c.currentPhase ? `Phase · ${esc(c.currentPhase)}` : 'No phase set'}</span><span>${c.lastActivity ? `Active ${esc(ago(c.lastActivity))}` : 'No messages yet'}</span></div></article>`;
}

/** Opens the client's drawer and fills it from /clients/:code. @param {string} code */
async function clientDrawer(code) {
  const d = openDrawer(`<div class="dr-head"><div><span class="code">${esc(code)}</span><h2>Loading…</h2></div><button class="icon-btn" type="button" data-close aria-label="Close">${icon('close', 18)}</button></div>
    <div class="dr-body"><p class="loading">Loading the client…</p></div><div class="dr-foot"><button class="btn btn-ghost" type="button" data-close>Close</button></div>`);
  let c;
  try {
    c = readClientDetail(await get(`/clients/${encodeURIComponent(code)}`));
  } catch (e) {
    if (openDrawerElement() !== d) return;
    const body = d.querySelector('.dr-body');
    if (body) body.innerHTML = `<p class="loading">${esc(e instanceof ApiError ? e.message : 'The client could not be loaded.')}</p>`;
    return;
  }
  if (openDrawerElement() !== d) return;
  const h2 = d.querySelector('h2');
  if (h2) h2.textContent = c.name;
  const body = d.querySelector('.dr-body');
  if (body) {
    body.innerHTML = `<dl class="kv"><dt>WhatsApp group</dt><dd>${esc(c.groupName)}</dd><dt>Tracker sheet</dt><dd>${esc(c.sheetName || '—')}</dd>
        <dt>Phase</dt><dd>${esc(c.currentPhase ?? 'Not set')}</dd><dt>Last activity</dt><dd>${esc(c.lastActivity ? ago(c.lastActivity) : 'No messages yet')}</dd>
        <dt>Last sync</dt><dd>${esc(c.lastSyncAt ? ago(c.lastSyncAt) : 'Not yet')}</dd></dl>
      <div class="h4">Open tasks · ${c.openTasks.length}</div>
      ${c.openTasks.length ? `<div class="list">${c.openTasks.map((t) => `<div class="li"><div class="ic">${icon('task', 16)}</div><div><b>${esc(t.code)} · ${esc(t.title)}</b><small>${esc(t.assignedTo ?? 'Unassigned')} · ${t.deadline ? `due ${esc(day(t.deadline))}` : 'no deadline'}</small></div>${taskPill(t)}</div>`).join('')}</div>` : '<div class="empty">No open tasks.</div>'}
      <div class="h4">Meetings</div>
      ${c.meetings.length ? `<div class="list">${c.meetings.map((m) => `<div class="li"><div class="ic">${icon('video', 16)}</div><div><b>${esc(m.title)}</b><small>${esc(when(m.startedAt))}</small></div><span class="pill ${m.status === 'done' ? 'p-done' : 'p-warn'}"><i></i>${esc(MEETING_LABEL[m.status] ?? 'Unknown')}</span></div>`).join('')}</div>` : '<div class="empty">No meetings matched to this client yet.</div>'}`;
    body.scrollTop = 0;
  }
  const foot = d.querySelector('.dr-foot');
  if (foot) foot.insertAdjacentHTML('beforeend', `<button class="btn btn-primary" type="button" data-go="tracker">${icon('xls', 16)}Open tracker</button>`);
  // Sync tracker now, as in the Clients header.
  if (foot) foot.insertAdjacentHTML('beforeend', `${quickButton('upload-tracker', 'refresh', 'Sync tracker now')}<span class="muted-note sync-at">${esc(updated())}</span><span class="muted-note sync-note">${SYNC_NOTE}</span>`);
}

/** @param {import('./registry.js').ScreenCtx} ctx @returns {(() => void) | void} */
export function mountClients(ctx) {
  const { view } = ctx;
  /** @param {Event} e */
  const onTab = (e) => {
    const b = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest('[data-ctab]'));
    if (b && view.contains(b)) ctx.go('clients', b.dataset.ctab === 'groups' ? 'groups' : null);
  };
  view.addEventListener('click', onTab);
  if (ctx.sub === 'groups') {
    const stop = mountGroups(ctx, tabs('groups'));
    return () => {
      stop();
      view.removeEventListener('click', onTab);
    };
  }

  /** @type {ReturnType<typeof readClients> | null} */
  let clients = null;
  /** @type {unknown} */
  let error = null;
  const draw = () => {
    const head = tabs(null) + syncBar();
    if (!clients) {
      ctx.redraw(`${head}<p class="loading">${error ? esc(error instanceof ApiError ? error.message : 'The clients could not be loaded. Trying again shortly.') : 'Loading the clients…'}</p>`);
      return;
    }
    if (clients.length === 0) {
      ctx.redraw(`${head}<div class="card empty-card"><p class="empty-note">No clients yet. Approve a client's WhatsApp group to start tracking it.</p>
        <button class="btn btn-primary btn-sm" type="button" data-ctab="groups">Manage groups</button></div>`);
      return;
    }
    ctx.redraw(`${head}<p class="muted-note">${clients.length} active client${clients.length === 1 ? '' : 's'} · one WhatsApp group each</p><div class="ccards">${clients.map(card).join('')}</div>`);
  };
  /** @param {Event} e */
  const onOpen = (e) => {
    if (e instanceof KeyboardEvent && e.key !== 'Enter' && e.key !== ' ') return;
    const el = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest('[data-client]'));
    if (!el || !view.contains(el)) return;
    e.preventDefault();
    void clientDrawer(el.dataset.client ?? '');
  };
  view.addEventListener('click', onOpen);
  view.addEventListener('keydown', onOpen);
  draw();
  // After a sync (here or on Connections): the new upload time, here and in an open drawer.
  const onSynced = async () => {
    await loadTrackerAt();
    if (!ctx.live()) return;
    draw();
    const drawer = openDrawerElement();
    const at = drawer?.querySelector('.sync-at');
    if (at) at.textContent = updated();
    // Its button too: it may have been drawn busy while the header's sync ran.
    const btn = drawer?.querySelector('[data-action="upload-tracker"]');
    if (btn) btn.outerHTML = quickButton('upload-tracker', 'refresh', 'Sync tracker now');
  };
  addEventListener(CONNECTIONS_CHANGED, onSynced);
  ctx.poll(async () => {
    try {
      const [answer] = await Promise.all([get('/clients'), loadTrackerAt()]);
      const next = readClients(answer);
      if (!ctx.live()) return;
      clients = next;
      error = null;
    } catch (e) {
      if (!ctx.live() || clients) return;
      error = e;
    }
    draw();
  }, CLIENTS_MS);
  return () => {
    removeEventListener(CONNECTIONS_CHANGED, onSynced);
    view.removeEventListener('click', onTab);
    view.removeEventListener('click', onOpen);
    view.removeEventListener('keydown', onOpen);
  };
}
