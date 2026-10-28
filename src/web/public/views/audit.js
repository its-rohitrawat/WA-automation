// Audit logs (D5 Task 5): filter tabs kept in the address, the table (cards on phones), and "Show older" with the
// API's cursor. Rows hold who did what; emails of anyone but the owners arrive masked.
import { get } from '../api.js';
import { esc, toast } from '../dom.js';
import { when } from '../format.js';
import { empty, failed, listen, loading, pill, setQuery } from './ui.js';
import { auditPill, readList } from './workLib.js';

/** @typedef {import('./registry.js').ScreenCtx} ScreenCtx */
/** @typedef {{ id: number, at: string, actor: string, event: string, kind: string, detail: string }} Row */

const KINDS = [['all', 'All'], ['auth', 'Sign-ins'], ['config', 'Changes'], ['connection', 'Connections'], ['task', 'Tasks'], ['meeting', 'Meetings'], ['ops', 'Agent']];
/** Event codes in plain words; an unknown one shows as it is. */
const EVENT_WORDS = {
  'task.done': 'Task marked done', 'task.reopen': 'Task reopened', 'task.unlock': 'Task handed back', 'task.edit': 'Task edited',
  'meeting.assign': 'Meeting assigned', 'meeting.skip': 'Meeting skipped', 'meeting.retry': 'Meeting retried',
  'settings.reportEnabled': 'Briefing switched', 'settings.reportDays': 'Briefing days', 'settings.reportRecipient': 'Briefing number',
  'auth.signout_everywhere': 'Signed out everywhere', 'tracker.published': 'Tracker uploaded', 'tracker.publish_failed': 'Tracker upload failed',
  'tracker.new_file': 'New tracker file',
};

/** @param {ScreenCtx} ctx */
export function mountAudit(ctx) {
  let kind = readList(location.search, 'kind', KINDS.map(([k]) => k), 'all');
  /** @type {Row[] | null} */
  let rows = null;
  /** @type {string | null} */
  let next = null;
  /** @type {unknown} */
  let err = null;

  const draw = () => {
    const tabs = `<div class="toolbar"><div class="seg" role="tablist">${KINDS.map(([k, l]) => `<button type="button" role="tab" aria-selected="${kind === k}" class="${kind === k ? 'on' : ''}" data-lkind="${k}">${esc(l)}</button>`).join('')}</div>
      <span class="count-note">Kept for 90 days · no tokens or passwords are ever logged</span></div>`;
    let body;
    if (err && !rows) body = failed(err);
    else if (!rows) body = loading('Loading the audit log…');
    else if (!rows.length) body = `<div class="card">${empty('Nothing recorded here yet.')}</div>`;
    else {
      body = `<div class="card flush"><div class="tbl-wrap"><table class="tbl tbl-cards"><caption class="sr-only">Audit log</caption><thead><tr><th>Time</th><th>Event</th><th>Who</th><th>Detail</th></tr></thead><tbody>
        ${rows.map((r) => `<tr class="static"><td class="mono nowrap" data-label="Time">${esc(when(r.at))}</td>
          <td data-label="Event">${pill({ cls: auditPill(r).cls, label: /** @type {Record<string, string>} */ (EVENT_WORDS)[r.event] ?? r.event })}</td>
          <td data-label="Who">${esc(r.actor === 'agent' ? 'The agent' : r.actor)}</td><td class="muted-p" data-label="Detail">${esc(r.detail)}</td></tr>`).join('')}</tbody></table></div>
        ${next ? '<div class="more"><button class="btn btn-ghost btn-sm" type="button" data-older>Show older</button></div>' : ''}</div>`;
    }
    ctx.redraw(tabs + body);
  };

  let asked = 0;
  /** @param {boolean} [more] */
  async function load(more = false) {
    const mine = ++asked;
    try {
      const r = await get(`/audit?limit=50${kind === 'all' ? '' : `&kind=${encodeURIComponent(kind)}`}${more && next ? `&before=${encodeURIComponent(next)}` : ''}`);
      if (!ctx.live() || mine !== asked) return; // an answer for an earlier tab is dropped
      rows = more && rows ? [...rows, ...r.rows] : r.rows;
      next = r.next;
      err = null;
    } catch (e) {
      if (!ctx.live() || mine !== asked) return;
      if (more) {
        toast('Older entries could not be loaded. Try again.');
        return;
      }
      err = e;
    }
    draw();
  }

  draw();
  void load();
  return listen(ctx.view, {
    click: (e) => {
      const t = /** @type {Element} */ (e.target);
      const tab = /** @type {HTMLElement | null} */ (t.closest('[data-lkind]'));
      if (tab?.dataset.lkind && tab.dataset.lkind !== kind) {
        kind = tab.dataset.lkind;
        setQuery(kind === 'all' ? '' : `?kind=${kind}`);
        rows = null;
        next = null;
        draw();
        void load();
        return;
      }
      if (t.closest('[data-retry]')) return void load();
      if (t.closest('[data-older]')) void load(true);
    },
  });
}
