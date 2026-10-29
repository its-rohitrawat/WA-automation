// System › Invite a customer (SaaS design section 5): the founder invites a business by name and Gmail address. The
// invite goes from the founder's Gmail, or by Copy link, which always works (Gmail connected or not). A link works once,
// for that Google account only, for 7 days. Copy link and Resend make a new link (the earlier one stops working). Every
// value from the agent goes through esc().
import { ApiError, get, post } from '../api.js';
import { esc, icon, toast } from '../dom.js';
import { when } from '../format.js';
import { openModal } from './drawer.js';
import { confirmDialog, failed, listen, loading, pill } from './ui.js';

/** @typedef {import('./registry.js').ScreenCtx} ScreenCtx */
/**
 * @typedef {{ id: string, business: string, email: string, status: 'open' | 'accepted' | 'cancelled' | 'expired',
 *   send: 'none' | 'sending' | 'sent' | 'failed' | 'unknown', createdAt: string, expiresAt: string, sentAt: string | null,
 *   usedAt: string | null }} Invite
 */

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATUSES = ['open', 'accepted', 'cancelled', 'expired'];
const SENDS = ['none', 'sending', 'sent', 'failed', 'unknown'];
const str = (/** @type {unknown} */ v) => (typeof v === 'string' ? v : '');

/** The invite list from the agent, checked field by field. @param {unknown} raw */
function readInvites(raw) {
  const r = raw && typeof raw === 'object' ? /** @type {Record<string, any>} */ (raw) : {};
  const list = Array.isArray(r.invites) ? r.invites : [];
  return {
    /** @type {Invite[]} */
    invites: list
      .map((/** @type {any} */ x) => ({
        id: str(x?.id), business: str(x?.business).slice(0, 80), email: str(x?.email).slice(0, 254),
        status: STATUSES.includes(x?.status) ? x.status : 'cancelled', send: SENDS.includes(x?.send) ? x.send : 'none',
        createdAt: str(x?.createdAt), expiresAt: str(x?.expiresAt), sentAt: x?.sentAt ? str(x.sentAt) : null, usedAt: x?.usedAt ? str(x.usedAt) : null,
      }))
      .filter((/** @type {Invite} */ v) => ID.test(v.id)),
    left: typeof r.left === 'number' ? r.left : 0,
    perDay: typeof r.perDay === 'number' ? r.perDay : 20,
    gmail: { connected: r.gmail?.connected === true, from: typeof r.gmail?.from === 'string' ? r.gmail.from : null },
  };
}

/** The status pill: what the founder needs to know about this invite. @param {Invite} v */
function statusPill(v) {
  if (v.status === 'accepted') return pill({ cls: 'p-done', label: 'Accepted' });
  if (v.status === 'expired') return pill({ cls: 'p-muted', label: 'Expired' });
  if (v.status === 'cancelled') return pill({ cls: 'p-muted', label: 'Cancelled' });
  if (v.send === 'unknown') return pill({ cls: 'p-warn', label: 'Unknown, check Gmail' });
  if (v.send === 'failed') return pill({ cls: 'p-overdue', label: 'Not sent' });
  if (v.send === 'sending') return pill({ cls: 'p-review', label: 'Sending…' });
  if (v.send === 'sent') return pill({ cls: 'p-review', label: 'Sent' });
  return pill({ cls: 'p-review', label: 'Link copied' });
}

/** @param {Invite} v @param {boolean} gmail */
function row(v, gmail) {
  const open = v.status === 'open' || v.status === 'expired';
  const acts = open
    ? [
        gmail ? `<button class="btn btn-ghost btn-sm" type="button" data-resend="${esc(v.id)}">${icon('refresh', 15)}${v.status === 'expired' ? 'Send again' : 'Resend'}</button>` : '',
        `<button class="btn btn-ghost btn-sm" type="button" data-copy="${esc(v.id)}">${icon('link', 15)}Copy link</button>`,
        `<button class="btn btn-ghost btn-sm pf-danger" type="button" data-cancel="${esc(v.id)}">${icon('close', 15)}Cancel</button>`,
      ].join('')
    : '';
  const sent = v.sentAt ?? v.createdAt;
  const after = v.status === 'accepted' ? `Used ${when(v.usedAt)}` : v.status === 'cancelled' ? 'Link no longer works' : `expires ${when(v.expiresAt)}`;
  return `<tr><td data-label="Business"><b>${esc(v.business)}</b><small class="pf-sub pf-mono">${esc(v.email)}</small></td>
    <td data-label="Status">${statusPill(v)}</td>
    <td data-label="Sent" class="pf-when">${esc(when(sent))}<small class="pf-sub">${esc(after)}</small></td>
    <td data-label="Actions"><div class="pf-acts">${acts || '<span class="pf-faint">—</span>'}</div></td></tr>`;
}

/**
 * @param {ReturnType<typeof readInvites>} d @param {{ problem?: string | null, business?: string, email?: string, busy?: boolean }} f
 */
function render(d, f) {
  const gmail = d.gmail.connected;
  const unknown = d.invites.some((v) => v.status === 'open' && v.send === 'unknown');
  return `<div class="grid">
    <section class="card col-4 pf-col-form"><div class="card-head"><h3>New invite</h3><span class="eyebrow">${d.left} of ${d.perDay} left today</span></div>
      <form class="pf-stack" data-invite novalidate>
        <label class="pf-lbl"><span>Business name</span><input class="pf-inp" name="business" maxlength="80" autocomplete="off" placeholder="Kapoor Design Studio" value="${esc(f.business ?? '')}"></label>
        <label class="pf-lbl"><span>Their Gmail address</span><input class="pf-inp" name="email" type="email" maxlength="254" autocomplete="off" spellcheck="false" placeholder="name@example.com" value="${esc(f.email ?? '')}">
          <small>They must sign in with exactly this Google account.</small></label>
        ${f.problem ? `<p class="pf-err" role="alert">${esc(f.problem)}</p>` : ''}
        <div class="pf-row"><button class="btn btn-primary" type="submit"${gmail && !f.busy && d.left > 0 ? '' : ' disabled'}>${icon('mail', 16)}Send invite</button>
          <button class="btn btn-ghost" type="button" data-copy-new${f.busy || d.left <= 0 ? ' disabled' : ''}>${icon('link', 16)}Copy link</button></div>
      </form>
      <div class="note">${icon('info', 16)}<span>${gmail
        ? `Sent from your Gmail, <code class="pf-note-code">${esc(d.gmail.from ?? '')}</code>.`
        : 'Gmail is not connected for invites, so Send invite is off.'} The link works once, only for that Google account, and expires in 7 days. ${gmail ? 'Gmail not working? ' : ''}Use Copy link and send it yourself.</span></div>
    </section>
    <section class="card col-8 pf-col-list"><div class="card-head"><h3>Invites</h3><span class="eyebrow">${d.invites.length} total</span></div>
      ${d.invites.length
        ? `<div class="tbl-wrap"><table class="tbl tbl-cards pf-inv"><caption class="sr-only">Invites</caption>
          <thead><tr><th>Business</th><th>Status</th><th>Sent</th><th>Actions</th></tr></thead><tbody>${d.invites.map((v) => row(v, gmail)).join('')}</tbody></table></div>`
        : '<div class="empty">No invites yet.</div>'}
      ${unknown ? `<div class="note">${icon('alert', 16)}<span><b>Unknown</b> means Gmail did not answer clearly. It is not sent again by itself: check the Sent folder, then Resend or Cancel.</span></div>` : ''}
      <div class="note">${icon('link', 16)}<span>Copy link and Resend make a new link. Any earlier link for that invite stops working.</span></div>
    </section></div>`;
}

/** Copies the link; when the browser refuses, shows it to select by hand, so Copy link always works. @param {string} link @param {string} done */
async function copyLink(link, done) {
  try {
    await navigator.clipboard.writeText(link);
    toast(done);
  } catch {
    const el = openModal(`<div class="m-head"><div><span class="eyebrow">Invite link</span><h2>Copy this link</h2></div></div>
      <p class="m-p">Your browser did not allow copying. Select the link and copy it, then send it to them yourself.</p>
      <div class="pf-link-box"><input class="pf-inp" readonly value="${esc(link)}" aria-label="Invite link"></div>
      <div class="m-foot"><button class="btn btn-primary" type="button" data-close>Done</button></div>`);
    const input = /** @type {HTMLInputElement | null} */ (el.querySelector('input'));
    input?.focus();
    input?.select();
  }
}

/** @param {ScreenCtx} ctx */
export function mountInvite(ctx) {
  /** @type {ReturnType<typeof readInvites> | null} */
  let data = null;
  /** @type {{ problem?: string | null, business?: string, email?: string, busy?: boolean }} */
  let form = {};

  const draw = () => {
    if (ctx.live() && data) ctx.redraw(render(data, form));
  };
  const load = async () => {
    try {
      const next = readInvites(await get('/platform/invites'));
      if (!ctx.live()) return;
      data = next;
      draw();
    } catch (e) {
      if (ctx.live() && !data) ctx.redraw(failed(e));
    }
  };
  const values = () => {
    const f = /** @type {HTMLFormElement | null} */ (ctx.view.querySelector('[data-invite]'));
    const fd = f ? new FormData(f) : null;
    return { business: String(fd?.get('business') ?? '').trim(), email: String(fd?.get('email') ?? '').trim() };
  };
  /** A new invite: emailed (send) or its link copied. @param {boolean} send */
  const create = async (send) => {
    const v = values();
    if (!v.business) return ((form = { ...v, problem: 'Enter the business name.' }), draw());
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) return ((form = { ...v, problem: 'Enter their Gmail address, like name@example.com.' }), draw());
    form = { ...v, busy: true };
    draw();
    try {
      const r = await post('/platform/invites', { business: v.business, email: v.email, send });
      if (!ctx.live()) return;
      form = {};
      await load();
      const to = str(r?.invite?.email);
      if (!send) await copyLink(str(r?.link), `Invite created for ${v.business}. Link copied: send it to ${to} yourself.`);
      else if (r?.email === 'sent') toast(`Invite sent to ${to} from your Gmail.`);
      else if (r?.email === 'unknown') toast('Gmail did not answer clearly. Check your Sent folder before sending again.', false);
      else toast('The email was not sent. Use Copy link on the invite and send it yourself.', false);
    } catch (e) {
      if (!ctx.live()) return;
      form = { ...v, problem: e instanceof ApiError ? e.message : 'The invite could not be made. Try again.' };
      draw();
    }
  };

  ctx.redraw(loading('Loading the invites…'));
  void load();
  ctx.poll(load, 30_000);

  return listen(ctx.view, {
    submit: (e) => {
      e.preventDefault();
      void create(true);
    },
    click: async (e) => {
      const t = /** @type {Element} */ (e.target);
      if (t.closest('[data-retry]')) return void load();
      if (t.closest('[data-copy-new]')) return void create(false);
      const b = /** @type {HTMLButtonElement | null} */ (t.closest('[data-copy],[data-resend],[data-cancel]'));
      if (!b || b.disabled) return;
      const id = b.dataset.copy ?? b.dataset.resend ?? b.dataset.cancel ?? '';
      const v = data?.invites.find((x) => x.id === id);
      if (!v) return;
      if (b.dataset.cancel) {
        const yes = await confirmDialog({ eyebrow: 'Invite', title: `Cancel the invite for ${v.business}?`, yes: 'Cancel invite', text: 'The link stops working at once. You can invite them again later.' });
        if (!yes) return;
      } else {
        const yes = await confirmDialog({
          eyebrow: 'Invite', yes: b.dataset.copy ? 'Copy a new link' : 'Send a new link',
          title: b.dataset.copy ? `Copy a new link for ${v.business}?` : `Send a new link to ${v.email}?`,
          text: 'Any earlier link for this invite stops working. The new one works once, for that Google account, for 7 days.',
        });
        if (!yes) return;
      }
      b.disabled = true;
      try {
        if (b.dataset.cancel) {
          await post(`/platform/invites/${id}/cancel`);
          toast(`Invite for ${v.business} cancelled. The link no longer works.`);
        } else if (b.dataset.copy) {
          const r = await post(`/platform/invites/${id}/link`);
          await copyLink(str(r?.link), `New link copied for ${v.business}. It works once, for ${v.email} only.`);
        } else {
          const r = await post(`/platform/invites/${id}/resend`);
          if (r?.email === 'sent') toast(`Invite sent again to ${v.email}.`);
          else if (r?.email === 'unknown') toast('Gmail did not answer clearly. Check your Sent folder before sending again.', false);
          else toast('The email was not sent. Use Copy link and send it yourself.', false);
        }
      } catch (err) {
        toast(err instanceof ApiError ? err.message : 'That did not work. Try again.', false);
      }
      if (ctx.live()) await load();
    },
  });
}
