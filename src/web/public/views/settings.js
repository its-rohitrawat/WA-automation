// Settings (D5 Task 5): the owner, this session, Sign out and Sign out everywhere, the time zone (display only),
// appearance, the security notes, and "Allow sending from the dashboard" (Open chat), off until the owner switches it
// on after reading the ban-risk note. Owners are listed on the Mac, not here.
import { get, post } from '../api.js';
import { $, esc, icon, toast } from '../dom.js';
import { initials, when } from '../format.js';
import { confirmDialog, errorText, failed, listen, loading, pill } from './ui.js';

/** @typedef {import('./registry.js').ScreenCtx} ScreenCtx */

/** The Open chat switch, with what it does and the ban risk. null: the agent did not say. @param {boolean | null} on */
function sendingCard(on) {
  return `<section class="card col-12" id="send-card"><div class="card-head"><h3>Sending from the dashboard</h3>${on === null ? '' : pill(on ? { cls: 'p-warn', label: 'On' } : { cls: 'p-muted', label: 'Off' })}</div>
    <div class="brief-toggle"><div class="grow-1"><b>Allow sending from the dashboard</b><small>Open chat can then reply in an approved client's group, as text, from the founder's WhatsApp. Each message is shown to you and sent only after you confirm it.</small></div>
      <button class="switch" type="button" role="switch" aria-checked="${on === true}" aria-label="Allow sending from the dashboard" data-send-switch${on === null ? ' disabled' : ''}></button></div>
    <div class="note warn-note">${icon('alert', 16)}<span><b>Ban risk.</b> WhatsApp can restrict or ban a number that sends from a linked tool like this one, more so when it sends often. Keep this off unless you need it. Limits stay in place: one message every 3 seconds to a group, 30 an hour in all. Every change here and every message sent is in Audit logs, without the message text.</span></div></section>`;
}

/**
 * @param {{ email: string, createdAt: string, expiresAt: string, browser?: string | null }} s @param {string} name the owner's Google name, from the shell's account menu
 * @param {boolean | null} sending "Allow sending from the dashboard", or null when the agent did not say
 */
function render(s, name, sending) {
  return `<div class="grid">
    <section class="card col-6"><div class="card-head"><h3>Owner</h3></div><div class="owner-row"><div class="avatar avatar-lg">${esc(initials(name, s.email))}</div><div><b>${esc(name || s.email)}</b><div class="muted-p">${esc(name ? `${s.email} · Google` : 'Google sign-in')}</div></div></div>
      <div class="note">${icon('info', 16)}<span>Owners are the Google emails listed on the Mac in .env (DASHBOARD_OWNER_EMAILS). Adding an owner is done there.</span></div></section>
    <section class="card col-6"><div class="card-head"><h3>This session</h3>${pill({ cls: 'p-done', label: 'Active' })}</div><dl class="kv"><dt>Browser</dt><dd>${esc(s.browser || 'Not recorded')}</dd><dt>Signed in</dt><dd>${esc(when(s.createdAt))}</dd><dt>Expires</dt><dd>${esc(when(s.expiresAt))}, or after 24 hours unused</dd></dl>
      <div class="row-gap row-top"><button class="btn btn-ghost" type="button" data-signout>${icon('logout', 16)}Sign out</button><button class="btn btn-ghost" type="button" data-everywhere>${icon('logout', 16)}Sign out everywhere</button></div></section>
    <section class="card col-6"><div class="card-head"><h3>Preferences</h3></div><dl class="kv"><dt>Time zone</dt><dd>Asia/Kolkata ${pill({ cls: 'p-muted', label: 'display only' })}</dd><dt>Appearance</dt><dd><button class="link" type="button" data-theme-switch>Switch light / dark</button></dd></dl></section>
    <section class="card col-6"><div class="card-head"><h3>Security</h3></div><ul class="timeline"><li><b>Google sign-in only.</b> No passwords stored.</li><li><b>Owner list on the Mac.</b> Anyone else is refused and logged.</li>
      <li><b>Sessions last 7 days</b> and end at once on sign out.</li><li><b>Keys stay on the Mac.</b> This page never receives them.</li></ul></section>
    ${sendingCard(sending)}</div>`;
}

/** @param {ScreenCtx} ctx */
export function mountSettings(ctx) {
  const load = async () => {
    try {
      const [s, settings] = await Promise.all([get('/session'), get('/settings').catch(() => null)]);
      const sending = typeof settings?.dashboardSend === 'boolean' ? settings.dashboardSend : null;
      if (ctx.live()) ctx.redraw(render(s, ($('#me-name')?.textContent ?? '').trim(), sending));
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
      const sw = /** @type {HTMLButtonElement | null} */ (t.closest('[data-send-switch]'));
      if (sw && !sw.disabled) {
        const next = sw.getAttribute('aria-checked') !== 'true';
        if (next) {
          const yes = await confirmDialog({
            eyebrow: 'Sending from the dashboard',
            title: "Allow sending from the founder's WhatsApp?",
            yes: 'Allow sending',
            text: 'WhatsApp can restrict or ban a number that sends from a linked tool like this one. Open chat will send only text you confirm, one message at a time, to approved client groups. You can switch this off again here.',
          });
          if (!yes) return;
        }
        sw.disabled = true;
        try {
          const v = await post('/settings', next ? { key: 'dashboardSend', value: true, confirm: true } : { key: 'dashboardSend', value: false });
          if (!ctx.live()) return;
          const card = $('#send-card', ctx.view);
          if (card) card.outerHTML = sendingCard(v?.dashboardSend === true);
          toast(v?.dashboardSend === true ? 'Sending from the dashboard is on.' : 'Sending from the dashboard is off.');
        } catch (err) {
          sw.disabled = false;
          toast(errorText(err), false);
        }
        return;
      }
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
