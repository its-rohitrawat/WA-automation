// Tasks (D4 Task 6): search and five filters kept in the address, a sortable table (cards on phones), red overdue
// dates, status pills, the source, and the task drawer. Every value from the agent goes through esc().
import { get } from '../api.js';
import { $, esc, icon } from '../dom.js';
import { openTaskDrawer } from './taskDrawer.js';
import { empty, failed, listen, loading, pill, setQuery } from './ui.js';
import { deadlineText, sourceLabel, taskPill, taskQueryFromSearch, taskQueryToSearch } from './workLib.js';

/** @typedef {import('./registry.js').ScreenCtx} ScreenCtx */
/** @typedef {import('./workLib.js').TaskFilter} TaskFilter */
/**
 * @typedef {{ code: string, title: string, client: { code: string, name: string }, owner: string | null, deadline: string | null,
 *   status: string, overdue: boolean, priority: string, source: string }} TaskRow
 */

const SORTABLE = [['code', 'Task'], ['client', 'Client'], ['owner', 'Owner'], ['deadline', 'Deadline'], ['status', 'Status']];

/** @param {ScreenCtx} ctx */
export function mountTasks(ctx) {
  /** @type {TaskFilter} */
  const f = taskQueryFromSearch(location.search);
  // The top search box sends the owner here with what they typed: it is taken once, into the address, and emptied, so
  // it never comes back on a later visit.
  const top = /** @type {HTMLInputElement | null} */ (document.querySelector('#q'));
  const takeTop = () => {
    const v = top?.value.trim().slice(0, 200) ?? '';
    if (top) top.value = '';
    return v;
  };
  const fromTop = takeTop();
  if (fromTop) {
    f.q = fromTop;
    setQuery(taskQueryToSearch(f));
  }
  /** @type {{ total: number, rows: TaskRow[] } | null} */
  let data = null;
  /** @type {unknown} */
  let err = null;
  /** @type {{ code: string, name: string }[]} */
  let clients = [];
  /** @type {string[]} */
  let owners = [];
  let typing = /** @type {ReturnType<typeof setTimeout> | undefined} */ (undefined);
  let asked = 0;

  const sel = (/** @type {keyof TaskFilter} */ id, /** @type {string} */ label, /** @type {string[][]} */ opts) =>
    `<select class="sel" data-f="${id}" aria-label="${esc(label)}"><option value="">${esc(label)}</option>${opts
      .map(([v, l]) => `<option value="${esc(v)}"${f[id] === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;

  const toolbar = () => `<div class="toolbar"><label class="field">${icon('search', 16)}<input data-f="q" value="${esc(f.q ?? '')}" placeholder="Search tasks" aria-label="Search tasks" maxlength="200"></label>
    ${sel('client', 'All clients', clients.map((c) => [c.code, c.name]))}
    ${sel('status', 'Any status', [['overdue', 'Overdue'], ['open', 'Open'], ['review', 'Needs review'], ['done', 'Done']])}
    ${sel('owner', 'Any owner', owners.map((o) => [o, o]))}
    ${sel('deadline', 'Any deadline', [['past', 'Past deadline'], ['week', 'Due this week'], ['none', 'No deadline']])}
    ${sel('priority', 'Any priority', [['high', 'High'], ['medium', 'Medium'], ['low', 'Low']])}
    <span class="count-note" data-region="count"></span></div>`;

  const th = (/** @type {string} */ k, /** @type {string} */ l) => {
    const on = f.sort === k;
    return `<th aria-sort="${on ? (f.dir === 'asc' ? 'ascending' : 'descending') : 'none'}"><button type="button" data-sort="${esc(k)}"${on && f.dir === 'desc' ? ' class="sort-desc"' : ''}>${esc(l)}${on ? icon('sort', 13) : ''}</button></th>`;
  };

  const table = () => {
    if (err && !data) return failed(err);
    if (!data) return loading('Loading tasks…');
    const head = `<thead><tr>${th('code', 'Task')}<th>Title</th>${SORTABLE.slice(1).map(([k, l]) => th(k, l)).join('')}<th>Priority</th><th>Source</th></tr></thead>`;
    const rows = data.rows.map((t) => {
      const src = sourceLabel(t.source);
      return `<tr data-task="${esc(t.code)}" tabindex="0"><td data-label="Task"><span class="code">${esc(t.code)}</span></td><td class="ttl" data-label="Title">${esc(t.title)}</td>
        <td data-label="Client">${esc(t.client.name)}</td><td data-label="Owner">${esc(t.owner ?? '—')}</td>
        <td data-label="Deadline" class="${t.overdue ? 'od' : ''}">${esc(deadlineText(t.deadline))}</td><td data-label="Status">${pill(taskPill(t.status))}</td>
        <td data-label="Priority" class="pri-${esc(t.priority)}">${esc(t.priority[0]?.toUpperCase() + t.priority.slice(1))}</td>
        <td data-label="Source"><span class="src">${icon(src.icon, 15)}${esc(src.label)}</span></td></tr>`;
    }).join('');
    return `<div class="card flush"><div class="tbl-wrap"><table class="tbl tbl-cards"><caption class="sr-only">Tasks</caption>${head}<tbody>${rows || `<tr><td colspan="8">${empty('No tasks match these filters.')}</td></tr>`}</tbody></table></div></div>`;
  };

  const drawTable = () => {
    if (!ctx.live()) return;
    const region = $('[data-region="table"]', ctx.view);
    if (region) region.innerHTML = table();
    const count = $('[data-region="count"]', ctx.view);
    if (count) count.textContent = data ? (data.rows.length < data.total ? `${data.rows.length} of ${data.total} shown` : `${data.total} task${data.total === 1 ? '' : 's'}`) : '';
  };

  const drawAll = () => ctx.redraw(`${toolbar()}<div data-region="table">${table()}</div>`);

  async function load() {
    const mine = ++asked;
    try {
      const s = taskQueryToSearch(f);
      const r = await get(`/tasks${s ? `${s}&` : '?'}limit=200`);
      if (!ctx.live() || mine !== asked) return;
      data = r;
      err = null;
    } catch (e) {
      if (!ctx.live() || mine !== asked) return;
      err = e;
    }
    drawTable();
  }

  const changed = () => {
    setQuery(taskQueryToSearch(f));
    void load();
  };

  // The client and owner lists, once: every client on the Overview, every owner among the tasks.
  async function lists() {
    try {
      const [ov, all] = await Promise.all([get('/overview'), get('/tasks?limit=500')]);
      if (!ctx.live()) return;
      clients = (ov?.byClient ?? []).map((/** @type {{ client: { code: string, name: string } }} */ c) => c.client);
      owners = [...new Set((all?.rows ?? []).map((/** @type {TaskRow} */ t) => t.owner).filter(Boolean))].sort();
      const focus = document.activeElement;
      const bar = $('.toolbar', ctx.view);
      if (bar && !(focus instanceof HTMLElement && bar.contains(focus))) bar.outerHTML = toolbar();
      drawTable();
    } catch {
      // the filters still work without the lists
    }
  }

  drawAll();
  void load();
  void lists();

  const open = (/** @type {string} */ code) => openTaskDrawer(code, { onChange: () => void load() });
  const stop = listen(ctx.view, {
    input: (e) => {
      const el = /** @type {HTMLInputElement} */ (e.target);
      if (el.dataset.f !== 'q') return;
      clearTimeout(typing);
      typing = setTimeout(() => {
        if (!ctx.live()) return;
        const v = el.value.trim().slice(0, 200);
        if (v) f.q = v;
        else delete f.q;
        changed();
      }, 250);
    },
    change: (e) => {
      const el = /** @type {HTMLSelectElement} */ (e.target);
      const k = /** @type {keyof TaskFilter | undefined} */ (el.dataset.f);
      if (!k || k === 'q') return;
      if (el.value) /** @type {Record<string, string>} */ (f)[k] = el.value;
      else delete /** @type {Record<string, string>} */ (f)[k];
      changed();
    },
    click: (e) => {
      const t = /** @type {Element} */ (e.target);
      const sort = /** @type {HTMLElement | null} */ (t.closest('[data-sort]'));
      if (sort) {
        const k = sort.dataset.sort ?? 'deadline';
        if (f.sort === k) f.dir = f.dir === 'asc' ? 'desc' : 'asc';
        else {
          f.sort = k;
          f.dir = 'asc';
        }
        changed();
        return;
      }
      if (t.closest('[data-retry]')) {
        err = null;
        drawTable();
        void load();
        return;
      }
      const row = /** @type {HTMLElement | null} */ (t.closest('[data-task]'));
      if (row?.dataset.task) open(row.dataset.task);
    },
    keydown: (e) => {
      const ke = /** @type {KeyboardEvent} */ (e);
      const row = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest?.('[data-task]'));
      if (row?.dataset.task && (ke.key === 'Enter' || ke.key === ' ')) {
        e.preventDefault();
        open(row.dataset.task);
      }
    },
  });
  // The top search box while already on Tasks: the shell does not show Tasks again, so the Enter is taken here.
  const onTopKey = (/** @type {KeyboardEvent} */ e) => {
    if (e.key !== 'Enter' || e.target !== top || !ctx.live()) return;
    const v = takeTop();
    if (!v) return;
    f.q = v;
    const box = /** @type {HTMLInputElement | null} */ (ctx.view.querySelector('[data-f="q"]'));
    if (box) box.value = v;
    changed();
  };
  document.addEventListener('keydown', onTopKey);
  return () => {
    document.removeEventListener('keydown', onTopKey);
    clearTimeout(typing); // a search typed just before leaving must not reach another screen's address
    stop();
  };
}
