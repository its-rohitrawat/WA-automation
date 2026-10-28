// Manage groups (/dashboard/clients/groups): which of the founder's WhatsApp groups the agent works with. Built for
// hundreds of groups: the agent searches, the list draws 60 rows at a time as it scrolls, and changes collect in a
// save bar until one Save sends them all (POST /groups/apply). Desktop has the two boards with drag and drop (and
// buttons on every row); phones get one list with switches. Group names are WhatsApp text: shown through esc() only.
import { ApiError, get, post } from '../api.js';
import { readGroups } from '../contract.js';
import { $, $$, esc, gsap, icon, reduceMotion, toast } from '../dom.js';
import { when } from '../format.js';
import { closeDrawer, openDrawer, openDrawerElement } from './drawer.js';
import { NAME_MAX, fieldProblem } from './rules.js';

const BATCH = 60;
const SEARCH_DEBOUNCE_MS = 150;
const CODE = /^[A-Z]{3,4}$/;

/**
 * @typedef {import('../contract.js').GroupRow} GroupRow
 * @typedef {{ kind: 'approve', name: string, code: string, emailDomains: string[], meetingKeywords: string[] }
 *   | { kind: 'unapprove' }
 *   | { kind: 'edit', name: string, emailDomains: string[], meetingKeywords: string[] }} Change
 */

// Kept across visits to the screen (not across sign-out): unsaved changes survive a look at another screen.
/** @type {Map<string, Change>} */
const pending = new Map();
/** The latest row the agent sent for each key, so a change can be drawn and saved while its row is filtered out. */
/** @type {Map<string, GroupRow>} */
const known = new Map();

/** Forgets everything (on sign-out). */
export function resetGroups() {
  pending.clear();
  known.clear();
}

addEventListener('beforeunload', (e) => {
  if (pending.size > 0) e.preventDefault();
});

/** @param {GroupRow} row */
const isApproved = (row) => {
  const c = pending.get(row.key);
  return c ? c.kind !== 'unapprove' : row.approved;
};

/** The client name shown for a row (a pending approval or edit wins). @param {GroupRow} row */
const shownName = (row) => {
  const c = pending.get(row.key);
  if (c && c.kind !== 'unapprove') return c.name;
  return row.approved && row.client ? row.client.name : row.name;
};

/** @param {GroupRow} row */
const shownCode = (row) => {
  const c = pending.get(row.key);
  if (c?.kind === 'approve') return c.code;
  return row.client?.code ?? '';
};

/** "Desai Foods x Studio" → "Desai Foods": the client's side of a shared group's name. @param {string} name */
const clientPart = (name) => (name.split(/\s+[x×–-]\s+/i)[0]?.trim() || name.trim()).slice(0, NAME_MAX);

/** "iyer, dental website" → ['iyer', 'dental website']. @param {string} text */
const list = (text) => text.split(',').map((s) => s.trim()).filter(Boolean);

/** @param {string[]} a @param {string[]} b */
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Mounts the screen. @param {import('./registry.js').ScreenCtx} ctx @param {string} toolbar the Clients/Manage groups tabs
 * @returns {() => void}
 */
export function mountGroups(ctx, toolbar) {
  const { view } = ctx;
  let q = '';
  let filter = /** @type {'all'|'approved'|'not_approved'} */ ('all');
  /** @type {ReturnType<typeof readGroups> | null} */
  let data = null;
  /** @type {unknown} */
  let loadError = null;
  let request = 0;
  let saving = false;
  /** @type {IntersectionObserver[]} */
  let observers = [];
  const phone = matchMedia('(max-width: 960px)');

  view.innerHTML = `${toolbar}
    <div id="g-stale"></div>
    <div class="toolbar">
      <label class="field grow-1 g-search"><span class="sr-only">Search groups</span>${icon('search', 16)}<input id="g-q" type="search" placeholder="Search groups or clients" autocomplete="off" maxlength="200"></label>
      <div class="seg" role="group" aria-label="Show" id="g-filter"></div>
      <button class="btn btn-ghost btn-sm" type="button" id="g-refresh" data-tip="Ask WhatsApp for the group list again">${icon('refresh', 15)}Refresh</button>
    </div>
    <p class="muted-note" id="g-hint"></p>
    <div id="g-lists" aria-live="polite"><p class="loading">Loading the groups…</p></div>
    <div id="g-savebar"></div>`;

  const input = /** @type {HTMLInputElement} */ ($('#g-q', view));
  const params = new URLSearchParams(location.search);
  q = (params.get('q') ?? '').slice(0, 200);
  const f = params.get('filter');
  if (f === 'approved' || f === 'not_approved') filter = f;
  input.value = q;

  /** Keeps the search and filter in the address, so a reload or a shared link shows the same list. */
  const keepInAddress = () => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (filter !== 'all') p.set('filter', filter);
    const s = p.toString();
    history.replaceState(null, '', location.pathname + (s ? `?${s}` : ''));
  };

  /** @param {boolean} [refresh] */
  async function load(refresh = false) {
    const mine = ++request;
    const p = new URLSearchParams({ filter: 'all' });
    if (q) p.set('q', q);
    if (refresh) p.set('refresh', '1');
    try {
      const next = readGroups(await get(`/groups?${p}`));
      if (!ctx.live() || mine !== request) return;
      data = next;
      loadError = null;
      for (const row of next.rows) known.set(row.key, row);
    } catch (e) {
      if (!ctx.live() || mine !== request) return;
      loadError = e;
    }
    draw();
  }

  /** The counts over every group, with the unsaved changes applied. */
  function counts() {
    if (!data) return null;
    let approved = data.counts.approved;
    for (const [key, c] of pending) {
      const was = known.get(key)?.approved ?? false;
      if (c.kind === 'approve' && !was) approved++;
      if (c.kind === 'unapprove' && was) approved--;
    }
    return { all: data.counts.all, approved, notApproved: data.counts.all - approved };
  }

  function draw() {
    drawStale();
    drawFilter();
    drawLists();
    drawSavebar();
  }

  function drawStale() {
    const box = $('#g-stale', view);
    if (!data?.stale) {
      box.innerHTML = '';
      return;
    }
    const head = data.reason === 'list_failed' ? "WhatsApp didn't send the group list" : "WhatsApp isn't connected";
    const detail = data.fetchedAt ? `Showing the last list, from ${when(data.fetchedAt)}.` : 'No group list has been fetched yet.';
    box.innerHTML = `<div class="attn" role="status">${icon('alert', 20)}<div class="grow-1"><b>${esc(head)}</b><div>${esc(detail)}</div></div>
      <button class="btn btn-primary btn-sm" type="button" data-go="connections">Open Connections</button></div>`;
  }

  function drawFilter() {
    const c = counts();
    const chip = (/** @type {string} */ id, /** @type {string} */ label, /** @type {number | undefined} */ n) =>
      `<button type="button" data-filter="${id}" class="${filter === id ? 'on' : ''}" aria-pressed="${filter === id}">${esc(label)}${n === undefined ? '' : ` <span class="mono">${n}</span>`}</button>`;
    $('#g-filter', view).innerHTML = chip('all', 'All', c?.all) + chip('approved', 'Approved', c?.approved) + chip('not_approved', 'Not approved', c?.notApproved);
    $('#g-hint', view).textContent = phone.matches ? 'Switch a group on to start tracking it.' : 'Drag a group to the right, or press Approve, to start tracking it.';
  }

  /** The rows to draw: the agent's answer for this search, with the filter applied to the unsaved state. */
  function rows() {
    if (!data) return [];
    const r = data.rows.map((row) => known.get(row.key) ?? row);
    if (filter === 'approved') return r.filter(isApproved);
    if (filter === 'not_approved') return r.filter((row) => !isApproved(row));
    return r;
  }

  /** @param {GroupRow} row */
  function subline(row) {
    const c = pending.get(row.key);
    const bits = [];
    if (isApproved(row) && shownName(row) !== row.name) bits.push(row.name);
    if (!row.inWhatsApp) bits.push('No longer in WhatsApp');
    else if (row.approved && row.client && !row.client.active && !c) bits.push('Starts within 2 seconds');
    if (c) bits.push(c.kind === 'approve' ? 'Not saved: will be tracked' : c.kind === 'unapprove' ? 'Not saved: will stop' : 'Not saved: edited');
    return bits.length ? `<small>${esc(bits.join(' · '))}</small>` : '';
  }

  /** A row on a desktop board. @param {GroupRow} row */
  function boardRow(row) {
    const on = isApproved(row);
    const code = shownCode(row);
    return `<div class="grow g-row${pending.has(row.key) ? ' changed' : ''}" draggable="true" data-key="${esc(row.key)}">
      <span class="g-handle" aria-hidden="true">${icon('drag', 16)}</span>
      <div class="g-name">${on ? `<button type="button" class="link-btn t" data-edit="${esc(row.key)}" data-tip="Edit the client">${esc(shownName(row))}</button>` : `<div class="t">${esc(row.name)}</div>`}${subline(row)}</div>
      <div class="g-act">${on && code ? `<span class="code">${esc(code)}</span>` : ''}${on
        ? `<button class="btn btn-ghost btn-sm" type="button" data-remove="${esc(row.key)}" aria-label="Stop tracking ${esc(shownName(row))}">Remove</button>`
        : `<button class="btn btn-ghost btn-sm" type="button" data-approve="${esc(row.key)}" aria-label="Approve ${esc(row.name)}">Approve</button>`}</div></div>`;
  }

  /** A row on the phone list. @param {GroupRow} row */
  function phoneRow(row) {
    const on = isApproved(row);
    const code = shownCode(row);
    return `<div class="li g-row${pending.has(row.key) ? ' changed' : ''}" data-key="${esc(row.key)}"><div class="ic">${icon('bubble', 16)}</div>
      <div class="g-name">${on ? `<button type="button" class="link-btn" data-edit="${esc(row.key)}"><b>${esc(shownName(row))}</b></button>` : `<b>${esc(row.name)}</b>`}${on && code ? `<small>${esc(code)} · tracked</small>` : ''}${subline(row)}</div>
      <button class="switch" type="button" role="switch" aria-checked="${on}" aria-label="Track ${esc(on ? shownName(row) : row.name)}" data-toggle="${esc(row.key)}"></button></div>`;
  }

  /**
   * Draws rows into a container 60 at a time: the next batch when the end of the list scrolls into view.
   * `first` rows are drawn at once (after a change, as many as were showing, so the list does not jump back).
   * @param {HTMLElement} box @param {GroupRow[]} items @param {(r: GroupRow) => string} html @param {string} empty @param {number} first
   */
  function batched(box, items, html, empty, first) {
    if (items.length === 0) {
      box.insertAdjacentHTML('beforeend', `<div class="empty">${esc(empty)}</div>`);
      return;
    }
    let shown = 0;
    const sentinel = document.createElement('div');
    sentinel.className = 'g-more';
    const more = (n = BATCH) => {
      sentinel.insertAdjacentHTML('beforebegin', items.slice(shown, shown + n).map(html).join(''));
      shown = Math.min(items.length, shown + n);
      sentinel.textContent = shown < items.length ? `Showing ${shown} of ${items.length}…` : '';
      if (shown >= items.length) io.disconnect();
    };
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) more();
    }, { rootMargin: '400px' });
    box.append(sentinel);
    observers.push(io);
    more(Math.max(BATCH, first));
    if (shown < items.length) io.observe(sentinel);
  }

  function drawLists() {
    for (const o of observers) o.disconnect();
    observers = [];
    const box = $('#g-lists', view);
    // As many rows as each list showed before, and the same scroll position.
    const before = $$('.g-board-rows, .g-phone', box).map((el) => el.querySelectorAll('.g-row').length);
    const y = scrollY;
    restoreScroll(y);
    if (!data) {
      box.innerHTML = loadError ? `<p class="loading">${esc(loadError instanceof ApiError ? loadError.message : 'The groups could not be loaded.')} <button class="btn btn-ghost btn-sm" type="button" id="g-retry">Try again</button></p>` : '<p class="loading">Loading the groups…</p>';
      return;
    }
    const all = rows();
    const more = data.total > data.rows.length ? `<p class="muted-note">Showing the first ${data.rows.length} of ${data.total}. Search to find the others.</p>` : '';
    if (phone.matches) {
      box.innerHTML = `${more}<div class="card phone-list g-phone"></div>`;
      batched($('.g-phone', box), all, phoneRow, q ? 'No group matches this search.' : 'No groups to show.', Math.max(0, ...before));
      return;
    }
    const on = all.filter(isApproved);
    const off = all.filter((r) => !isApproved(r));
    box.innerHTML = `${more}<div class="boards">
      <section class="card board" data-zone="off" aria-label="Not tracked"><div class="card-head"><h3>All WhatsApp groups</h3><span class="mono muted-note">${off.length}</span></div><div class="g-board-rows"></div></section>
      <section class="card board on" data-zone="on" aria-label="Tracked"><div class="card-head"><h3>Agent works with</h3><span class="mono muted-note">${on.length}</span></div><div class="g-board-rows"></div><div class="empty g-drop">Drop a group here to start tracking it.</div></section></div>`;
    const [offBox, onBox] = $$('.g-board-rows', box);
    batched(offBox, off, boardRow, q ? 'No untracked group matches this search.' : 'Every group is tracked.', before[0] ?? 0);
    batched(onBox, on, boardRow, q ? 'No tracked group matches this search.' : 'No group is tracked yet.', before[1] ?? 0);
  }

  /** Puts the page back where it was once the new rows are in. @param {number} y */
  function restoreScroll(y) {
    requestAnimationFrame(() => {
      if (ctx.live() && Math.abs(scrollY - y) > 1) scrollTo({ top: y });
    });
  }

  function drawSavebar() {
    const slot = $('#g-savebar', view);
    const n = pending.size;
    const had = slot.childElementCount > 0;
    if (n === 0) {
      slot.innerHTML = '';
      return;
    }
    slot.innerHTML = `<div class="savebar" role="region" aria-label="Unsaved changes"><span>${n} change${n === 1 ? '' : 's'} not saved</span>
      <button class="btn btn-sm btn-plain" type="button" id="g-undo">${icon('undo', 15)}Undo</button><button class="btn btn-primary btn-sm" type="button" id="g-save"${saving ? ' disabled' : ''}>${saving ? 'Saving…' : 'Save'}</button></div>`;
    if (!had && gsap && !reduceMotion) gsap.from($('.savebar', slot), { y: 30, autoAlpha: 0, duration: 0.35, ease: 'expo.out' });
  }

  /** @param {string} key */
  const rowFor = (key) => known.get(key) ?? null;

  /** Stops tracking a group (or drops its unsaved approval). @param {GroupRow} row */
  function remove(row) {
    if (row.approved) pending.set(row.key, { kind: 'unapprove' });
    else pending.delete(row.key);
    draw();
  }

  /**
   * The approve (or edit) drawer for a group. `error` is the agent's message after a refused save.
   * @param {GroupRow} row @param {string} [error]
   */
  function groupDrawer(row, error = '') {
    const change = pending.get(row.key);
    // An approved group (also one with an unsaved removal, switched back on) is edited, not approved again.
    const editing = row.approved;
    const client = row.client;
    const locked = Boolean(client?.codeLocked);
    const startName = (change && change.kind !== 'unapprove' ? change.name : client?.name || clientPart(row.name)).slice(0, NAME_MAX);
    const startCode = change?.kind === 'approve' ? change.code : client?.code ?? '';
    const startWords = change && change.kind !== 'unapprove' ? change.meetingKeywords : client?.meetingKeywords ?? [];
    const startDomains = change && change.kind !== 'unapprove' ? change.emailDomains : client?.emailDomains ?? [];
    const d = openDrawer(`<div class="dr-head"><div><span class="eyebrow">${editing ? 'Edit client' : 'Track this group'}</span><h2>${esc(row.name)}</h2></div>
        <button class="icon-btn" type="button" data-close aria-label="Close">${icon('close', 18)}</button></div>
      <form class="dr-body" id="g-form" novalidate>
        <p class="g-error" role="alert"${error ? '' : ' hidden'}>${esc(error)}</p>
        <label class="h4 g-label" for="g-name">Client name</label>
        <div class="field"><input id="g-name" class="grow-1" maxlength="80" required autocomplete="off" value="${esc(startName)}"></div>
        <label class="h4 g-label" for="g-code">Code</label>
        <div class="field g-code-field"><input id="g-code" class="mono grow-1 g-code" maxlength="4" autocomplete="off" spellcheck="false" value="${esc(startCode)}"${locked || editing ? ' readonly' : ''}></div>
        <p class="muted-note" id="g-code-note">${locked || editing
          ? `${editing ? 'This client' : 'This group was a client before, so it'} keeps its code: every task number starts with it, like <b class="mono">${esc(startCode)}-001</b>.`
          : `3–4 capital letters. Every task number for this client starts with it, like <b class="mono" id="g-eg">${esc(startCode || 'SHA')}-001</b>. It can't be changed once the client has tasks.`}</p>
        <details${startWords.length || startDomains.length ? ' open' : ''}><summary class="g-more-toggle">More: meeting matching</summary>
          <label class="h4 g-label" for="g-words">Meeting keywords</label><div class="field"><input id="g-words" class="grow-1" autocomplete="off" placeholder="iyer, dental website" value="${esc(startWords.join(', '))}"></div>
          <label class="h4 g-label" for="g-domains">Client email domains</label><div class="field"><input id="g-domains" class="grow-1" autocomplete="off" placeholder="iyerdental.in" value="${esc(startDomains.join(', '))}"></div>
          <p class="muted-note">Separate several with commas. A meeting is matched to this client when its title has a keyword or a guest's email is on one of these domains.</p></details>
        ${editing ? '' : `<div class="note">${icon('info', 16)}<span>From now on the agent reads this group's new messages, and its earlier ones up to 7 days back, as far as WhatsApp provides.</span></div>`}
      </form>
      <div class="dr-foot"><button class="btn btn-ghost" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit" form="g-form">${editing ? 'Keep changes' : 'Add client'}</button></div>`);

    const name = /** @type {HTMLInputElement} */ ($('#g-name', d));
    const code = /** @type {HTMLInputElement} */ ($('#g-code', d));
    const err = $('.g-error', d);
    const showError = (/** @type {string} */ msg) => {
      err.textContent = msg;
      err.hidden = !msg;
    };
    let typedCode = Boolean(startCode);
    let suggestRun = 0;
    const suggest = async () => {
      if (locked || editing || typedCode) return;
      const mine = ++suggestRun;
      try {
        const r = await get(`/groups/suggest-code?name=${encodeURIComponent(name.value.trim().slice(0, 80))}`);
        if (mine !== suggestRun || typedCode || openDrawerElement() !== d) return;
        code.value = typeof r?.code === 'string' && CODE.test(r.code) ? r.code : '';
        const eg = $('#g-eg', d);
        if (eg) eg.textContent = `${code.value || 'SHA'}-001`;
      } catch {
        // the owner types a code
      }
    };
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let nameTimer;
    name.addEventListener('input', () => {
      clearTimeout(nameTimer);
      nameTimer = setTimeout(() => void suggest(), 300);
    });
    code.addEventListener('input', () => {
      typedCode = true;
      code.value = code.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
      const eg = $('#g-eg', d);
      if (eg) eg.textContent = `${code.value || 'SHA'}-001`;
    });
    if (!startCode) void suggest();

    $('#g-form', d).addEventListener('submit', (e) => {
      e.preventDefault();
      const n = name.value.trim();
      const words = list(/** @type {HTMLInputElement} */ ($('#g-words', d)).value);
      const domains = list(/** @type {HTMLInputElement} */ ($('#g-domains', d)).value).map((x) => x.toLowerCase());
      const problem = fieldProblem({ name: n, keywords: words, domains });
      if (problem) return showError(problem);
      if (editing) {
        const before = client ? { name: client.name, words: client.meetingKeywords, domains: client.emailDomains } : null;
        // Unchanged fields drop the change (and an unsaved removal: the group stays tracked as it was).
        if (before && before.name === n && sameList(before.words, words) && sameList(before.domains, domains)) pending.delete(row.key);
        else pending.set(row.key, { kind: 'edit', name: n, emailDomains: domains, meetingKeywords: words });
      } else {
        const c = code.value.trim();
        if (!CODE.test(c)) return showError('The code is 3 or 4 capital letters, like SHA.');
        const clash = locked ? undefined : codeOwner(c, row.key);
        if (clash) return showError(`${c} is already ${clash}. Choose another code.`);
        pending.set(row.key, { kind: 'approve', name: n, code: c, emailDomains: domains, meetingKeywords: words });
      }
      closeDrawer();
      draw();
    });
  }

  /**
   * Who already has this code, in words, or undefined: a client in the list (tracked or not) or another unsaved approval.
   * @param {string} code @param {string} key the group being approved
   */
  function codeOwner(code, key) {
    for (const [k, c] of pending) if (k !== key && c.kind === 'approve' && c.code === code) return 'taken by another group you are adding';
    for (const r of known.values()) if (r.key !== key && r.client?.code === code) return `used by ${r.client.name}`;
    return undefined;
  }

  async function save() {
    if (saving) return;
    // What this save sends. Changes made while it runs stay pending for the next save.
    const sent = new Map(pending);
    /** @type {{ approve: object[], unapprove: string[], edit: object[] }} */
    const body = { approve: [], unapprove: [], edit: [] };
    for (const [key, c] of sent) {
      if (c.kind === 'approve') body.approve.push({ key, name: c.name, code: c.code, emailDomains: c.emailDomains, meetingKeywords: c.meetingKeywords });
      else if (c.kind === 'unapprove') body.unapprove.push(key);
      else body.edit.push({ key, name: c.name, emailDomains: c.emailDomains, meetingKeywords: c.meetingKeywords });
    }
    saving = true;
    drawSavebar();
    try {
      await post('/groups/apply', body);
      for (const [key, c] of sent) if (pending.get(key) === c) pending.delete(key);
      toast('Saved. The agent picks up the new groups within 2 seconds.');
    } catch (e) {
      if (!ctx.live()) return;
      const key = e instanceof ApiError && typeof e.details.key === 'string' ? e.details.key : null;
      const row = key ? rowFor(key) : null;
      // A refused approval or edit opens that group's form with the reason; anything else is a notice.
      if (e instanceof ApiError && (e.status === 422 || e.status === 400) && row && pending.get(row.key)?.kind !== 'unapprove') groupDrawer(row, e.message);
      else toast(e instanceof ApiError ? e.message : 'Saving did not work. Try again.');
      return;
    } finally {
      saving = false;
      if (ctx.live()) drawSavebar();
    }
    if (ctx.live()) await load();
  }

  // ---------- events ----------
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let searchTimer;
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      q = input.value.trim().slice(0, 200);
      keepInAddress();
      void load();
    }, SEARCH_DEBOUNCE_MS);
  });
  /** @param {Event} e */
  const onClick = (e) => {
    const t = /** @type {Element} */ (e.target);
    const el = /** @type {HTMLElement | null} */ (t.closest('[data-filter],[data-approve],[data-remove],[data-edit],[data-toggle],#g-undo,#g-save,#g-refresh,#g-retry'));
    if (!el || !view.contains(el)) return;
    const d = el.dataset;
    if (d.filter) {
      filter = /** @type {typeof filter} */ (d.filter);
      keepInAddress();
      drawFilter();
      drawLists();
    } else if (d.approve || d.edit) {
      const row = rowFor(d.approve || d.edit || '');
      if (row) groupDrawer(row);
    } else if (d.remove) {
      const row = rowFor(d.remove);
      if (row) remove(row);
    } else if (d.toggle) {
      const row = rowFor(d.toggle);
      if (row) {
        if (isApproved(row)) remove(row);
        else groupDrawer(row);
      }
    } else if (el.id === 'g-undo') {
      pending.clear();
      draw();
    } else if (el.id === 'g-save') void save();
    else if (el.id === 'g-refresh') {
      const b = /** @type {HTMLButtonElement} */ (el);
      b.disabled = true;
      void load(true).finally(() => {
        b.disabled = false;
      });
    } else if (el.id === 'g-retry') void load();
  };
  view.addEventListener('click', onClick);

  // Drag and drop between the boards (desktop). The buttons do the same for keyboards and screen readers.
  /** @type {string | null} */
  let dragging = null;
  /** @param {DragEvent} e */
  const onDragStart = (e) => {
    const r = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest?.('.grow[data-key]'));
    if (!r) return;
    dragging = r.dataset.key ?? null;
    r.classList.add('dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', 'group');
    }
  };
  const onDragEnd = () => {
    dragging = null;
    for (const el of $$('.dragging, .drop-hot', view)) el.classList.remove('dragging', 'drop-hot');
  };
  /** @param {DragEvent} e */
  const onDragOver = (e) => {
    const b = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest?.('.board'));
    if (!b || !dragging) return;
    e.preventDefault();
    for (const x of $$('.board', view)) x.classList.toggle('drop-hot', x === b);
  };
  /** @param {DragEvent} e */
  const onDrop = (e) => {
    const b = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest?.('.board'));
    const row = dragging ? rowFor(dragging) : null;
    onDragEnd();
    if (!b || !row) return;
    e.preventDefault();
    if (b.dataset.zone === 'on' && !isApproved(row)) groupDrawer(row);
    else if (b.dataset.zone === 'off' && isApproved(row)) remove(row);
  };
  view.addEventListener('dragstart', onDragStart);
  view.addEventListener('dragend', onDragEnd);
  view.addEventListener('dragover', onDragOver);
  view.addEventListener('drop', onDrop);
  const onLayout = () => {
    drawFilter();
    drawLists();
  };
  phone.addEventListener('change', onLayout);

  drawFilter();
  void load();
  return () => {
    clearTimeout(searchTimer);
    for (const o of observers) o.disconnect();
    view.removeEventListener('click', onClick);
    view.removeEventListener('dragstart', onDragStart);
    view.removeEventListener('dragend', onDragEnd);
    view.removeEventListener('dragover', onDragOver);
    view.removeEventListener('drop', onDrop);
    phone.removeEventListener('change', onLayout);
  };
}
