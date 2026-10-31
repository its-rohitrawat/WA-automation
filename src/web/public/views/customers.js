// System › Customers (SaaS design section 4.3): every business on WA Agent with its status, onboarding step, last
// activity, memory and AI key state. Setup and health only: never a customer's messages, tasks, files or keys. Pause and
// Resume are here; inviting is on the Invite screen. Every value from the agent goes through esc().
import { ApiError, get, post } from '../api.js';
import { esc, icon, toast } from '../dom.js';
import { ago, date } from '../format.js';
import { confirmDialog, failed, listen, loading, pill } from './ui.js';

/** @typedef {import('./registry.js').ScreenCtx} ScreenCtx */
/**
 * @typedef {{ id: string, name: string, founder: boolean, status: string, createdAt: string, signedUpAt: string | null,
 *   updatedAt: string, lastActivityAt: string | null, onboarding: { done: number, total: number, next: string | null } | null,
 *   memoryMb: number | null, aiKey: 'configured' | 'missing' | null, runtime: string | null }} Customer
 */

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATUSES = ['invited', 'onboarding', 'active', 'paused'];
const str = (/** @type {unknown} */ v) => (typeof v === 'string' ? v : '');
const num = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The list from the agent, checked field by field. @param {unknown} raw */
function readCustomers(raw) {
  const r = raw && typeof raw === 'object' ? /** @type {Record<string, any>} */ (raw) : {};
  const c = r.counts && typeof r.counts === 'object' ? r.counts : {};
  return {
    /** @type {Customer[]} */
    customers: (Array.isArray(r.customers) ? r.customers : []).map((/** @type {any} */ x) => ({
      id: str(x?.id), name: str(x?.name).slice(0, 80), founder: x?.founder === true, status: STATUSES.includes(x?.status) ? x.status : 'paused',
      createdAt: str(x?.createdAt), signedUpAt: x?.signedUpAt ? str(x.signedUpAt) : null, updatedAt: str(x?.updatedAt), lastActivityAt: x?.lastActivityAt ? str(x.lastActivityAt) : null,
      onboarding: x?.onboarding && typeof x.onboarding === 'object'
        ? { done: num(x.onboarding.done) ?? 0, total: num(x.onboarding.total) ?? 6, next: x.onboarding.next ? str(x.onboarding.next).slice(0, 80) : null }
        : null,
      memoryMb: num(x?.memoryMb), aiKey: x?.aiKey === 'configured' || x?.aiKey === 'missing' ? x.aiKey : null,
      runtime: typeof x?.runtime === 'string' && x.runtime in RUNTIME_NOTE ? x.runtime : null,
    })).filter((/** @type {Customer} */ x) => ID.test(x.id)),
    maxActive: num(r.maxActive) ?? 20,
    counts: { active: num(c.active) ?? 0, onboarding: num(c.onboarding) ?? 0, invited: num(c.invited) ?? 0, paused: num(c.paused) ?? 0 },
    memoryMb: num(r.memoryMb),
  };
}

/** The Supervisor's runtime states worth a word under the status (running and stopped need none). */
const RUNTIME_NOTE = /** @type {Record<string, string>} */ ({
  starting: 'Starting',
  backoff: 'Restarting after a crash',
  failing: 'Keeps crashing; retried every 5 min',
  'refused:limit': 'Over the active limit',
  'refused:memory': 'Not enough memory to start',
  'refused:postgres': 'Needs the Postgres switch',
  running: '',
  stopped: '',
});

const STATUS_PILL = /** @type {Record<string, { cls: string, label: string }>} */ ({
  active: { cls: 'p-done', label: 'Active' }, onboarding: { cls: 'p-warn', label: 'Onboarding' }, invited: { cls: 'p-review', label: 'Invited' }, paused: { cls: 'p-muted', label: 'Paused' },
});

/** "customer #1 · you", "since 27 Oct", "invite sent 29 Oct", "paused 25 Oct". @param {Customer} c */
function note(c) {
  if (c.founder) return 'customer #1 · you';
  if (c.status === 'invited') return `invite sent ${date(c.createdAt)}`;
  if (c.status === 'paused') return `paused ${date(c.updatedAt)}`;
  return `since ${date(c.signedUpAt ?? c.createdAt)}`;
}

/** @param {Customer} c */
function onboardingText(c) {
  if (c.founder) return 'Done';
  if (!c.onboarding) return 'Not signed up';
  if (c.onboarding.done >= c.onboarding.total) return 'Done';
  return `${c.onboarding.done} of ${c.onboarding.total}${c.onboarding.next ? ` · ${c.onboarding.next} next` : ''}`;
}

/** @param {Customer} c */
function action(c) {
  if (c.founder) return '<span class="pf-faint">—</span>';
  if (c.status === 'active' || c.status === 'onboarding') return `<button class="btn btn-ghost btn-sm" type="button" data-pause="${esc(c.id)}">Pause</button>`;
  if (c.status === 'paused') return `<button class="btn btn-ghost btn-sm" type="button" data-resume="${esc(c.id)}">Resume</button>`;
  return `<a class="btn btn-ghost btn-sm" href="/dashboard/invite" data-go="invite">Invite</a>`;
}

/** @param {ReturnType<typeof readCustomers>} d */
function render(d) {
  const rows = d.customers.map((c) => {
    const key = c.aiKey === 'configured' ? pill({ cls: 'p-done', label: 'Configured' }) : c.aiKey === 'missing' ? pill({ cls: 'p-muted', label: 'Missing' }) : '<span class="pf-faint">—</span>';
    return `<tr><td data-label="Customer"><b>${esc(c.name)}</b><small class="pf-sub">${esc(note(c))}</small></td>
      <td data-label="Status">${pill(STATUS_PILL[c.status] ?? STATUS_PILL.paused)}${c.runtime && RUNTIME_NOTE[c.runtime] ? `<small class="pf-sub pf-run">${esc(RUNTIME_NOTE[c.runtime])}</small>` : ''}</td>
      <td data-label="Onboarding">${esc(onboardingText(c))}</td>
      <td data-label="Last activity">${esc(c.lastActivityAt ? ago(c.lastActivityAt) : '—')}</td>
      <td data-label="Memory (share)" class="pf-num-cell">${c.memoryMb === null ? '—' : `${esc(c.memoryMb)} MB`}</td>
      <td data-label="AI key">${key}</td><td data-label="">${action(c)}</td></tr>`;
  }).join('');
  const share = Math.round((d.counts.active / Math.max(1, d.maxActive)) * 100);
  return `<div class="pf-kpis">
      <div class="card pf-kpi"><span class="eyebrow">Active</span><b>${d.counts.active}<small> of ${d.maxActive} max</small></b><div class="pf-bar"><i data-progress="${share}"></i></div></div>
      <div class="card pf-kpi"><span class="eyebrow">Onboarding</span><b>${d.counts.onboarding}</b><small>signed up, setting up</small></div>
      <div class="card pf-kpi"><span class="eyebrow">Invited</span><b>${d.counts.invited}</b><small>not signed up yet</small></div>
      <div class="card pf-kpi"><span class="eyebrow">Memory in use</span><b>${d.memoryMb === null ? '—' : `${d.memoryMb}<small> MB</small>`}</b><small>${d.memoryMb === null ? 'shown once customer workspaces run' : 'each running customer’s share; about 60 to 120 MB each'}</small></div>
    </div>
    <section class="card flush"><div class="card-head pf-cust-head"><h3>Customers</h3><div class="act"><a class="btn btn-primary btn-sm" href="/dashboard/invite" data-go="invite">${icon('mail', 15)}Invite a customer</a></div></div>
      <div class="tbl-wrap"><table class="tbl tbl-cards pf-cust"><caption class="sr-only">Customers</caption>
        <thead><tr><th>Customer</th><th>Status</th><th>Onboarding</th><th>Last activity</th><th>Memory (share)</th><th>AI key</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></section>
    <div class="note">${icon('lock', 16)}<span>This screen shows only setup and health. Each customer's messages, tasks, files and keys stay in their own workspace and are never shown here. Memory is each running customer's share of what the workspaces add: one program cannot measure one customer alone. The limit of ${d.maxActive} active customers is a setting on the Mac.</span></div>`;
}

/** @param {ScreenCtx} ctx */
export function mountCustomers(ctx) {
  /** @type {ReturnType<typeof readCustomers> | null} */
  let data = null;
  const draw = () => {
    if (!ctx.live() || !data) return;
    ctx.redraw(render(data));
    // The bar's width is set here, not in the markup: the page allows no inline styles.
    const bar = /** @type {HTMLElement | null} */ (ctx.view.querySelector('[data-progress]'));
    if (bar) bar.style.width = `${Math.min(100, Number(bar.dataset.progress) || 0)}%`;
  };
  const load = async () => {
    try {
      const next = readCustomers(await get('/platform/customers'));
      if (!ctx.live()) return;
      data = next;
      draw();
    } catch (e) {
      if (ctx.live() && !data) ctx.redraw(failed(e));
    }
  };
  ctx.redraw(loading('Loading the customers…'));
  void load();
  ctx.poll(load, 30_000);

  return listen(ctx.view, {
    click: async (e) => {
      const t = /** @type {Element} */ (e.target);
      if (t.closest('[data-retry]')) return void load();
      const b = /** @type {HTMLButtonElement | null} */ (t.closest('[data-pause],[data-resume]'));
      if (!b || b.disabled) return;
      const id = b.dataset.pause ?? b.dataset.resume ?? '';
      const c = data?.customers.find((x) => x.id === id);
      if (!c) return;
      if (b.dataset.pause) {
        const yes = await confirmDialog({ eyebrow: 'Customers', title: `Pause ${c.name}?`, yes: 'Pause', text: 'Their WhatsApp reader and AI work stop. Nothing is deleted, and you can resume them later.' });
        if (!yes) return;
      }
      b.disabled = true;
      try {
        data = readCustomers(await post(`/platform/customers/${id}/${b.dataset.pause ? 'pause' : 'resume'}`));
        toast(b.dataset.pause ? `${c.name} paused. Nothing was deleted.` : `${c.name} resumed.`);
        draw();
      } catch (err) {
        b.disabled = false;
        toast(err instanceof ApiError ? err.message : 'That did not work. Try again.', false);
      }
    },
  });
}
