// Clients (/dashboard/clients): one card per active client, and its drawer with open tasks and meetings. The Manage
// groups tab (/dashboard/clients/groups) is views/groups.js.
import { ApiError, get } from '../api.js';
import { readClientDetail, readClients } from '../contract.js';
import { esc, icon } from '../dom.js';
import { ago, clock, when } from '../format.js';
import { chatOpen, openChat, refreshChat } from './chat.js';
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
const updated = () => (trackerAt === undefined ? '' : trackerAt ? `Tracker updated ${ago(trackerAt)}` : 'Tracker not uploaded yet');
const SYNC_NOTE = 'The tracker also updates by itself after the agent reads new messages.';

/** Sync now: the upload-tracker quick action (same busy state, messages and limit as on Connections). */
const syncButton = () => quickButton('upload-tracker', 'refresh', 'Sync now');

/** The header's sync line, on the right of the tabs. */
const syncHead = () => `<div class="synch"><span class="sync-at" data-tip="${esc(SYNC_NOTE)}">${esc(updated())}</span>${syncButton()}</div>`;

/** The Clients / Manage groups tabs, with anything to show on their right. @param {string | null} sub @param {string} [right] */
const tabs = (sub, right = '') => `<div class="toolbar chead"><div class="seg" role="tablist" aria-label="Clients">
    <button type="button" role="tab" data-ctab="list" aria-selected="${sub !== 'groups'}" class="${sub !== 'groups' ? 'on' : ''}">Clients</button>
    <button type="button" role="tab" data-ctab="groups" aria-selected="${sub === 'groups'}" class="${sub === 'groups' ? 'on' : ''}">Manage groups</button></div>${right}</div>`;

/**
 * What the agent is doing with a client's group, in words (the card's status line and the drawer's):
 * reading its last 7 days, waiting to, reading new messages, watching, or up to date. Never a reason it cannot know.
 * @param {{ history: { state: string, found: number } | null, pending: number, quietMinutes: number, lastReadAt: string | null,
 *   lastActivity: string | null }} s
 * @param {'card' | 'panel'} where
 * @returns {{ head: string, rest: string, busy: boolean, quiet: boolean }}
 */
function statusFor(s, where) {
  const h = s.history?.state;
  if (h === 'reading' || h === 'fetching') return { head: 'Reading the last 7 days', rest: `${s.history?.found ?? 0} found`, busy: true, quiet: false };
  if (h === 'waiting') return { head: 'Waiting for the first new message to read earlier ones', rest: '', busy: false, quiet: false };
  if (s.pending > 0) return { head: 'Reading new messages', rest: `tasks update in about ${Math.ceil(s.quietMinutes)} min`, busy: true, quiet: false };
  if (!s.lastActivity) return { head: 'Watching for new messages', rest: 'nothing new yet', busy: false, quiet: false };
  if (where === 'panel' && s.lastReadAt) return { head: 'Watching for new messages', rest: `read ${ago(s.lastReadAt)}`, busy: false, quiet: false };
  return { head: 'Up to date', rest: `last message ${ago(s.lastActivity)}`, busy: false, quiet: true };
}

/** The status line's words: the head in bold, then the rest. @param {{ head: string, rest: string }} st */
const statusWords = (st) => `<b>${esc(st.head)}</b>${st.rest ? ` <span>· ${esc(st.rest)}</span>` : ''}`;

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
  const st = statusFor({ history: c.history, ...c.pulse, lastActivity: c.lastActivity }, 'card');
  return `<article class="card ccard${st.busy ? ' busy' : ''}" data-client="${esc(c.code)}" tabindex="0" role="button" aria-label="${esc(c.name)}, ${n.open} open, ${n.overdue} overdue">
      <div class="row"><div class="g-name"><h3>${esc(c.name)}</h3><div class="grp">${icon('bubble', 14)}<span class="t">${esc(c.groupName)}</span></div></div><span class="code">${esc(c.code)}</span></div>
      ${c.phases.length ? `<div class="phase">${c.phases.map((p, i) => `<i class="${i <= c.phaseIndex ? 'on' : ''}" data-tip="${esc(p)}"></i>`).join('')}</div>` : ''}
      <div class="nums"><div><b>${n.open}</b><small>Open</small></div><div><b class="${n.overdue ? 'od' : ''}">${n.overdue}</b><small>Overdue</small></div><div><b>${n.review}</b><small>Review</small></div></div>
      <div class="foot"><span>${c.currentPhase ? `Phase · ${esc(c.currentPhase)}` : 'No phase set'}</span><span>${c.lastActivity ? `Active ${esc(ago(c.lastActivity))}` : 'No messages yet'}</span></div>
      <div class="cstat${st.quiet ? ' ok' : ''}" role="status"><i class="dot" aria-hidden="true"></i><span>${statusWords(st)}</span></div></article>`;
}

/** The client whose panel is open (its code), for the poll to keep it current. */
let panelCode = /** @type {string | null} */ (null);

/** Redraws the open panel's body from /clients/:code, keeping where it was scrolled. @param {string} code */
async function refreshPanel(code) {
  const d = openDrawerElement();
  if (!d || panelCode !== code) return;
  try {
    const c = readClientDetail(await get(`/clients/${encodeURIComponent(code)}`));
    const body = d.querySelector('.dr-body');
    if (openDrawerElement() !== d || panelCode !== code || !body) return;
    const y = body.scrollTop;
    body.innerHTML = panelBody(c);
    body.scrollTop = y;
  } catch {
    // keeps what it shows; the next poll tries again
  }
}

/** Opens the client's drawer and fills it from /clients/:code. @param {string} code */
async function clientDrawer(code) {
  panelCode = code;
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
    body.innerHTML = panelBody(c);
    body.scrollTop = 0;
  }
  // The foot holds Close, Open chat and Open tracker; Sync now is at the end of the body.
  const foot = d.querySelector('.dr-foot');
  if (foot) {
    foot.insertAdjacentHTML('beforeend', `<button class="btn btn-ghost" type="button" data-open-chat>${icon('bubble', 16)}Open chat</button><button class="btn btn-primary" type="button" data-go="tracker">${icon('xls', 16)}Open tracker</button>`);
  }
  d.addEventListener('click', (e) => {
    // The chat replaces the panel; its Back brings the panel back.
    if (/** @type {Element} */ (e.target).closest('[data-open-chat]')) openChat(code, () => void clientDrawer(code));
  });
}

/** "0:42" from 42 seconds. @param {number} s */
const minutes = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const KIND_LABEL = /** @type {Record<string, string>} */ ({
  image: 'Photo', video: 'Video', document: 'File', sticker: 'Sticker', audio: 'Audio file', voice: 'Voice note', location: 'Location', contact: 'Contact',
  poll: 'Poll', event: 'Event', other: 'Message',
});
/** Today in India: just the time; another day: the day too. @param {string | null} iso */
const stamp = (iso) => (iso && new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) === todayIst() ? clock(iso) : when(iso));
const AV_TONES = ['', ' b', ' c'];

/** Up to two initials of a sender's name, for the bubble's avatar. @param {string} name */
const avatar = (name) => {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  const first = (/** @type {string} */ w) => Array.from(w)[0] ?? '';
  return (words.length > 1 ? first(words[0]) + first(words[1]) : Array.from(words[0] ?? '?').slice(0, 2).join('')).toUpperCase();
};
/** A steady colour per sender. @param {string} name */
const tone = (name) => AV_TONES[Array.from(name).reduce((n, ch) => n + (ch.codePointAt(0) ?? 0), 0) % AV_TONES.length];

/**
 * One of the latest messages: its text, or a tag for a voice note or file (never its content). The text is the group's
 * own words: through esc() only.
 * @param {ReturnType<typeof readClientDetail>['activity']['latest'][number]} m
 */
function bubble(m) {
  let line;
  if (m.kind === 'text') line = esc(m.text);
  else {
    const audio = m.kind === 'voice' || m.kind === 'audio';
    const bits = [KIND_LABEL[m.kind] ?? 'Message'];
    if (audio && m.seconds !== null) bits.push(minutes(m.seconds));
    if (audio) bits.push(m.transcribed ? 'transcribed' : 'not transcribed');
    line = `<span class="tag">${icon(audio ? 'mic' : 'file', 12)}${esc(bits.join(' · '))}</span>${m.text ? ` ${esc(m.text)}` : ''}`;
  }
  return `<div class="msg"><div class="av${tone(m.sender)}" aria-hidden="true">${esc(avatar(m.sender))}</div><div class="bub"><b>${esc(m.sender)}</b><p>${line}</p></div><time>${esc(stamp(m.at))}</time></div>`;
}

/** The earlier-messages row: the 7-day history read on approval. @param {ReturnType<typeof readClientDetail>['activity']['history']} h */
function earlier(h) {
  if (!h) return 'Not read';
  if (h.state === 'waiting') return 'Waiting for the first new message';
  if (h.state === 'fetching') return `Reading the last 7 days · ${h.found} found`;
  if (h.state === 'done') return `Last 7 days read · ${h.found} found`;
  return 'Stopped';
}

/** The drawer's body, top to bottom as designed. @param {ReturnType<typeof readClientDetail>} c */
function panelBody(c) {
  const a = c.activity;
  const st = statusFor({ history: a.history, pending: a.pending, quietMinutes: a.quietMinutes, lastReadAt: a.lastBatch?.at ?? null, lastActivity: c.lastActivity }, 'panel');
  const changes = a.lastBatch?.taskChanges ?? 0;
  const lastRead = a.lastBatch
    ? `Last read <b>${esc(stamp(a.lastBatch.at))}</b> · ${a.lastBatch.messages} message${a.lastBatch.messages === 1 ? '' : 's'} · <b>${changes ? `${changes} task change${changes === 1 ? '' : 's'}` : 'no new tasks'}</b>`
    : 'Not read yet';
  const w = a.week;
  return `<div class="status" role="status"><i class="dot" aria-hidden="true"></i><div>${statusWords(st)}</div></div>
    <div class="h4">This group, last 7 days</div>
    <div class="stats"><div><b>${w.messages}</b><small>messages read</small></div><div><b>${w.people}</b><small>people active</small></div>
      <div><b>${w.files}</b><small>files &amp; photos</small></div><div><b>${w.voice}</b><small>voice notes</small></div></div>
    <p class="lastread">${lastRead}</p>
    <div class="h4">Latest messages</div>
    ${a.latest.length ? `<div class="msgs">${a.latest.map(bubble).join('')}</div>` : '<p class="empty-note">No messages yet. They show up here once the group talks.</p>'}
    <div class="h4">Open tasks · ${c.openTasks.length}</div>
    ${c.openTasks.length ? `<div class="list">${c.openTasks.map((t) => `<div class="li"><div class="ic">${icon('task', 16)}</div><div><b>${esc(t.code)} · ${esc(t.title)}</b><small>${esc(t.assignedTo ?? 'Unassigned')} · ${t.deadline ? `due ${esc(day(t.deadline))}` : 'no deadline'}</small></div>${taskPill(t)}</div>`).join('')}</div>`
      : a.taskCount === 0
        ? `<div class="empty"><b>No tasks yet</b>Nothing in this group's messages has been a task so far. New ones show up here about ${Math.ceil(a.quietMinutes)} minutes after a conversation goes quiet.</div>`
        : '<p class="empty-note">No open tasks.</p>'}
    <div class="h4">Details</div>
    <dl class="kv"><dt>WhatsApp group</dt><dd>${esc(c.groupName)}</dd><dt>Tracker sheet</dt><dd>${esc(c.sheetName || '—')}</dd>
      <dt>Phase</dt><dd>${esc(c.currentPhase ?? 'Not set')}</dd><dt>Approved</dt><dd>${esc(a.approvedAt ? when(a.approvedAt) : 'Not recorded')}</dd>
      <dt>Earlier messages</dt><dd>${esc(earlier(a.history))}</dd></dl>
    <div class="h4">Meetings</div>
    ${c.meetings.length ? `<div class="list">${c.meetings.map((m) => `<div class="li"><div class="ic">${icon('video', 16)}</div><div><b>${esc(m.title)}</b><small>${esc(when(m.startedAt))}</small></div><span class="pill ${m.status === 'done' ? 'p-done' : 'p-warn'}"><i></i>${esc(MEETING_LABEL[m.status] ?? 'Unknown')}</span></div>`).join('')}</div>` : '<p class="empty-note">No meetings matched to this client yet.</p>'}
    <div class="syncline"><small class="sync-at">${esc(updated())}</small>${syncButton()}</div>`;
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
    const head = tabs(null, syncHead());
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
    if (btn) btn.outerHTML = syncButton();
  };
  addEventListener(CONNECTIONS_CHANGED, onSynced);
  ctx.poll(async () => {
    try {
      const [answer] = await Promise.all([get('/clients'), loadTrackerAt(), panelCode ? refreshPanel(panelCode) : undefined, chatOpen() ? refreshChat() : undefined]);
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
