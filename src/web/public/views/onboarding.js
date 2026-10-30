// Getting started (SaaS design section 6): the new customer's checklist. Six steps: WhatsApp and the API key are needed,
// the spare number is optional, and the rest unlock once those two are done. Steps whose part of the customer workspace
// is not built yet say so ("coming with the customer workspace"). Every value from the agent goes through esc().
import { ApiError, get, post } from '../api.js';
import { esc, icon, toast } from '../dom.js';
import { confirmDialog, failed, listen, loading, pill } from './ui.js';

/** @typedef {import('./registry.js').ScreenCtx} ScreenCtx */
/**
 * @typedef {{ id: string, title: string, text: string, need: boolean, optional: boolean, coming: string,
 *   state: 'done' | 'todo' | 'coming' | 'locked' }} Step
 * @typedef {{ business: string, status: string, founderName: string, steps: Step[], done: number, total: number, live: boolean,
 *   works: { saving: boolean, ai: boolean, screens: boolean, tracker: boolean, report: boolean } }} Onboarding
 */

const STATES = ['done', 'todo', 'coming', 'locked'];
const ICONS = /** @type {Record<string, string>} */ ({ whatsapp: 'msg', key: 'key', spare: 'phone', drive: 'cloud', groups: 'users', report: 'clock' });
const str = (/** @type {unknown} */ v) => (typeof v === 'string' ? v : '');

/** The checklist from the agent, checked field by field. @param {unknown} raw @returns {Onboarding} */
function readOnboarding(raw) {
  const r = raw && typeof raw === 'object' ? /** @type {Record<string, any>} */ (raw) : {};
  const w = r.works && typeof r.works === 'object' ? r.works : {};
  return {
    business: str(r.business).slice(0, 80), status: str(r.status), founderName: str(r.founderName).slice(0, 100) || 'The person who runs WA Agent',
    steps: (Array.isArray(r.steps) ? r.steps : []).map((/** @type {any} */ s) => ({
      id: str(s?.id), title: str(s?.title).slice(0, 80), text: str(s?.text).slice(0, 200), need: s?.need === true, optional: s?.optional === true,
      coming: str(s?.coming).slice(0, 300), state: STATES.includes(s?.state) ? s.state : 'locked',
    })).filter((/** @type {Step} */ s) => s.id in ICONS),
    done: typeof r.done === 'number' ? r.done : 0, total: typeof r.total === 'number' && r.total > 0 ? r.total : 6, live: r.live === true,
    works: { saving: w.saving === true, ai: w.ai === true, screens: w.screens === true, tracker: w.tracker === true, report: w.report === true },
  };
}

/** @param {Step} s */
function statePill(s) {
  if (s.state === 'done') return pill({ cls: 'p-done', label: 'Done' });
  if (s.state === 'locked') return pill({ cls: 'p-muted', label: 'Locked' });
  if (s.state === 'coming') return pill({ cls: 'p-muted', label: 'Coming soon' });
  if (s.optional) return pill({ cls: 'p-muted', label: 'Optional' });
  return s.need ? pill({ cls: 'p-warn', label: 'Needed' }) : pill({ cls: 'p-review', label: 'To do' });
}

/**
 * Step 2, the customer's own Anthropic key: a password field, tested and stored encrypted by the agent. The key is never
 * shown again or put back in the page; the field is emptied as soon as it is sent. @param {Step} s
 */
function keyPanel(s) {
  const done = s.state === 'done';
  return `<form class="pf-stack" data-key-form autocomplete="off">
      <p class="muted-p">${done
        ? `${icon('ok', 16)} Your key is set. It is never shown again; you can replace or remove it.`
        : 'Paste a key from console.anthropic.com, under API keys. WA Agent tests it once, then stores it encrypted for your workspace only. It is never shown again, and the AI work bills to it.'}</p>
      <label class="pf-lbl"><span>${done ? 'A new key' : 'Your Anthropic API key'}</span>
        <input class="pf-inp" type="password" name="key" maxlength="400" placeholder="sk-ant-…" autocomplete="off" spellcheck="false" required></label>
      <div class="pf-row"><button class="btn btn-primary btn-sm" type="submit">${icon('key', 15)}${done ? 'Test and replace' : 'Test and save'}</button>
        ${done ? '<button class="btn btn-ghost btn-sm pf-danger" type="button" data-key-remove>Remove key</button>' : ''}</div></form>`;
}

/** @param {Step} s */
function body(s) {
  if (s.id === 'key' && (s.state === 'todo' || s.state === 'done')) return keyPanel(s);
  if (s.state === 'done') return `<p class="pf-faint">${icon('ok', 16)} Done.</p>`;
  return `<div class="pf-coming">${icon('clock', 16)}<span><b>Coming with the customer workspace.</b> ${esc(s.coming)}</span></div>`;
}

/** @param {Onboarding} d @param {string | null} open */
function render(d, open) {
  const steps = d.steps.map((s, i) => {
    const locked = s.state === 'locked';
    const isOpen = open === s.id && !locked;
    return `<li class="pf-step${s.state === 'done' ? ' done' : ''}${locked ? ' locked' : ''}${isOpen ? ' open' : ''}">
      <button class="pf-step-head" type="button" data-open="${esc(s.id)}"${locked ? ' aria-disabled="true"' : ''} aria-expanded="${isOpen}">
        <span class="pf-num">${s.state === 'done' ? icon('tick', 16) : locked ? icon('lock', 15) : i + 1}</span>
        <span class="pf-step-txt"><b>${icon(ICONS[s.id] ?? 'task', 15)} ${esc(s.title)}</b><small>${esc(locked ? 'Unlocks after WhatsApp and your API key.' : s.text)}</small></span>
        <span class="pf-step-st">${statePill(s)}${locked ? '' : icon('chev', 16)}</span></button>
      ${isOpen ? `<div class="pf-step-body">${body(s)}</div>` : ''}</li>`;
  }).join('');
  const work = (/** @type {boolean} */ on, /** @type {string} */ text) => `<li class="${on ? 'yes' : ''}">${icon(on ? 'ok' : 'lock', 16)}<span>${esc(text)}</span></li>`;
  return `<div class="grid">
    <section class="card col-12 pf-ob-top"><div class="pf-ob-hello"><div><span class="eyebrow">${esc(d.business)}</span><h2>Welcome. Let's connect your workspace.</h2>
        <p class="muted-p">${d.live ? 'WA Agent is reading your approved groups. Finish the rest when you have a minute.' : 'WA Agent starts reading once WhatsApp and your API key are both done. Everything else can follow.'}</p></div>
        <div class="pf-ob-prog">${pill(d.live ? { cls: 'p-done', label: 'Active' } : { cls: 'p-warn', label: 'Onboarding' })}<b>${d.done} of ${d.total} done</b></div></div>
      <div class="pf-bar" role="progressbar" aria-label="Setup progress" aria-valuemin="0" aria-valuemax="${d.total}" aria-valuenow="${d.done}"><i data-progress="${Math.round((d.done / d.total) * 100)}"></i></div></section>
    <section class="card col-8 pf-col-steps"><ol class="pf-steps">${steps}</ol></section>
    <aside class="card col-4 pf-col-side"><div class="card-head"><h3>What works now</h3></div>
      <ul class="pf-unlock">
        ${work(d.works.saving, 'Saving messages from approved groups')}
        ${work(d.works.ai, 'Finding tasks with AI')}
        ${work(d.works.screens, 'Clients, Tasks and Meetings screens')}
        ${work(d.works.tracker, 'Tracker on your Google Drive')}
        ${work(d.works.report, 'Morning report on WhatsApp')}
      </ul>
      <div class="note">${icon('shield', 16)}<span>Your data is kept apart from every other business on WA Agent. ${esc(d.founderName)}, who runs WA Agent, sees only your setup progress, never your messages or tasks.</span></div></aside></div>`;
}

/** @param {ScreenCtx} ctx */
export function mountOnboarding(ctx) {
  /** @type {Onboarding | null} */
  let data = null;
  /** The open step: the first one not done and not locked, until the owner picks another. @type {string | null | undefined} */
  let open;

  const draw = () => {
    if (!ctx.live() || !data) return;
    if (open === undefined) open = data.steps.find((s) => s.state !== 'done' && s.state !== 'locked')?.id ?? null;
    ctx.redraw(render(data, open));
    // The bar's width is set here, not in the markup: the page allows no inline styles.
    const bar = /** @type {HTMLElement | null} */ (ctx.view.querySelector('[data-progress]'));
    if (bar) bar.style.width = `${Number(bar.dataset.progress) || 0}%`;
  };
  /** Someone is typing a key: the 30 s refresh must not redraw the field away. */
  const typing = () => {
    const input = /** @type {HTMLInputElement | null} */ (ctx.view.querySelector('[data-key-form] input'));
    return input !== null && (input.value !== '' || document.activeElement === input);
  };
  const load = async () => {
    try {
      const next = readOnboarding(await get('/platform/onboarding'));
      if (!ctx.live()) return;
      data = next;
      if (!typing()) draw();
    } catch (e) {
      if (ctx.live() && !data) ctx.redraw(failed(e));
    }
  };

  ctx.redraw(loading('Loading your checklist…'));
  void load();
  ctx.poll(load, 30_000);

  /** @param {unknown} err */
  const refused = (err) => toast(err instanceof ApiError ? err.message : 'That did not work. Try again.', false);

  return listen(ctx.view, {
    submit: async (e) => {
      const form = /** @type {HTMLFormElement} */ (e.target);
      if (!form.matches('[data-key-form]')) return;
      e.preventDefault();
      const input = /** @type {HTMLInputElement} */ (form.elements.namedItem('key'));
      const button = /** @type {HTMLButtonElement} */ (form.querySelector('[type="submit"]'));
      const key = input.value.trim();
      input.value = ''; // never kept in the page, whatever the answer
      if (!key || button.disabled) return;
      button.disabled = true;
      try {
        await post('/platform/ai-key', { key });
        toast('Key tested and saved. It is never shown again.');
        await load();
      } catch (err) {
        refused(err);
      } finally {
        button.disabled = false;
      }
    },
    click: async (e) => {
      const t = /** @type {Element} */ (e.target);
      if (t.closest('[data-retry]')) return void load();
      if (t.closest('[data-key-remove]')) {
        const yes = await confirmDialog({ eyebrow: 'Your API key', title: 'Remove your key?', yes: 'Remove', text: 'The AI work stops until you add a key again. Your saved messages are kept.' });
        if (!yes) return;
        try {
          await post('/platform/ai-key/remove', {});
          toast('Key removed.');
          await load();
        } catch (err) {
          refused(err);
        }
        return;
      }
      const head = /** @type {HTMLElement | null} */ (t.closest('[data-open]'));
      if (!head) return;
      if (head.getAttribute('aria-disabled') === 'true') return toast('Finish WhatsApp and your API key first.', false);
      open = open === head.dataset.open ? null : head.dataset.open ?? null;
      draw();
    },
  });
}
