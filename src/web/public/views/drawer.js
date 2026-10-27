// The side drawer (client details, approving a group). One at a time: a modal dialog with a scrim. Escape, the scrim
// and every [data-close] close it, and focus goes back to what opened it. Its markup comes from the caller, built with
// esc() for anything from the agent.
import { $, $$, gsap, paint, reduceMotion } from '../dom.js';

/** @type {{ drawer: HTMLElement, scrim: HTMLElement, opener: Element | null, onClose: () => void } | null} */
let open = null;

/** @param {KeyboardEvent} e */
function onKey(e) {
  if (!open) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    closeDrawer();
    return;
  }
  if (e.key !== 'Tab') return;
  // Keep Tab inside the drawer.
  const f = $$('a[href], button:not([disabled]), input:not([disabled]), select, textarea, summary, [tabindex="0"]', open.drawer).filter((el) => el.offsetParent !== null);
  if (f.length === 0) return;
  const first = f[0];
  const last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

/**
 * Opens a drawer with this markup (a .dr-head with an h2, then .dr-body and .dr-foot). Returns the drawer element.
 * @param {string} html @param {{ onClose?: () => void }} [opts]
 */
export function openDrawer(html, opts = {}) {
  closeDrawer(true);
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  const drawer = document.createElement('aside');
  drawer.className = 'drawer';
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('aria-modal', 'true');
  drawer.innerHTML = html;
  const title = drawer.querySelector('h2');
  if (title) {
    title.id = 'drawer-title';
    drawer.setAttribute('aria-labelledby', 'drawer-title');
  }
  document.body.append(scrim, drawer);
  paint(drawer);
  open = { drawer, scrim, opener: document.activeElement, onClose: opts.onClose ?? (() => {}) };
  scrim.addEventListener('click', () => closeDrawer());
  for (const b of $$('[data-close]', drawer)) b.addEventListener('click', () => closeDrawer());
  document.addEventListener('keydown', onKey);
  if (gsap && !reduceMotion) {
    gsap.fromTo(scrim, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.2 });
    gsap.fromTo(drawer, { xPercent: 100 }, { xPercent: 0, duration: 0.42, ease: 'expo.out' });
  }
  // The first field if there is one, else the first button in the body, else Close.
  const focusFirst = /** @type {HTMLElement | null} */ (drawer.querySelector('[autofocus]') ?? drawer.querySelector('.dr-body input, .dr-body select, .dr-body textarea') ?? drawer.querySelector('.dr-body button') ?? drawer.querySelector('[data-close]'));
  focusFirst?.focus({ preventScroll: true });
  return drawer;
}

/** Closes the open drawer, if any. `instant` skips the animation (when another drawer replaces it). @param {boolean} [instant] */
export function closeDrawer(instant = false) {
  if (!open) return;
  const { drawer, scrim, opener, onClose } = open;
  open = null;
  document.removeEventListener('keydown', onKey);
  onClose();
  if (instant || !gsap || reduceMotion) {
    drawer.remove();
    scrim.remove();
  } else {
    gsap.to(drawer, { xPercent: 100, duration: 0.25, ease: 'power2.in', onComplete: () => drawer.remove() });
    gsap.to(scrim, { autoAlpha: 0, duration: 0.2, onComplete: () => scrim.remove() });
  }
  if (!instant && opener instanceof HTMLElement && document.contains(opener)) opener.focus({ preventScroll: true });
}

/** The open drawer element, or null. */
export const openDrawerElement = () => open?.drawer ?? null;
