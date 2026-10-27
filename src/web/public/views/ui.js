// Shared parts of the work and control screens: the drawer and the confirm dialog, loading, empty and error states, and
// the URL query. Everything from the agent goes through esc() or textContent; nothing here sets an inline style
// attribute (the Content-Security-Policy allows none), only classes and CSSOM properties.
// The screen context (ScreenCtx) is the shell's, in views/registry.js.
import { $, $$, esc, gsap, icon, paint, reduceMotion } from '../dom.js';

/** @typedef {import('./registry.js').ScreenCtx} ScreenCtx */

/**
 * Listens on the screen's view until the screen is left (the view element outlives the screen). Returns the cleanup.
 * @param {HTMLElement} view @param {Record<string, (e: Event) => void>} handlers
 */
export function listen(view, handlers) {
  const ac = new AbortController();
  for (const [type, fn] of Object.entries(handlers)) view.addEventListener(type, fn, { signal: ac.signal });
  return () => {
    ac.abort();
    closeDrawer(true);
  };
}

/** The loading state. @param {string} [what] */
export const loading = (what = 'Loading…') => `<div class="card"><div class="skel" aria-hidden="true"><i></i><i></i><i></i></div><p class="loading">${esc(what)}</p></div>`;

/** The empty state. @param {string} text */
export const empty = (text) => `<div class="empty">${esc(text)}</div>`;

/** The error state with a Retry button (data-retry). @param {unknown} err */
export function failed(err) {
  const msg = err instanceof Error && err.name === 'ApiError' ? err.message : 'This could not be loaded.';
  return `<div class="card err-state" role="alert">${icon('alert', 20)}<div class="grow-1"><b>${esc(msg)}</b><div>Check the connection, then try again.</div></div>
    <button class="btn btn-ghost btn-sm" type="button" data-retry>${icon('refresh', 15)}Retry</button></div>`;
}

/** A status pill. @param {{ cls: string, label: string }} p */
export const pill = (p) => `<span class="pill ${esc(p.cls)}"><i></i>${esc(p.label)}</span>`;

/** The message of a refusal from the API (plain text it sent), or a fixed one. @param {unknown} err */
export const errorText = (err) => (err instanceof Error && err.name === 'ApiError' ? err.message : 'Something went wrong. Try again.');

/** Keeps the screen's filters in the address bar, without a new history entry. @param {string} search "" or "?a=b" */
export function setQuery(search) {
  const next = location.pathname + search;
  if (next !== location.pathname + location.search) history.replaceState(history.state, '', next);
}

// ---------- the drawer ----------

/** @type {{ drawer: HTMLElement, scrim: HTMLElement, back: Element | null } | null} */
let open = null;

/**
 * Opens a side drawer with this markup (already escaped by the caller). Esc, the scrim and any [data-close] close it;
 * focus moves in and returns to where it was. @param {string} html @returns {HTMLElement}
 */
export function openDrawer(html) {
  closeDrawer(true);
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  const drawer = document.createElement('aside');
  drawer.className = 'drawer';
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('aria-modal', 'true');
  drawer.innerHTML = html;
  document.body.append(scrim, drawer);
  paint(drawer);
  open = { drawer, scrim, back: document.activeElement };
  scrim.addEventListener('click', () => closeDrawer());
  for (const b of $$('[data-close]', drawer)) b.addEventListener('click', () => closeDrawer());
  drawer.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
  });
  const h = drawer.querySelector('h2');
  if (h) {
    h.setAttribute('tabindex', '-1');
    drawer.setAttribute('aria-labelledby', (h.id ||= `dr-${Date.now()}`));
    h.focus({ preventScroll: true });
  }
  if (gsap && !reduceMotion) {
    gsap.fromTo(scrim, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.2 });
    gsap.fromTo(drawer, { xPercent: 100 }, { xPercent: 0, duration: 0.42, ease: 'expo.out' });
  }
  return drawer;
}

/** Replaces the open drawer's content (after an action), keeping it open. @param {string} html */
export function refillDrawer(html) {
  if (!open) return null;
  open.drawer.innerHTML = html;
  paint(open.drawer);
  for (const b of $$('[data-close]', open.drawer)) b.addEventListener('click', () => closeDrawer());
  return open.drawer;
}

/** Closes the drawer; `instant` skips the animation (a new one is opening, or the screen is left). @param {boolean} [instant] */
export function closeDrawer(instant = false) {
  if (!open) return;
  const { drawer, scrim, back } = open;
  open = null;
  const done = () => {
    drawer.remove();
    scrim.remove();
  };
  if (instant || !gsap || reduceMotion) done();
  else {
    gsap.to(drawer, { xPercent: 100, duration: 0.25, ease: 'power2.in', onComplete: done });
    gsap.to(scrim, { autoAlpha: 0, duration: 0.2 });
  }
  if (back instanceof HTMLElement && document.contains(back)) back.focus({ preventScroll: true });
}

// ---------- the confirm dialog ----------

/**
 * Asks before something that costs money or reaches the founder. Resolves true for the confirm button, false for
 * Cancel, Esc or the scrim. Title and text are fixed words from the screen, escaped all the same.
 * @param {{ eyebrow?: string, title: string, text: string, yes: string }} o @returns {Promise<boolean>}
 */
export function confirmDialog(o) {
  return new Promise((resolve) => {
    const back = document.activeElement;
    const scrim = document.createElement('div');
    scrim.className = 'scrim';
    const m = document.createElement('div');
    m.className = 'modal';
    m.setAttribute('role', 'alertdialog');
    m.setAttribute('aria-modal', 'true');
    m.innerHTML = `<div class="m-head"><div>${o.eyebrow ? `<span class="eyebrow">${esc(o.eyebrow)}</span>` : ''}<h2 id="m-title">${esc(o.title)}</h2></div></div>
      <p class="m-p">${esc(o.text)}</p><div class="m-foot"><button class="btn btn-ghost" type="button" data-no>Cancel</button><button class="btn btn-primary" type="button" data-yes>${esc(o.yes)}</button></div>`;
    m.setAttribute('aria-labelledby', 'm-title');
    document.body.append(scrim, m);
    const finish = (/** @type {boolean} */ v) => {
      m.remove();
      scrim.remove();
      if (back instanceof HTMLElement && document.contains(back)) back.focus({ preventScroll: true });
      resolve(v);
    };
    $('[data-yes]', m).addEventListener('click', () => finish(true));
    $('[data-no]', m).addEventListener('click', () => finish(false));
    scrim.addEventListener('click', () => finish(false));
    m.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') finish(false);
    });
    $('[data-no]', m).focus();
  });
}
