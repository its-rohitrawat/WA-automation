// The side drawer (client details, approving a group) and the centred dialog (linking a phone, connecting Google). One at
// a time: modal, with a scrim. Escape, the scrim and every [data-close] close it, Tab stays inside it, and focus goes back
// to what opened it. Its markup comes from the caller, built with esc() for anything from the agent.
import { $$, gsap, paint, reduceMotion } from '../dom.js';

/** @type {{ el: HTMLElement, scrim: HTMLElement, kind: 'drawer' | 'modal', opener: Element | null, onClose: () => void } | null} */
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
  const f = $$('a[href], button:not([disabled]), input:not([disabled]), select, textarea, summary, [tabindex="0"]', open.el).filter((el) => el.offsetParent !== null);
  if (f.length === 0) return;
  const first = f[0];
  const last = f[f.length - 1];
  if (e.shiftKey && (document.activeElement === first || !open.el.contains(document.activeElement))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (document.activeElement === last || !open.el.contains(document.activeElement))) {
    e.preventDefault();
    first.focus();
  }
}

/** Puts focus on the first field, else the first button that is not Close, else Close. @param {HTMLElement} el */
export function focusFirst(el) {
  const target = /** @type {HTMLElement | null} */ (
    el.querySelector('[autofocus]') ??
      el.querySelector('input:not([readonly]):not([disabled]), select, textarea') ??
      el.querySelector('button:not([data-close]):not([disabled]), a[href]') ??
      el.querySelector('[data-close]')
  );
  target?.focus({ preventScroll: true });
}

/**
 * Opens a layer. @param {'drawer' | 'modal'} kind @param {string} html @param {{ onClose?: () => void }} opts
 * @returns {HTMLElement}
 */
function openLayer(kind, html, opts) {
  closeDrawer(true);
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  const el = document.createElement(kind === 'drawer' ? 'aside' : 'div');
  el.className = kind;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.innerHTML = html;
  const title = el.querySelector('h2');
  if (title) {
    title.id = 'layer-title';
    el.setAttribute('aria-labelledby', 'layer-title');
  }
  document.body.append(scrim, el);
  paint(el);
  open = { el, scrim, kind, opener: document.activeElement, onClose: opts.onClose ?? (() => {}) };
  scrim.addEventListener('click', () => closeDrawer());
  // Delegated, so [data-close] buttons drawn later (a dialog's next step) close it too.
  el.addEventListener('click', (e) => {
    if (/** @type {Element} */ (e.target).closest('[data-close]')) closeDrawer();
  });
  document.addEventListener('keydown', onKey);
  if (gsap && !reduceMotion) {
    gsap.fromTo(scrim, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.2 });
    if (kind === 'drawer') gsap.fromTo(el, { xPercent: 100 }, { xPercent: 0, duration: 0.42, ease: 'expo.out' });
    else gsap.fromTo(el, { scale: 0.96, autoAlpha: 0 }, { scale: 1, autoAlpha: 1, duration: 0.22, ease: 'power2.out', clearProps: 'transform' });
  }
  focusFirst(el);
  return el;
}

/** Opens a side drawer (a .dr-head with an h2, then .dr-body and .dr-foot). @param {string} html @param {{ onClose?: () => void }} [opts] */
export const openDrawer = (html, opts = {}) => openLayer('drawer', html, opts);

/** Opens a centred dialog (an .m-head with an h2, then the body). @param {string} html @param {{ onClose?: () => void }} [opts] */
export const openModal = (html, opts = {}) => openLayer('modal', html, opts);

/** Closes the open drawer or dialog, if any. `instant` skips the animation (when another replaces it). @param {boolean} [instant] */
export function closeDrawer(instant = false) {
  if (!open) return;
  const { el, scrim, kind, opener, onClose } = open;
  open = null;
  document.removeEventListener('keydown', onKey);
  onClose();
  if (instant || !gsap || reduceMotion) {
    el.remove();
    scrim.remove();
  } else {
    if (kind === 'drawer') gsap.to(el, { xPercent: 100, duration: 0.25, ease: 'power2.in', onComplete: () => el.remove() });
    else gsap.to(el, { autoAlpha: 0, scale: 0.97, duration: 0.15, onComplete: () => el.remove() });
    gsap.to(scrim, { autoAlpha: 0, duration: 0.2, onComplete: () => scrim.remove() });
  }
  if (!instant && opener instanceof HTMLElement && document.contains(opener)) opener.focus({ preventScroll: true });
}

/** The open drawer or dialog element, or null. */
export const openDrawerElement = () => open?.el ?? null;
