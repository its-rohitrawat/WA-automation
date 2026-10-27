// Activity (D4 Task 6): filter chips kept in the address, items grouped by India day, newest first, and "Show older"
// with the API's cursor. Titles and details carry task and meeting titles: esc() on everything.
import { get } from '../api.js';
import { esc, icon } from '../dom.js';
import { clock } from '../format.js';
import { empty, failed, listen, loading, setQuery } from './ui.js';
import { groupByIstDay, readList } from './workLib.js';

/** @typedef {import('./registry.js').ScreenCtx} ScreenCtx */
/** @typedef {{ id: string, kind: string, title: string, detail: string, who: string, at: string }} Item */

const KINDS = [['all', 'All'], ['msg', 'Messages'], ['task', 'Tasks'], ['meet', 'Meetings'], ['tracker', 'Tracker'], ['issue', 'Issues']];
const KIND_ICON = { msg: 'bubble', task: 'task', meet: 'video', tracker: 'xls', issue: 'alert', connection: 'plug', config: 'settings' };
const POLL_MS = 30_000;

/** @param {ScreenCtx} ctx */
export function mountActivity(ctx) {
  let kind = readList(location.search, 'kind', KINDS.map(([k]) => k), 'all');
  /** @type {Item[] | null} */
  let items = null;
  /** @type {string | null} */
  let next = null;
  /** @type {unknown} */
  let err = null;
  let older = false;

  const draw = () => {
    const chips = `<div class="toolbar"><div class="seg" role="tablist">${KINDS.map(([k, l]) => `<button type="button" role="tab" aria-selected="${kind === k}" class="${kind === k ? 'on' : ''}" data-akind="${k}">${esc(l)}</button>`).join('')}</div></div>`;
    let body;
    if (err && !items) body = failed(err);
    else if (!items) body = loading('Loading activity…');
    else if (!items.length) body = `<div class="card">${empty('Nothing in this category yet.')}</div>`;
    else {
      body = `<div class="card">${groupByIstDay(items).map((g) => `<div class="eyebrow day-head">${esc(g.label)}</div><div class="list">${g.items.map((/** @type {Item} */ a) => `<div class="li"><div class="ic${a.kind === 'issue' ? ' ic-issue' : ''}">${icon(/** @type {Record<string, string>} */ (KIND_ICON)[a.kind] ?? 'act', 17)}</div>
          <div><b>${esc(a.title)}${a.detail ? ` · ${esc(a.detail)}` : ''}</b>${a.who ? `<small>${esc(a.who)}</small>` : ''}</div><time>${esc(clock(a.at))}</time></div>`).join('')}</div>`).join('')}
        ${next ? '<div class="more"><button class="btn btn-ghost btn-sm" type="button" data-older>Show older</button></div>' : ''}</div>`;
    }
    ctx.redraw(chips + body);
  };

  /** @param {boolean} [more] */
  async function load(more = false) {
    if (!more && older) return; // while older pages are open, the refresh would drop them
    try {
      const r = await get(`/activity?kind=${encodeURIComponent(kind)}&limit=50${more && next ? `&before=${encodeURIComponent(next)}` : ''}`);
      if (!ctx.live()) return;
      items = more && items ? [...items, ...r.items] : r.items;
      next = r.next;
      err = null;
    } catch (e) {
      if (!ctx.live()) return;
      err = e;
    }
    draw();
  }

  draw();
  ctx.poll(() => load(), POLL_MS);

  return listen(ctx.view, {
    click: (e) => {
      const t = /** @type {Element} */ (e.target);
      const chip = /** @type {HTMLElement | null} */ (t.closest('[data-akind]'));
      if (chip?.dataset.akind && chip.dataset.akind !== kind) {
        kind = chip.dataset.akind;
        setQuery(kind === 'all' ? '' : `?kind=${kind}`);
        items = null;
        next = null;
        older = false;
        draw();
        void load();
        return;
      }
      if (t.closest('[data-retry]')) return void load();
      if (t.closest('[data-older]')) {
        older = true;
        void load(true);
      }
    },
  });
}
