// Small DOM helpers shared by every screen. Everything shown from the agent is text: put into templates through esc(),
// or set with textContent. Tooltips are text only.
import { HI } from './icons.js';

/** The element for a selector. The shell's elements always exist; a view's lookups check for null where they can miss. */
/** @type {(s: string, r?: ParentNode) => HTMLElement} */
export const $ = (s, r = document) => /** @type {HTMLElement} */ (r.querySelector(s));
/** @type {(s: string, r?: ParentNode) => HTMLElement[]} */
export const $$ = (s, r = document) => /** @type {HTMLElement[]} */ ([...r.querySelectorAll(s)]);

export const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/** @param {unknown} s */
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

/**
 * An icon's SVG. The markup comes from the generated icons.js (the Hugeicons package), never from the agent.
 * @param {string} name @param {number} [size]
 */
export const icon = (name, size = 18) =>
  `<svg class="hi" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true">${/** @type {Record<string, string>} */ (HI)[name] ?? ''}</svg>`;

/** Fills every [data-icon] placeholder under root. @param {ParentNode} [root] */
export function paint(root = document) {
  for (const el of $$('[data-icon]', root)) {
    el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon ?? '', Number(el.dataset.size) || 18));
    el.removeAttribute('data-icon');
  }
}

/** GSAP, loaded by index.html as a classic script; undefined if it failed to load (the page still works). */
export const gsap = /** @type {any} */ (globalThis).gsap;

/** Counts [data-count] numbers up from 0, or just shows them when `animate` is false. @param {ParentNode} root @param {boolean} [animate] */
export function countUp(root, animate = true) {
  for (const el of $$('[data-count]', root)) {
    const to = Number(el.dataset.count);
    const dec = Number(el.dataset.dec || 0);
    const pre = el.dataset.pre || '';
    if (!animate || reduceMotion || !gsap || !Number.isFinite(to)) {
      el.textContent = pre + (Number.isFinite(to) ? to.toFixed(dec) : '—');
      continue;
    }
    const o = { v: 0 };
    gsap.to(o, { v: to, duration: 1.1, ease: 'expo.out', onUpdate: () => { el.textContent = pre + o.v.toFixed(dec); } });
  }
}

/** The floating tooltip for [data-tip] elements (text only). */
export function installTooltip() {
  const tip = $('#tip');
  if (!tip) return;
  document.addEventListener('pointerover', (e) => {
    const el = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest?.('[data-tip]'));
    if (!el) {
      tip.hidden = true;
      return;
    }
    tip.textContent = el.dataset.tip ?? '';
    tip.hidden = false;
  });
  document.addEventListener('pointermove', (e) => {
    if (tip.hidden) return;
    tip.style.left = `${Math.min(innerWidth - tip.offsetWidth - 8, e.clientX + 14)}px`;
    tip.style.top = `${e.clientY + 14}px`;
  });
}

/** A short notice in the corner: a tick, or (good false) a warning sign. @param {string} msg @param {boolean} [good] */
export function toast(msg, good = true) {
  const t = document.createElement('div');
  t.className = good ? 'toast' : 'toast toast-warn';
  t.setAttribute('role', 'status');
  t.innerHTML = icon(good ? 'ok' : 'alert', 18);
  t.append(document.createTextNode(msg));
  document.body.appendChild(t);
  if (!gsap || reduceMotion) {
    setTimeout(() => t.remove(), 3000);
    return;
  }
  gsap.fromTo(t, { y: 16, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.35, ease: 'expo.out' });
  gsap.to(t, { y: 8, autoAlpha: 0, delay: 2.6, duration: 0.25, onComplete: () => t.remove() });
}
