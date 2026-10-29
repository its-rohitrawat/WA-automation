// The task drawer (D4 Task 6): the WhatsApp-style quote, the details, the history timeline, Mark done / Reopen, and
// Edit owner or deadline as a small inline form. The quote and every other value from the agent go through esc().
import { get, post } from '../api.js';
import { $, esc, icon, toast } from '../dom.js';
import { when } from '../format.js';
import { closeDrawer, errorText, failed, loading, moodTag, openDrawer, pill, refillDrawer } from './ui.js';
import { deadlineText, moodLabel, priorityPill, prioritySourceText, sourceLabel, taskPill, TASK_PRIORITIES } from './workLib.js';

/**
 * @typedef {{ code: string, title: string, client: { code: string, name: string }, owner: string | null, askedBy: string | null,
 *   deadline: string | null, status: string, overdue: boolean, priority: string | null, prioritySource: string | null,
 *   priorityKeyword: string | null, sentiment: string | null, source: string, sourceQuote: string | null,
 *   sourceDate: string | null, sourceRevoked: boolean, latestProgress: string | null, remindedCount: number,
 *   history: { at: string, actor: 'agent' | 'owner', what: string }[] }} TaskDetail
 */

/** @param {TaskDetail} t @param {{ editing?: boolean, problem?: { field?: string, message: string } | null }} [o] */
function render(t, o = {}) {
  const src = sourceLabel(t.source);
  const problem = o.problem ? `<p class="field-err" role="alert">${esc(o.problem.message)}</p>` : '';
  const edit = o.editing
    ? `<form class="edit-form" data-edit novalidate><label><span>Owner</span><input name="assignedTo" value="${esc(t.owner ?? '')}" maxlength="100" autocomplete="off"></label>
        <label><span>Deadline</span><input name="deadline" type="date" value="${esc(t.deadline ?? '')}"></label>
        <label><span>Priority</span><select class="sel" name="priority">${t.priority ? '' : '<option value="" selected>Not set</option>'}${TASK_PRIORITIES.map((p) => `<option value="${esc(p)}"${t.priority === p ? ' selected' : ''}>${esc(priorityPill(p).label)}</option>`).join('')}</select></label>${problem}
        <div class="row-gap"><button class="btn btn-primary btn-sm" type="submit">Save</button><button class="btn btn-ghost btn-sm" type="button" data-cancel>Cancel</button></div></form>`
    : problem;
  return `<div class="dr-head"><div><span class="code">${esc(t.code)}</span> ${pill(taskPill(t.status))}<h2>${esc(t.title)}</h2></div><button class="icon-btn" type="button" data-close aria-label="Close">${icon('close', 18)}</button></div>
    <div class="dr-body"><dl class="kv"><dt>Client</dt><dd>${esc(t.client.name)}</dd><dt>Owner</dt><dd>${esc(t.owner ?? '—')}</dd><dt>Asked by</dt><dd>${esc(t.askedBy ?? '—')}</dd>
      <dt>Deadline</dt><dd class="${t.overdue ? 'od' : ''}">${esc(deadlineText(t.deadline))}</dd><dt>Priority</dt><dd>${pill(priorityPill(t.priority))} <small class="faint">${esc(prioritySourceText(t.prioritySource, t.priorityKeyword))}</small></dd>
      ${t.sentiment ? `<dt>Client mood</dt><dd>${moodTag(moodLabel(t.sentiment))}</dd>` : ''}
      <dt>Source</dt><dd><span class="src">${icon(src.icon, 15)}${esc(src.label)}</span></dd>${t.remindedCount ? `<dt>Reminders</dt><dd>${esc(t.remindedCount)}</dd>` : ''}</dl>
      ${edit}
      ${t.sourceQuote ? `<div class="h4">Where it came from</div><div class="quote">${esc(t.sourceQuote)}<small>${esc(src.label)}${t.sourceDate ? ` · ${esc(deadlineText(t.sourceDate))}` : ''}${t.sourceRevoked ? ' · the sender deleted this message' : ''}</small></div>` : ''}
      ${t.latestProgress ? `<div class="h4">Latest progress</div><p class="muted-p">${esc(t.latestProgress)}</p>` : ''}
      <div class="h4">History</div>${t.history.length ? `<ul class="timeline">${t.history.map((h) => `<li><b>${esc(h.what)}</b> · ${esc(when(h.at))}</li>`).join('')}</ul>` : '<p class="muted-p">No history yet.</p>'}</div>
    <div class="dr-foot">${t.status === 'done' ? `<button class="btn btn-ghost" type="button" data-act="reopen">${icon('undo', 16)}Reopen</button>` : `<button class="btn btn-primary" type="button" data-act="done">${icon('tick', 16)}Mark done</button>`}
      ${o.editing ? '' : `<button class="btn btn-ghost" type="button" data-act="edit">${icon('edit', 16)}Edit owner, deadline or priority</button>`}
      <span class="foot-note">Changes are saved by the agent and written to the tracker.</span></div>`;
}

/**
 * Opens the drawer for a task. onChange runs after the task was changed, so the list can refresh.
 * @param {string} code @param {{ onChange: () => void }} o
 */
export function openTaskDrawer(code, o) {
  const path = `/tasks/${encodeURIComponent(code)}`;
  const drawer = openDrawer(`<div class="dr-head"><div><span class="code">${esc(code)}</span></div><button class="icon-btn" type="button" data-close aria-label="Close">${icon('close', 18)}</button></div><div class="dr-body">${loading('Loading the task…')}</div>`);
  /** @type {TaskDetail | null} */
  let t = null;
  let busy = false;

  const show = (/** @type {{ editing?: boolean, problem?: { field?: string, message: string } | null }} */ state = {}) => {
    if (!t) return;
    const d = refillDrawer(drawer, render(t, state));
    if (!d) return;
    if (state.editing) $(`[name="${state.problem?.field === 'deadline' ? 'deadline' : 'assignedTo'}"]`, d)?.focus();
  };

  async function load() {
    try {
      t = await get(path);
      show();
    } catch (e) {
      refillDrawer(drawer, `<div class="dr-head"><div><span class="code">${esc(code)}</span></div><button class="icon-btn" type="button" data-close aria-label="Close">${icon('close', 18)}</button></div><div class="dr-body">${failed(e)}</div>`);
    }
  }

  /** @param {string} action @param {unknown} [body] */
  async function act(action, body) {
    if (busy) return false;
    busy = true;
    try {
      t = await post(`${path}/${action}`, body);
      o.onChange();
      return true;
    } catch (e) {
      const err = /** @type {{ status?: number, field?: string }} */ (e);
      if (action === 'edit' && err.status === 422) {
        show({ editing: true, problem: { message: errorText(e) } });
        return false;
      }
      toast(errorText(e));
      return false;
    } finally {
      busy = false;
    }
  }

  drawer.addEventListener('click', async (e) => {
    const target = /** @type {Element} */ (e.target);
    if (target.closest('[data-retry]')) return void load();
    if (target.closest('[data-cancel]')) return show();
    const b = /** @type {HTMLElement | null} */ (target.closest('[data-act]'));
    if (!b) return;
    if (b.dataset.act === 'edit') return show({ editing: true });
    const action = b.dataset.act === 'done' ? 'done' : 'reopen';
    if (await act(action)) {
      show();
      toast(`${code} ${action === 'done' ? 'marked done' : 'reopened'}.`);
    }
  });
  drawer.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = /** @type {HTMLFormElement} */ (e.target);
    const data = new FormData(form);
    const owner = String(data.get('assignedTo') ?? '').trim();
    const deadline = String(data.get('deadline') ?? '').trim();
    const priority = String(data.get('priority') ?? '').trim();
    // Only what changed: an edit locks the fields it names against the agent's own updates.
    /** @type {Record<string, string>} */
    const body = {};
    if (owner !== (t?.owner ?? '')) body.assignedTo = owner;
    if (deadline !== (t?.deadline ?? '')) body.deadline = deadline;
    if (priority && priority !== (t?.priority ?? '')) body.priority = priority;
    if (Object.keys(body).length === 0) return show();
    if (await act('edit', body)) {
      show();
      toast(`${code} saved.`);
    }
  });
  void load();
  return { close: () => closeDrawer() };
}
