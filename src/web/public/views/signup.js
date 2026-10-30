// The sign-up page (/signup?invite=…, SaaS design section 5, step 3): who invited them and to which business, and
// "Continue with Google", which the agent checks against the invited address. Any link that does not work shows one
// note, with no detail. Text from the agent is set with textContent only.
import { $, paint } from '../dom.js';

const THEME_KEY = 'wa-agent-theme';
try {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
} catch {
  // storage blocked: dark
}
paint();

const params = new URLSearchParams(location.search);
const token = params.get('invite') ?? '';
const note = params.get('error');
const NOTES = /** @type {Record<string, string>} */ ({ wrong_account: '#su-wrong', invalid: '#su-invalid', retry: '#su-retry', busy: '#su-busy', unavailable: '#su-unavailable' });
// The note was only for this showing; the invite stays in the address so a reload still works.
if (note) history.replaceState(null, '', token ? `/signup?invite=${encodeURIComponent(token)}` : '/signup');

/** One of the notes, or none. @param {string | null} which */
function show(which) {
  for (const [k, sel] of Object.entries(NOTES)) $(sel).hidden = k !== which;
}

/** The card for a link that does not work: why, and no button. */
function dead() {
  $('#su-title').textContent = 'This invite link does not work';
  $('#su-sub').textContent = 'It may have been used, cancelled or have expired. Ask the person who invited you for a new one.';
  /** @type {HTMLElement} */ ($('#gbtn')).hidden = true;
  // The title says it; a note only for a different reason (too many tries, sign-up not open).
  show(note === 'busy' || note === 'unavailable' ? note : null);
}

/** "5 Nov 2026" in India time. @param {string} iso */
const day = (iso) => new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });

async function open() {
  if (!token) return dead();
  let info;
  try {
    const r = await fetch(`/signup/api/invite?invite=${encodeURIComponent(token)}`, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
    if (r.status === 429) {
      show('busy');
      $('#su-title').textContent = 'Too many tries';
      $('#su-sub').textContent = 'Wait a few minutes, then open the invite link again.';
      return;
    }
    if (!r.ok) {
      const body = await r.json().catch(() => null);
      if (body?.error?.code === 'unavailable') {
        $('#su-title').textContent = 'Sign-up is not open yet';
        $('#su-sub').textContent = 'Ask the person who invited you to try again later.';
        show('unavailable');
        return;
      }
      return dead();
    }
    info = await r.json();
  } catch {
    $('#su-title').textContent = 'The invite could not be opened';
    $('#su-sub').textContent = 'Check your connection and reload this page.';
    return;
  }
  const founder = typeof info?.founderName === 'string' && info.founderName ? info.founderName : 'Someone';
  const business = typeof info?.business === 'string' ? info.business : '';
  $('#su-title').textContent = `${founder} invited you to WA Agent`;
  const sub = $('#su-sub');
  sub.textContent = 'Set up the workspace for ';
  const b = document.createElement('b');
  b.textContent = business;
  sub.append(b, '. Sign in with the Google account this invite was sent to.');
  if (typeof info?.expiresAt === 'string' && !Number.isNaN(Date.parse(info.expiresAt))) $('#su-expiry').textContent = `The invite works once and expires on ${day(info.expiresAt)}.`;
  const g = /** @type {HTMLAnchorElement} */ ($('#gbtn'));
  g.href = `/signup/google?invite=${encodeURIComponent(token)}`;
  g.hidden = false;
  g.addEventListener('click', () => g.setAttribute('aria-busy', 'true'), { once: true });
  show(note === 'wrong_account' || note === 'retry' || note === 'busy' ? note : null);
}

/**
 * Signed up before the agent runs customer workspaces (it is still on its first database, before the Postgres switch):
 * the invite is used and the workspace is theirs, but there is nothing to sign in to yet. No button, no note.
 */
function waiting() {
  $('#su-title').textContent = "You're signed up";
  $('#su-sub').textContent = 'Your workspace opens once WA Agent has finished an upgrade. The person who invited you will tell you when it is ready. Then open WA Agent and sign in with this same Google account.';
  $('#su-expiry').textContent = 'Your invite has been used. You will not need it again.';
  /** @type {HTMLElement} */ ($('#gbtn')).hidden = true;
  show(null);
}

// Back from Google's account chooser, the browser may restore this page as it was: the button works again.
addEventListener('pageshow', () => $('#gbtn').removeAttribute('aria-busy'));
if (params.get('note') === 'waiting') waiting();
else void open();
