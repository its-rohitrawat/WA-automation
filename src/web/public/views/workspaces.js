// System › Switch workspace: a member of several customer workspaces picks the one to work in. The list is the
// member's own workspaces only (the server reads them from its email); switching signs in again there with a new
// session, so the page reloads into that workspace. Every value from the agent goes through esc().
import { ApiError, get, post } from '../api.js';
import { esc, icon, toast } from '../dom.js';
import { SCREEN_MOUNTS } from './registry.js';
import { errorText, failed, listen, loading } from './ui.js';

/** @typedef {import('./registry.js').ScreenCtx} ScreenCtx */
/** @typedef {{ id: string, name: string, current: boolean }} Workspace */

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The workspace list from the agent, checked field by field. @param {unknown} raw @returns {Workspace[]} */
function readWorkspaces(raw) {
  const r = raw && typeof raw === 'object' ? /** @type {Record<string, any>} */ (raw) : {};
  const list = Array.isArray(r.workspaces) ? r.workspaces : [];
  return list
    .map((/** @type {any} */ w) => ({ id: typeof w?.id === 'string' ? w.id : '', name: typeof w?.name === 'string' ? w.name.slice(0, 80) : '', current: w?.current === true }))
    .filter((/** @type {Workspace} */ w) => ID.test(w.id));
}

/** @param {Workspace} w @param {string | null} busy */
function card(w, busy) {
  const act = w.current
    ? `<span class="eyebrow">${icon('tick', 15)} Current</span>`
    : `<button class="btn btn-primary btn-sm" type="button" data-switch="${esc(w.id)}"${busy ? ' disabled' : ''}>${busy === w.id ? 'Opening…' : `Open${icon('arrowR', 15)}`}</button>`;
  return `<section class="card ccard col-4"><div class="row"><div><h3>${esc(w.name || 'Workspace')}</h3>
    <div class="grp">${icon('brief', 14)}${w.current ? 'You are working here' : 'Your workspace'}</div></div></div>
    <div class="row-gap">${act}</div></section>`;
}

/** @param {Workspace[]} list @param {string | null} busy */
function render(list, busy) {
  return `<div class="grid"><section class="card col-12"><div class="card-head"><h3>Your workspaces</h3><span class="eyebrow">${list.length}</span></div>
    <p class="muted">You are a member of more than one business. Pick the one to work in; you can switch again here at any time.</p></section>
    ${list.map((w) => card(w, busy)).join('')}</div>`;
}

/** @param {ScreenCtx} ctx */
export function mountWorkspaces(ctx) {
  /** @type {Workspace[]} */
  let list = [];
  /** @type {string | null} */
  let busy = null;

  const load = async () => {
    ctx.redraw(loading('Loading your workspaces…'));
    try {
      const next = readWorkspaces(await get('/workspaces'));
      if (!ctx.live()) return;
      list = next;
      ctx.redraw(render(list, busy));
    } catch (err) {
      if (ctx.live()) ctx.redraw(failed(err));
    }
  };

  /** @param {string} tenantId */
  const open = async (tenantId) => {
    if (busy) return;
    busy = tenantId;
    ctx.redraw(render(list, busy));
    try {
      const r = /** @type {{ switched?: unknown } | null} */ (await post('/workspaces/switch', { tenantId }));
      // A new session in that workspace: the whole page starts again in it (its screens, its CSRF token).
      if (r?.switched === true) location.assign('/dashboard');
      else {
        busy = null;
        if (ctx.live()) ctx.redraw(render(list, busy));
      }
    } catch (err) {
      busy = null;
      toast(errorText(err), false);
      if (err instanceof ApiError && err.status === 404) await load(); // no longer one of this member's
      else if (ctx.live()) ctx.redraw(render(list, busy));
    }
  };

  void load();
  return listen(ctx.view, {
    click: (/** @type {Event} */ e) => {
      const t = /** @type {HTMLElement | null} */ (e.target instanceof Element ? e.target.closest('[data-switch],[data-retry]') : null);
      if (!t) return;
      if (t.dataset.retry !== undefined) void load();
      else if (t.dataset.switch && ID.test(t.dataset.switch)) void open(t.dataset.switch);
    },
  });
}

SCREEN_MOUNTS.set('workspaces', mountWorkspaces);
