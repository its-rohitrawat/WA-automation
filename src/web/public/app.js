// The dashboard app: sign-in or the shell, the sidebar, top bar, theme, account menu, screens and live status.
import { get, me, poll, setSignedOutHandler, signOut } from './api.js';
import { problems, readOverview, readStatus } from './contract.js';
import { $, $$, esc, gsap, icon, installTooltip, paint, reduceMotion, toast } from './dom.js';
import { initials } from './format.js';
import { NAV, navigate, onPopState, parsePath, pathFor, SCREENS } from './router.js';
import { ASSISTANT_CHANGED, ASSISTANT_GO, mountAssistant, unmountAssistant } from './views/assistant.js';
import { mountClients } from './views/clients.js';
import { CONNECTIONS_CHANGED, openFix, runAction } from './views/connect.js';
import { mountConnections } from './views/connections.js';
import { closeDrawer, openDrawerElement } from './views/drawer.js';
import { resetGroups } from './views/groups.js';
import { afterOverview, attentionBanner, closeKpiInfo, kpiInfoClick, renderOverview } from './views/overview.js';
import { renderPlaceholder } from './views/placeholder.js';
import { SCREEN_MOUNTS } from './views/registry.js';
import './views/screens.js';

SCREEN_MOUNTS.set('clients', mountClients);
SCREEN_MOUNTS.set('connections', mountConnections);
// After a link, a reconnect or a quick action: the health pill now (an open dialog stays; Connections reloads itself).
addEventListener(CONNECTIONS_CHANGED, () => {
  if (owner) void refreshStatus();
});
// The assistant opens a screen with its filters in the address; the screen reads them as from a link.
addEventListener(ASSISTANT_GO, (e) => {
  const d = /** @type {CustomEvent<{ screen?: unknown, search?: unknown }>} */ (e).detail;
  if (!owner || typeof d?.screen !== 'string' || !SCREENS.has(d.screen)) return;
  history.pushState(null, '', pathFor(d.screen, null) + (typeof d.search === 'string' ? d.search : ''));
  current = { screen: '', sub: null }; // drawn again even when it is the screen already showing
  show(d.screen, null, { fromHistory: true });
});
// A change confirmed in the assistant: the screen showing is drawn again with it.
addEventListener(ASSISTANT_CHANGED, () => {
  if (!owner || !current.screen) return;
  const { screen, sub } = current;
  current = { screen: '', sub: null };
  show(screen, sub, { fromHistory: true });
});
import { hideSignin, showSignin } from './views/signin.js';

const STATUS_MS = 10_000;
const OVERVIEW_MS = 30_000;
const THEME_KEY = 'wa-agent-theme';

/** @type {{ email: string, name: string } | null} */
let owner = null;
/** @type {ReturnType<typeof readStatus> | null} */
let status = null;
let current = { screen: '', sub: /** @type {string | null} */ (null) };
/** @type {(() => void)[]} */
let screenPolls = [];
/** @type {(() => void) | null} */
let statusPoll = null;
/** Bumped on every screen change: a response for an earlier visit never draws over the current one. */
let visit = 0;
/** Redraws the parts of the current screen that come from the status, after each status refresh. */
let onStatus = () => {};

/** The status as far as a screen draws it (not when it was checked): a screen redraws only when this changes. */
const statusKey = () => (status ? JSON.stringify({ ...status, checkedAt: null }) : '');

// ---------- theme (kept per browser; storage may be blocked) ----------
function applyTheme(/** @type {string} */ theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
  const b = $('#theme');
  if (b) b.innerHTML = icon(theme === 'light' ? 'sun' : 'moon', 18);
}
function savedTheme() {
  try {
    return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}
applyTheme(savedTheme());

// ---------- the shell ----------
function buildNav() {
  $('#nav').innerHTML = NAV.map(([group, items]) => `<div class="nav-group"><div class="nav-label eyebrow">${esc(group)}</div>${items
    .map((/** @type {readonly [string, string, string]} */ [id, label, ic]) => `<a href="${id === 'overview' ? '/dashboard' : `/dashboard/${id}`}" data-go="${id}" title="${esc(label)}">${icon(ic, 19)}<span>${esc(label)}</span></a>`)
    .join('')}</div>`).join('');
}

function wireShell() {
  document.addEventListener('click', (e) => {
    const target = /** @type {Element} */ (e.target);
    // The Overview's "i" buttons (and a click elsewhere closes an open sentence).
    if (kpiInfoClick(target)) return;
    // A connection's fix (a dialog) or quick action, from any screen: Connections cards, the Overview's Fix now.
    const fix = /** @type {HTMLElement | null} */ (target.closest('[data-fix]'));
    if (fix && !(/** @type {HTMLButtonElement} */ (fix).disabled)) {
      e.preventDefault();
      const card = /** @type {HTMLElement | null} */ (fix.closest('[data-conn]'));
      openFix(fix.dataset.fix ?? '', { email: card?.dataset.email, meetings: card?.dataset.meetings === '1' });
      return;
    }
    const act = /** @type {HTMLButtonElement | null} */ (target.closest('button[data-action]'));
    if (act && !act.disabled) {
      void runAction(act, act.dataset.action ?? '');
      return;
    }
    const go = /** @type {HTMLElement | null} */ (target.closest('[data-go]'));
    if (go && !(/** @type {HTMLButtonElement} */ (go).disabled)) {
      // A link opened in a new tab or window keeps the browser's own behaviour.
      if (go.tagName === 'A' && (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0)) return;
      e.preventDefault();
      closeMenu(false);
      // A filter for the screen (the Overview's counts): only a query string, nothing else.
      const query = /^\?[a-z]+=[a-z0-9_]+(&[a-z]+=[a-z0-9_]+)*$/.test(go.dataset.query ?? '') ? go.dataset.query : undefined;
      show(go.dataset.go ?? 'overview', null, { query });
      return;
    }
    if (!target.closest('.me')) closeMenu(false);
  });
  $('#collapse').addEventListener('click', () => $('#app').classList.toggle('collapsed'));
  $('#mnav').addEventListener('click', () => setDrawer(!$('#app').classList.contains('nav-open')));
  $('#theme').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // not kept: fine
    }
  });
  $('#avatar').addEventListener('click', () => {
    const m = $('#menu');
    m.hidden = !m.hidden;
    $('#avatar').setAttribute('aria-expanded', String(!m.hidden));
    if (!m.hidden && gsap && !reduceMotion) gsap.fromTo(m, { scale: 0.96, autoAlpha: 0 }, { scale: 1, autoAlpha: 1, duration: 0.18, ease: 'power2.out' });
  });
  $('#signout').addEventListener('click', async () => {
    // First, while the session still works: an open dialog cancels its phone link.
    closeDrawer(true);
    try {
      await signOut();
    } catch {
      toast('Signing out did not work. Try again.');
      return;
    }
    leaveApp(true);
  });
  addEventListener('keydown', (e) => {
    const tag = /** @type {HTMLElement} */ (document.activeElement)?.tagName;
    if (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA' && !openDrawerElement()) {
      e.preventDefault();
      /** @type {HTMLInputElement} */ ($('#q')).focus();
    }
    if (e.key === 'Escape') {
      if (closeKpiInfo()) return;
      if (!$('#menu').hidden) closeMenu(true);
      else if ($('#app').classList.contains('nav-open')) {
        setDrawer(false);
        $('#mnav').focus();
      }
    }
  });
  $('#q').addEventListener('keydown', (e) => {
    if (/** @type {KeyboardEvent} */ (e).key === 'Enter') show('tasks', null);
  });
  onPopState(({ screen, sub }) => show(screen, sub, { fromHistory: true }));
}

/** Hides the account menu; `refocus` puts focus back on the avatar. @param {boolean} refocus */
function closeMenu(refocus) {
  const wasOpen = !$('#menu').hidden;
  $('#menu').hidden = true;
  $('#avatar').setAttribute('aria-expanded', 'false');
  if (refocus && wasOpen) $('#avatar').focus();
}

/** Opens or closes the phone drawer. @param {boolean} open */
function setDrawer(open) {
  $('#app').classList.toggle('nav-open', open);
  $('#mnav').setAttribute('aria-expanded', String(open));
}

// ---------- status: health pill, sidebar box, Connections badge, offline bar ----------
async function refreshStatus() {
  try {
    status = readStatus(await get('/status'));
    $('#offline').hidden = true;
  } catch (e) {
    if (/** @type {{ status?: number }} */ (e).status === 401) return;
    $('#offline').hidden = false;
    return;
  }
  const p = problems(status);
  const pill = $('#hpill');
  pill.classList.toggle('warn', p.length > 0);
  $('#hpill-t').textContent = p.length ? `${p.length} need${p.length === 1 ? 's' : ''} attention` : 'All systems normal';
  $('#sh-t').textContent = p.length ? `${p.length} part${p.length === 1 ? '' : 's'} need${p.length === 1 ? 's' : ''} you` : 'Agent is healthy';
  $('#sh-s').textContent = p.length ? (p[0].detail ? `${p[0].label}: ${p[0].detail}` : p[0].label) : 'All parts answering';
  $('#side-health').classList.toggle('warn', p.length > 0);
  const nav = $('#nav [data-go="connections"]');
  nav?.querySelector('.count')?.remove();
  if (p.length && nav) {
    const c = document.createElement('em');
    c.className = 'count warn';
    c.textContent = String(p.length);
    nav.append(c);
  }
  onStatus();
}

/**
 * Replaces the view's markup, keeping keyboard focus on the same control (by its position among the view's focusable
 * controls) so a background refresh never throws the owner's focus back to the page.
 * @param {HTMLElement} view @param {string} html
 */
function redraw(view, html) {
  const focusable = () => $$('a[href], button, input, select, textarea, [tabindex]', view);
  const at = view.contains(document.activeElement) ? focusable().indexOf(/** @type {HTMLElement} */ (document.activeElement)) : -1;
  view.innerHTML = html;
  if (at >= 0) focusable()[at]?.focus({ preventScroll: true });
}

// ---------- screens ----------
/**
 * Shows a screen. New history entry unless it came from the back/forward buttons.
 * `query` ("?status=overdue") goes into the new address with the screen, for the screen to read its filter from.
 * @param {string} screen @param {string | null} sub @param {{ fromHistory?: boolean, replace?: boolean, query?: string }} [opts]
 */
function show(screen, sub, opts = {}) {
  if (!owner) {
    // Signed out (for example the back button after signing out): only the sign-in page, and no pollers.
    showSignin();
    return;
  }
  if (!SCREENS.has(screen)) screen = 'overview';
  if (!opts.fromHistory) navigate(screen, sub, { replace: opts.replace, query: opts.query });
  if (current.screen === screen && current.sub === sub && !opts.replace) return;
  current = { screen, sub };
  closeKpiInfo();
  closeDrawer(true);
  const mine = ++visit;
  const live = () => mine === visit;
  onStatus = () => {};
  for (const stop of screenPolls) stop();
  screenPolls = [];
  const meta = SCREENS.get(screen) ?? { group: 'Workspace', label: 'Overview', icon: 'dash' };
  $$('#nav a').forEach((a) => {
    const on = a.dataset.go === screen;
    a.classList.toggle('on', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  $('#title').textContent = meta.label;
  $('#crumb').textContent = meta.group;
  document.title = `${meta.label} · WA Agent`;
  setDrawer(false);
  scrollTo({ top: 0 });
  const view = $('#view');

  if (screen === 'overview') {
    /** @type {ReturnType<typeof readOverview> | null} */
    let ov = null;
    let first = true;
    const draw = (/** @type {unknown} */ err) => {
      if (!live()) return;
      redraw(view, renderOverview(owner, status, ov, err));
      // Numbers count up and bars grow once per visit; later refreshes just show the new values.
      afterOverview(view, status, { animate: first });
      if (ov) first = false;
    };
    draw(undefined);
    let drawnStatus = statusKey();
    onStatus = () => {
      if (statusKey() === drawnStatus) return;
      drawnStatus = statusKey();
      draw(undefined);
    };
    screenPolls.push(
      poll(async () => {
        try {
          const next = readOverview(await get('/overview'));
          if (!live()) return;
          ov = next;
          draw(undefined);
        } catch (e) {
          if (live() && !ov) draw(e);
        }
      }, OVERVIEW_MS),
    );
  } else {
    const mount = SCREEN_MOUNTS.get(screen);
    if (!mount) view.innerHTML = renderPlaceholder(meta);
    else {
      /** @type {(() => void)[]} */
      const statusFns = [];
      onStatus = () => {
        for (const fn of statusFns) if (live()) fn();
      };
      const stop = mount({
        view,
        sub,
        live,
        status: () => status,
        onStatus: (fn) => {
          statusFns.push(fn);
        },
        poll: (fn, ms) => {
          screenPolls.push(poll(fn, ms));
        },
        redraw: (html) => {
          if (live()) redraw(view, html);
        },
        go: (s, x) => show(s, x),
      });
      if (stop) screenPolls.push(stop);
    }
  }
  if (!reduceMotion && gsap) gsap.fromTo(view.children, { y: 8, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.35, stagger: 0.03, ease: 'expo.out', clearProps: 'transform' });
}

// ---------- sign-in and sign-out ----------
function enterApp() {
  hideSignin();
  $('#app').hidden = false;
  $('#avatar').textContent = initials(owner?.name ?? '', owner?.email ?? '');
  $('#me-name').textContent = owner?.name || 'Owner';
  $('#me-email').textContent = owner?.email ?? '';
  statusPoll = poll(refreshStatus, STATUS_MS);
  mountAssistant();
  const { screen, sub } = parsePath(location.pathname);
  show(screen, sub, { replace: true });
  if (!reduceMotion && gsap) {
    gsap.from('.side', { x: -30, autoAlpha: 0, duration: 0.6, ease: 'expo.out', clearProps: 'all' });
    gsap.from('.top', { y: -12, autoAlpha: 0, duration: 0.5, ease: 'expo.out', clearProps: 'all' });
  }
}

/** Back to the sign-in page: on sign-out, or when the session has ended. @param {boolean} signedOut */
function leaveApp(signedOut) {
  statusPoll?.();
  statusPoll = null;
  for (const stop of screenPolls) stop();
  screenPolls = [];
  visit++;
  onStatus = () => {};
  closeDrawer(true);
  resetGroups();
  unmountAssistant();
  owner = null;
  status = null;
  current = { screen: '', sub: null };
  // Nothing of the owner's stays in the page; emptying the view also ends the heartbeat animation.
  $('#view').replaceChildren();
  $('#me-name').textContent = '';
  $('#me-email').textContent = '';
  $('#avatar').textContent = '··';
  closeMenu(false);
  setDrawer(false);
  showSignin({ signedOut });
}

async function boot() {
  paint();
  buildNav();
  installTooltip();
  wireShell();
  setSignedOutHandler(() => {
    if (owner) leaveApp(false);
  });
  try {
    owner = await me();
  } catch {
    owner = null;
  }
  if (owner) enterApp();
  else showSignin();
}

void boot();
