// Settings (D5 Task 5): the owner, this session, Sign out and Sign out everywhere, the time zone (display only),
// appearance, and the security notes. Owners are listed on the Mac, not here.
import { get, post } from '../api.js';
import { $, esc, icon, toast } from '../dom.js';
import { initials, when } from '../format.js';
import { confirmDialog, errorText, failed, listen, loading, pill } from './ui.js';

/** @typedef {import('./registry.js').ScreenCtx} ScreenCtx */

/** @param {{ email: string, createdAt: string, expiresAt: string }} s @param {string} name the owner's Google name, from the shell's account menu */
function render(s, name) {
  return `<div class="grid">
    <section class="card col-6"><div class="card-head"><h3>Owner</h3></div><div class="owner-row"><div class="avatar avatar-lg">${esc(initials(name, s.email))}</div><div><b>${esc(name || s.email)}</b><div class="muted-p">${esc(name ? `${s.email} · Google` : 'Google sign-in')}</div></div></div>
      <div class="note">${icon('info', 16)}<span>Owners are the Google emails listed on the Mac in .env (DASHBOARD_OWNER_EMAILS). Adding an owner is done there.</span></div></section>
    <section class="card col-6"><div class="card-head"><h3>This session</h3>${pill({ cls: 'p-done', label: 'Active' })}</div><dl class="kv"><dt>Signed in</dt><dd>${esc(when(s.createdAt))}</dd><dt>Expires</dt><dd>${esc(when(s.expiresAt))}, or after 24 hours unused</dd></dl>
      <div class="row-gap row-top"><button class="btn btn-ghost" type="button" data-signout>${icon('logout', 16)}Sign out</button><button class="btn btn-ghost" type="button" data-everywhere>${icon('logout', 16)}Sign out everywhere</button></div></section>
    <section class="card col-6"><div class="card-head"><h3>Preferences</h3></div><dl class="kv"><dt>Time zone</dt><dd>Asia/Kolkata ${pill({ cls: 'p-muted', label: 'display only' })}</dd><dt>Appearance</dt><dd><button class="link" type="button" data-theme-switch>Switch light / dark</button></dd></dl></section>
    <section class="card col-6"><div class="card-head"><h3>Security</h3></div><ul class="timeline"><li><b>Google sign-in only.</b> No passwords stored.</li><li><b>Owner list on the Mac.</b> Anyone else is refused and logged.</li>
      <li><b>Sessions last 7 days</b> and end at once on sign out.</li><li><b>Keys stay on the Mac.</b> This page never receives them.</li></ul></section></div>`;
}

/** @param {ScreenCtx} ctx */
export function mountSettings(ctx) {
  const load = async () => {
    try {
      const s = await get('/session');
      if (ctx.live()) ctx.redraw(render(s, ($('#me-name')?.textContent ?? '').trim()));
    } catch (e) {
      if (ctx.live()) ctx.redraw(failed(e));
    }
  };
  ctx.redraw(loading('Loading your session…'));
  void load();
  return listen(ctx.view, {
    click: async (e) => {
      const t = /** @type {Element} */ (e.target);
      if (t.closest('[data-retry]')) return void load();
      // The shell's own controls do the work, so sign-out and the theme behave the same everywhere.
      if (t.closest('[data-signout]')) return void $('#signout')?.click();
      if (t.closest('[data-theme-switch]')) return void $('#theme')?.click();
      if (!t.closest('[data-everywhere]')) return;
      const ok = await confirmDialog({ eyebrow: 'Sessions', title: 'Sign out everywhere?', yes: 'Sign out everywhere', text: 'Every browser and phone signed in to the dashboard is signed out, this one too.' });
      if (!ok) return;
      try {
        await post('/session/signout-everywhere');
        location.assign('/dashboard'); // this session has ended too: back to sign-in
      } catch (err) {
        toast(errorText(err));
      }
    },
  });
}
