// Meetings (D4 Task 6): the segmented filter kept in the address, the list, and the drawer with the summary, the action
// items, Assign (a client select), Skip, Retry ("This costs money. Continue?") and Open summary doc. Titles and
// summaries are meeting text: they go through esc().
import { get, post } from '../api.js';
import { esc, icon, toast } from '../dom.js';
import { when } from '../format.js';
import { confirmDialog, empty, errorText, failed, listen, loading, openDrawer, pill, refillDrawer, setQuery } from './ui.js';
import { meetingPill, readList, taskPill } from './workLib.js';

/** @typedef {import('./registry.js').ScreenCtx} ScreenCtx */
/**
 * @typedef {{ id: number, title: string, when: string, minutes: number | null, account: string | null, client: { code: string, name: string } | null,
 *   status: string, stageLabel: string, actionItems: number, docUrl: string | null }} MeetingRow
 * @typedef {MeetingRow & { summary: { whatHappened: string, discussion: { topic: string, summary: string }[], decisions: string[], openQuestions: string[], conclusion: string } | null,
 *   actionItemTasks: { code: string, title: string, owner: string | null, deadline: string | null, status: string }[] }} MeetingDetail
 */

const VIEWS = [['all', 'All'], ['ready', 'Summary ready'], ['progress', 'In progress'], ['attention', 'Needs attention']];
const POLL_MS = 30_000;
/** A doc link is used only when it is the Google Docs address the agent builds. */
const DOC_URL = /^https:\/\/docs\.google\.com\/document\/d\/[A-Za-z0-9_-]{10,200}\/edit$/;

const titleOf = (/** @type {MeetingRow} */ m) => m.title || (m.status === 'internal' ? 'Internal meeting' : 'Meeting');

/** @param {ScreenCtx} ctx */
export function mountMeetings(ctx) {
  let view = readList(location.search, 'view', VIEWS.map(([k]) => k), 'all');
  /** @type {{ total: number, rows: MeetingRow[] } | null} */
  let data = null;
  /** @type {unknown} */
  let err = null;
  /** @type {{ code: string, name: string }[]} */
  let clients = [];

  const draw = () => {
    const seg = `<div class="toolbar"><div class="seg" role="tablist">${VIEWS.map(([k, l]) => `<button type="button" role="tab" aria-selected="${view === k}" class="${view === k ? 'on' : ''}" data-mview="${k}">${esc(l)}</button>`).join('')}</div>
      <span class="count-note">${data ? esc(`${data.total} meeting${data.total === 1 ? '' : 's'}`) : ''}</span></div>`;
    let body;
    if (err && !data) body = failed(err);
    else if (!data) body = loading('Loading meetings…');
    else if (!data.rows.length) body = `<div class="card">${empty(view === 'all' ? 'No meetings yet.' : 'Nothing here.')}</div>`;
    else body = `<div class="card"><div class="list">${data.rows.map((m) => `<button type="button" class="li li-btn" data-meet="${m.id}"><div class="ic">${icon('video', 17)}</div>
        <div><b>${esc(titleOf(m))}</b><small>${esc(m.client ? m.client.name : 'No client yet')}${m.account ? ` · ${esc(m.account)}` : ''}${m.minutes === null ? '' : ` · ${esc(m.minutes)} min`}</small></div>
        ${pill(m.status === 'queued' ? { cls: 'p-open', label: m.stageLabel } : meetingPill(m.status))}<time>${esc(when(m.when))}</time></button>`).join('')}</div></div>`;
    ctx.redraw(seg + body);
  };

  async function load() {
    try {
      const r = await get(`/meetings?view=${encodeURIComponent(view)}`);
      if (!ctx.live()) return;
      data = r;
      err = null;
    } catch (e) {
      if (!ctx.live()) return;
      err = e;
    }
    draw();
  }

  draw();
  ctx.poll(load, POLL_MS);
  void get('/overview').then((ov) => {
    clients = (ov?.byClient ?? []).map((/** @type {{ client: { code: string, name: string } }} */ c) => c.client);
  }).catch(() => {});

  return listen(ctx.view, {
    click: (e) => {
      const t = /** @type {Element} */ (e.target);
      const tab = /** @type {HTMLElement | null} */ (t.closest('[data-mview]'));
      if (tab?.dataset.mview && tab.dataset.mview !== view) {
        view = tab.dataset.mview;
        setQuery(view === 'all' ? '' : `?view=${view}`);
        data = null;
        draw();
        void load();
        return;
      }
      if (t.closest('[data-retry]')) return void load();
      const row = /** @type {HTMLElement | null} */ (t.closest('[data-meet]'));
      if (row?.dataset.meet) openMeeting(Number(row.dataset.meet), () => clients, () => void load());
    },
  });
}

/** @param {MeetingDetail} m @param {{ code: string, name: string }[]} clients */
function render(m, clients) {
  const s = m.summary;
  const assignable = m.status === 'unassigned' || m.status === 'internal' || (m.status === 'no_access' && !m.client);
  const doc = m.docUrl && DOC_URL.test(m.docUrl) ? m.docUrl : null;
  return `<div class="dr-head"><div>${pill(m.status === 'queued' ? { cls: 'p-open', label: m.stageLabel } : meetingPill(m.status))}<h2>${esc(titleOf(m))}</h2></div><button class="icon-btn" type="button" data-close aria-label="Close">${icon('close', 18)}</button></div>
    <div class="dr-body"><dl class="kv"><dt>When</dt><dd>${esc(when(m.when))}</dd><dt>Length</dt><dd>${m.minutes === null ? '—' : `${esc(m.minutes)} min`}</dd>
      <dt>Google account</dt><dd>${esc(m.account ?? '—')}</dd><dt>Client</dt><dd>${esc(m.client ? m.client.name : 'Not matched')}</dd><dt>Stage</dt><dd>${esc(m.stageLabel)}</dd></dl>
      ${s ? `<div class="h4">What happened</div><p class="muted-p">${esc(s.whatHappened)}</p>
        ${s.decisions.length ? `<div class="h4">Decisions</div><ul class="timeline">${s.decisions.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}
        ${s.openQuestions.length ? `<div class="h4">Open questions</div><ul class="timeline">${s.openQuestions.map((q) => `<li>${esc(q)}</li>`).join('')}</ul>` : ''}
        ${s.conclusion ? `<div class="h4">Conclusion</div><p class="muted-p">${esc(s.conclusion)}</p>` : ''}` : ''}
      ${m.actionItemTasks.length ? `<div class="h4">Action items</div><ul class="timeline">${m.actionItemTasks.map((t) => `<li><b>${esc(t.code)}</b> · ${esc(t.title)}${t.owner ? ` · ${esc(t.owner)}` : ''} ${pill(taskPill(t.status))}</li>`).join('')}</ul>` : ''}
      ${assignable ? `<div class="note">${icon('info', 16)}<span>The agent could not tell which client this was. Pick one and it will be summarised. This costs money.</span></div>` : ''}
      ${m.status === 'too_long' ? `<div class="note">${icon('alert', 16)}<span>Longer than the meeting length limit, so it was not processed.</span></div>` : ''}
      ${m.status === 'failed' || m.status === 'no_access' ? `<div class="note">${icon('alert', 16)}<span>${m.status === 'failed' ? 'It could not be processed.' : 'The agent could not open the recording.'} Retry tries again; this costs money.</span></div>` : ''}</div>
    <div class="dr-foot">${doc ? `<a class="btn btn-primary" href="${esc(doc)}" target="_blank" rel="noopener noreferrer">${icon('doc', 16)}Open summary doc</a>` : ''}
      ${assignable ? `<select class="sel" data-client aria-label="Client"><option value="">Choose a client</option>${clients.map((c) => `<option value="${esc(c.code)}">${esc(c.name)}</option>`).join('')}</select><button class="btn btn-primary" type="button" data-mact="assign">Assign</button>` : ''}
      ${m.status === 'unassigned' ? `<button class="btn btn-ghost" type="button" data-mact="skip">Skip</button>` : ''}
      ${m.status === 'failed' || m.status === 'no_access' ? `<button class="btn btn-primary" type="button" data-mact="retry">${icon('refresh', 16)}Retry</button>` : ''}
      <button class="btn btn-ghost" type="button" data-close>Close</button></div>`;
}

/** @param {number} id @param {() => { code: string, name: string }[]} clients @param {() => void} onChange */
function openMeeting(id, clients, onChange) {
  const drawer = openDrawer(`<div class="dr-head"><div><h2>Meeting</h2></div><button class="icon-btn" type="button" data-close aria-label="Close">${icon('close', 18)}</button></div><div class="dr-body">${loading('Loading the meeting…')}</div>`);
  let busy = false;
  const load = async () => {
    try {
      refillDrawer(render(await get(`/meetings/${id}`), clients()));
    } catch (e) {
      refillDrawer(`<div class="dr-head"><div><h2>Meeting</h2></div><button class="icon-btn" type="button" data-close aria-label="Close">${icon('close', 18)}</button></div><div class="dr-body">${failed(e)}</div>`);
    }
  };
  drawer.addEventListener('click', async (e) => {
    const t = /** @type {Element} */ (e.target);
    if (t.closest('[data-retry]')) return void load();
    const b = /** @type {HTMLElement | null} */ (t.closest('[data-mact]'));
    if (!b || busy) return;
    const action = b.dataset.mact;
    /** @type {Record<string, string> | undefined} */
    let body;
    if (action === 'assign') {
      const code = /** @type {HTMLSelectElement | null} */ (drawer.querySelector('[data-client]'))?.value ?? '';
      if (!code) return toast('Choose a client first.');
      body = { client: code };
    }
    if (action === 'retry' && !(await confirmDialog({ eyebrow: 'Meetings', title: 'This costs money. Continue?', text: 'The meeting is sent for speech-to-text and a summary again. It counts toward the daily spending limit.', yes: 'Retry' }))) return;
    busy = true;
    try {
      const r = await post(`/meetings/${id}/${action}`, body);
      refillDrawer(render(r.meeting, clients()));
      toast(r.warning ? `Done. ${r.warning}.` : 'Done.');
      onChange();
    } catch (err) {
      toast(errorText(err));
    } finally {
      busy = false;
    }
  });
  void load();
}
