// Tracker (D4 Task 6): the hero card naming the file the agent writes (name, folder, Google account, last upload) with
// Open in Drive, the note when a new file had to be started, the sheets table, sync health and the note that edits in
// the spreadsheet are replaced. The link is used only when it is the Drive address the agent builds.
import { get } from '../api.js';
import { ACCOUNT_UNKNOWN, DRIVE_FILE_URL } from '../contract.js';
import { esc, icon } from '../dom.js';
import { ago, date, when } from '../format.js';
import { failed, listen, loading, pill } from './ui.js';

/** @typedef {import('./registry.js').ScreenCtx} ScreenCtx */
/**
 * @typedef {{ uploaded: boolean, url: string | null, file?: { name?: string, folder?: string, account?: string | null }, newFileAt?: string | null,
 *   lastPublishedAt: string | null, lastFailure: { at: string, reason: string } | null,
 *   failingSince: string | null, health: { ok: boolean, text: string } | null,
 *   sheets: { name: string, client: { code: string, name: string } | null, notDone: number, overdue: number, review: number, doneThisWeek: number }[] }} Tracker
 */

const POLL_MS = 30_000;

/** @param {Tracker} t */
function render(t) {
  const url = typeof t.url === 'string' && DRIVE_FILE_URL.test(t.url) ? t.url : null;
  const text = (/** @type {unknown} */ v, /** @type {string} */ fallback) => (typeof v === 'string' && v ? v : fallback);
  const name = text(t.file?.name, 'Tracker.xlsx');
  const folder = text(t.file?.folder, 'WA Agent');
  const account = text(t.file?.account, ACCOUNT_UNKNOWN);
  const newFile = typeof t.newFileAt === 'string' && !Number.isNaN(Date.parse(t.newFileAt))
    ? `<div class="note note-warn" data-new-file>${icon('info', 16)}<span>${esc(`A new tracker file was started on ${date(t.newFileAt)}. The old one may belong to a different Google account.`)}</span></div>`
    : '';
  const ok = t.failingSince === null;
  const status = !t.uploaded ? { cls: 'p-warn', label: 'Not uploaded yet' } : ok ? { cls: 'p-done', label: `Last upload ${ago(t.lastPublishedAt)}` } : { cls: 'p-overdue', label: 'Uploads failing' };
  const today = t.sheets[0];
  return `<div class="grid">
    <section class="card col-12 hero"><div class="hero-ic">${icon('xls', 28)}</div>
      <div class="grow-1"><h3>${esc(name)}</h3><div class="muted-p">Google Drive · rebuilt by the agent through the day</div>
        <dl class="kv kv-top" data-tracker-file><dt>File</dt><dd>${esc(name)}</dd><dt>Folder</dt><dd>${esc(folder)}</dd><dt>Account</dt><dd>${esc(account)}</dd>
          <dt>Last upload</dt><dd>${esc(t.lastPublishedAt ? when(t.lastPublishedAt) : 'Not uploaded yet')}</dd></dl>${newFile}</div>
      ${pill(status)}${url ? `<a class="btn btn-primary" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${icon('ext', 16)}Open in Drive</a>` : ''}</section>
    <section class="card col-8"><div class="card-head"><h3>Sheets</h3><span class="mono faint">${esc(t.sheets.length)}</span></div><div class="tbl-wrap"><table class="tbl tbl-cards">
      <caption class="sr-only">Sheets in Tracker.xlsx</caption><thead><tr><th>Sheet</th><th>Open</th><th>Overdue</th><th>Review</th><th>Done this week</th></tr></thead><tbody>
      ${t.sheets.map((s, i) => `<tr><td data-label="Sheet">${i === 0 ? `<b>${esc(s.name)}</b> <span class="muted-p">· summary, first tab</span>` : esc(s.name)}</td><td data-label="Open">${esc(s.notDone)}</td>
        <td data-label="Overdue" class="${s.overdue ? 'od' : ''}">${esc(s.overdue)}</td><td data-label="Review">${esc(s.review)}</td><td data-label="Done this week">${esc(s.doneThisWeek)}</td></tr>`).join('')}</tbody></table></div>
      ${today ? '' : '<p class="empty-note">No sheets yet.</p>'}</section>
    <section class="card col-4"><div class="card-head"><h3>Sync health</h3></div><div class="list">
      <div class="li"><div class="ic">${icon('cloud', 17)}</div><div><b>Upload</b><small>${esc(t.lastPublishedAt ? `Last ${when(t.lastPublishedAt)}` : 'Not uploaded yet')}</small></div>${pill(ok ? { cls: 'p-done', label: 'OK' } : { cls: 'p-overdue', label: 'Failing' })}</div>
      <div class="li"><div class="ic">${icon('key', 17)}</div><div><b>Agent health</b><small>${esc(t.health?.text ?? 'Not known yet')}</small></div>${pill(t.health?.ok === false ? { cls: 'p-warn', label: 'Check' } : { cls: 'p-done', label: 'OK' })}</div>
      ${t.lastFailure ? `<div class="li"><div class="ic">${icon('alert', 17)}</div><div><b>Last problem</b><small>${esc(`${when(t.lastFailure.at)} · ${t.lastFailure.reason}`)}</small></div>${pill(ok ? { cls: 'p-muted', label: 'Past' } : { cls: 'p-overdue', label: 'Now' })}</div>` : ''}</div>
      <div class="note">${icon('info', 16)}<span>Edits made inside the spreadsheet are replaced on the next upload. Use this dashboard or the CLI to change tasks.</span></div></section></div>`;
}

/** @param {ScreenCtx} ctx */
export function mountTracker(ctx) {
  /** @type {Tracker | null} */
  let data = null;
  ctx.redraw(loading('Loading the tracker…'));
  ctx.poll(async () => {
    try {
      const r = await get('/tracker');
      if (!ctx.live()) return;
      data = r;
      ctx.redraw(render(r));
    } catch (e) {
      if (ctx.live() && !data) ctx.redraw(failed(e));
    }
  }, POLL_MS);
  return listen(ctx.view, {
    click: async (e) => {
      if (!(/** @type {Element} */ (e.target).closest('[data-retry]'))) return;
      try {
        const r = await get('/tracker');
        if (ctx.live()) ctx.redraw(render((data = r)));
      } catch (err) {
        if (ctx.live()) ctx.redraw(failed(err));
      }
    },
  });
}
