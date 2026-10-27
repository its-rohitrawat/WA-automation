// Automations (D5 Task 5): the morning briefing. The switch stays off until the spare phone is linked (Link phone opens
// the link dialog); switching on asks "Start sending to the founder?" and sends the confirmation the agent requires.
// Days are a select. Change number takes the number twice; the page only ever shows it masked, and the typed number
// is cleared from the form at once. The preview uses today's real counts.
import { get, post } from '../api.js';
import { $, esc, icon, toast } from '../dom.js';
import { CONNECTIONS_CHANGED } from './connect.js';
import { confirmDialog, errorText, failed, listen, loading, pill } from './ui.js';
import { numbersMatch } from './workLib.js';

/** @typedef {import('./registry.js').ScreenCtx} ScreenCtx */
/** @typedef {{ reportEnabled: boolean, reportDays: string, recipientMasked: string | null, sendAt: string, deadline: string, source: Record<string, 'env' | 'dashboard'> }} Settings */

const STATE_PILL = { ok: 'p-done', warn: 'p-warn', down: 'p-overdue', off: 'p-muted' };

const DAYS = [['weekdays', 'Monday to Friday'], ['mon-sat', 'Monday to Saturday'], ['daily', 'Every day']];

/** @param {{ settings: Settings, spare: { state: string, label: string }, report: { state: string, label: string } | null, counts: { open: number, overdue: number } | null }} d @param {string} [problem] */
function render(d, problem = '') {
  const s = d.settings;
  const linked = d.spare.state === 'ok';
  // Never linked: the first-link dialog. A link that is gone (logged out, refused, unreadable): the relink, which asks first.
  const firstLink = d.spare.label === 'Not linked' || d.spare.state === 'off';
  const dayWords = DAYS.find(([k]) => k === s.reportDays)?.[1] ?? s.reportDays;
  const preview = d.counts
    ? `Good morning. ${d.counts.open} open task${d.counts.open === 1 ? '' : 's'}, ${d.counts.overdue} overdue. Today's tracker: drive.google.com/…`
    : "Good morning. The open and overdue count, and today's tracker link.";
  return `<div class="grid"><section class="card col-7"><div class="card-head"><h3>Morning briefing</h3>${s.reportEnabled ? pill({ cls: /** @type {Record<string, string>} */ (STATE_PILL)[d.report?.state ?? 'ok'] ?? 'p-done', label: d.report?.label && d.report.label !== 'Off' ? `On · ${d.report.label}` : 'On' }) : pill({ cls: 'p-warn', label: 'Off' })}</div>
    <div class="brief-toggle"><div><b>Send the morning briefing</b><small>${!linked ? 'Link the spare phone first.' : !s.recipientMasked ? "Set the founder's number first (Change number)." : esc(`One message to the founder, ${dayWords.toLowerCase()}.`)}</small></div>
      <button class="switch" type="button" role="switch" data-brief aria-checked="${String(Boolean(s.reportEnabled))}" aria-label="Send the morning briefing"${s.reportEnabled || (linked && s.recipientMasked) ? '' : ' disabled'}></button></div>
    <dl class="kv kv-top"><dt>Sends at</dt><dd>${esc(`${s.sendAt} IST, catches up until ${s.deadline}`)}</dd><dt>Days</dt><dd><select class="sel" data-days aria-label="Briefing days">${DAYS.map(([k, l]) => `<option value="${k}"${s.reportDays === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>
        ${s.source.reportDays === 'env' ? '<small class="faint"> · from the Mac\'s settings</small>' : ''}</dd>
      <dt>Time zone</dt><dd>Asia/Kolkata</dd>
      <dt>To</dt><dd>Founder's WhatsApp · ${esc(s.recipientMasked ?? 'not set')} <button class="link" type="button" data-number>Change number</button></dd>
      <dt>From</dt><dd>Spare WhatsApp · ${pill(linked ? { cls: 'p-done', label: 'Linked' } : { cls: 'p-warn', label: d.spare.label || 'Not linked' })}</dd>
      <dt>Message</dt><dd>One short text with the open and overdue count and the tracker link</dd></dl>
    <form class="edit-form" data-numform method="post" hidden novalidate><label><span>New number</span><input name="n1" inputmode="tel" autocomplete="off" maxlength="20" placeholder="91 98765 43210"></label>
      <label><span>Type it again</span><input name="n2" inputmode="tel" autocomplete="off" maxlength="20"></label>${problem ? `<p class="field-err" role="alert">${esc(problem)}</p>` : ''}
      <div class="row-gap"><button class="btn btn-primary btn-sm" type="submit">Save number</button><button class="btn btn-ghost btn-sm" type="button" data-numcancel>Cancel</button></div></form>
    ${linked ? '' : `<div class="note note-row">${icon('phone', 16)}<span class="grow-1">The briefing is sent from the spare phone, so link it before switching this on.</span><button class="btn btn-primary btn-sm" type="button" data-fix="${firstLink ? 'spare-link' : 'spare'}">${icon('phone', 15)}Link phone</button></div>`}
    <div class="note">${icon('info', 16)}<span>Switching this on starts real messages to the founder's number. Every change is recorded in Audit logs.</span></div></section>
  <section class="card col-5"><div class="card-head"><h3>Preview</h3><span class="eyebrow">Today's numbers</span></div>
    <div class="phone"><div class="bar"><i></i><div><b>WA Agent</b><div class="phone-sub">spare number</div></div></div><div class="chat"><div class="msg">${esc(preview)}<small>${esc(s.sendAt)}</small></div></div></div></section></div>`;
}

/** The briefing's line from the shell's status reading (its part's title is label, its state in words is detail). @param {ScreenCtx} ctx */
function reportPart(ctx) {
  const p = ctx.status()?.parts?.find((x) => x.key === 'report');
  return p ? { state: p.state, label: p.detail } : null;
}

/** @param {ScreenCtx} ctx */
export function mountAutomations(ctx) {
  /** @type {Parameters<typeof render>[0] | null} */
  let d = null;
  let busy = false;

  async function load() {
    try {
      const [settings, conn, ov] = await Promise.all([get('/settings'), get('/connections'), get('/overview').catch(() => null)]);
      if (!ctx.live()) return;
      const report = reportPart(ctx);
      const t = ov?.tasks;
      d = { settings, spare: conn.spare, report, counts: t ? { open: t.open + t.overdue + t.review, overdue: t.overdue } : null };
      ctx.redraw(render(d));
    } catch (e) {
      if (ctx.live() && !d) ctx.redraw(failed(e));
    }
  }

  /** @param {Record<string, unknown>} body */
  async function save(body) {
    if (busy || !d) return false;
    busy = true;
    try {
      d.settings = await post('/settings', body);
      if (ctx.live()) ctx.redraw(render(d));
      return true;
    } catch (e) {
      toast(errorText(e));
      return false;
    } finally {
      busy = false;
    }
  }

  ctx.redraw(loading('Loading the briefing settings…'));
  void load();
  // Redraw only when the briefing's own line changed: a redraw on every status refresh would close an open select.
  ctx.onStatus(() => {
    if (!d) return;
    const next = reportPart(ctx);
    if (JSON.stringify(next) === JSON.stringify(d.report)) return;
    d.report = next;
    if (!$('[data-numform]:not([hidden])', ctx.view)) ctx.redraw(render(d));
  });

  // A phone linked from the dialog (Link phone): load again, so the switch unlocks.
  const onLinked = () => void load();
  addEventListener(CONNECTIONS_CHANGED, onLinked);
  const stopListening = listen(ctx.view, {
    click: async (e) => {
      const t = /** @type {Element} */ (e.target);
      if (t.closest('[data-retry]')) return void load();
      if (!d) return;
      if (t.closest('[data-brief]')) {
        if (d.settings.reportEnabled) {
          if (await save({ key: 'reportEnabled', value: false })) toast('Morning briefing switched off.');
          return;
        }
        const ok = await confirmDialog({
          eyebrow: 'Morning briefing', title: 'Start sending to the founder?', yes: 'Turn on',
          text: `The spare phone will send one WhatsApp message to ${d.settings.recipientMasked ?? 'the founder'} each briefing day, with the open and overdue count and the tracker link.`,
        });
        if (ok && (await save({ key: 'reportEnabled', value: true, confirm: true }))) toast('Morning briefing is on.');
        return;
      }
      const form = /** @type {HTMLFormElement | null} */ ($('[data-numform]', ctx.view));
      if (t.closest('[data-number]') && form) {
        form.hidden = false;
        /** @type {HTMLInputElement} */ (form.elements.namedItem('n1')).focus();
        return;
      }
      if (t.closest('[data-numcancel]') && form) {
        form.reset();
        form.hidden = true;
      }
    },
    change: async (e) => {
      const el = /** @type {HTMLSelectElement} */ (e.target);
      if (!el.matches('[data-days]')) return;
      if (await save({ key: 'reportDays', value: el.value })) toast('Briefing days saved.');
    },
    submit: async (e) => {
      e.preventDefault();
      const form = /** @type {HTMLFormElement} */ (e.target);
      const a = /** @type {HTMLInputElement} */ (form.elements.namedItem('n1')).value;
      const b = /** @type {HTMLInputElement} */ (form.elements.namedItem('n2')).value;
      // The typed number leaves the page's form at once, whatever happens next.
      form.reset();
      if (!numbersMatch(a, b)) {
        if (d) ctx.redraw(render(d, 'The two numbers must be the same Indian mobile number, with 91 in front.'));
        const again = /** @type {HTMLFormElement | null} */ ($('[data-numform]', ctx.view));
        if (again) again.hidden = false;
        return;
      }
      if (await save({ key: 'reportRecipient', value: a, confirm: b })) toast('Number saved.');
    },
  });
  return () => {
    removeEventListener(CONNECTIONS_CHANGED, onLinked);
    stopListening();
  };
}
