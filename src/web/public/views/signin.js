// The sign-in page. "Continue with Google" goes to the agent's /dashboard/auth/login, which returns here after Google.
import { $, $$, gsap, reduceMotion } from '../dom.js';

/** @type {(() => void) | null} */
let stopCore = null;

// Back from Google's account chooser, the browser may restore this page as it was: make the button usable again.
addEventListener('pageshow', () => $('#gbtn').removeAttribute('aria-busy'));

/**
 * Shows the sign-in page.
 * - The query decides the notes: ?denied=1 (an account not on the owner list) or ?error=signin.
 * - signedOut shows "You're signed out".
 * - After sign-in, the agent sends the owner back to the screen they asked for.
 * @param {{ signedOut?: boolean }} [opts]
 */
export function showSignin(opts = {}) {
  $('#app').hidden = true;
  $('#signin').hidden = false;
  const params = new URLSearchParams(location.search);
  $('#si-denied').hidden = params.get('denied') !== '1';
  $('#si-error').hidden = params.get('error') !== 'signin';
  $('#si-out').hidden = !opts.signedOut;
  const back = location.pathname.startsWith('/dashboard/') && location.pathname !== '/dashboard/' ? location.pathname : '/dashboard';
  /** @type {HTMLAnchorElement} */ ($('#gbtn')).href = `/dashboard/auth/login?return=${encodeURIComponent(back)}`;
  // The query was only for the notes; keep the address clean.
  if (location.search) history.replaceState(null, '', location.pathname);
  const btn = /** @type {HTMLAnchorElement} */ ($('#gbtn'));
  btn.removeAttribute('aria-busy');
  btn.addEventListener('click', () => btn.setAttribute('aria-busy', 'true'), { once: true });

  if (!stopCore) {
    void import('../core3d.js').then(async ({ startCore }) => {
      if ($('#signin').hidden) return;
      stopCore = await startCore(/** @type {HTMLCanvasElement} */ ($('#si-core')), { reduceMotion });
    });
  }
  if (!reduceMotion && gsap) {
    gsap.from('#si-card > *:not([hidden])', { y: 16, autoAlpha: 0, stagger: 0.06, duration: 0.8, ease: 'expo.out', delay: 0.15 });
    gsap.from('.si-copy > *', { y: 24, autoAlpha: 0, stagger: 0.1, duration: 1, ease: 'expo.out', delay: 0.3 });
    $$('.si-chip').forEach((c, i) => {
      gsap.from(c, { y: 20, autoAlpha: 0, duration: 0.9, delay: 0.5 + i * 0.15, ease: 'expo.out' });
      gsap.to(c, { y: '-=8', duration: 3 + i, repeat: -1, yoyo: true, ease: 'sine.inOut' });
    });
  }
}

/** Leaves the sign-in page: stops the core. */
export function hideSignin() {
  $('#signin').hidden = true;
  stopCore?.();
  stopCore = null;
}
