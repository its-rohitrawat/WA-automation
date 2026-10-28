// AI usage (D5 Task 5): the KPI row, the 14-day bar chart (one series, today marked, the cap as a dashed line, a text
// tip per bar, and a visually hidden table for screen readers), and today by kind. The cap is set on the Mac only.
import { get } from '../api.js';
import { $$, countUp, esc, gsap, icon, reduceMotion } from '../dom.js';
import { usd } from '../format.js';
import { failed, listen, loading } from './ui.js';
import { usageChart } from './workLib.js';

/** @typedef {import('./registry.js').ScreenCtx} ScreenCtx */
/**
 * @typedef {{ today: { spent: number, byKind: { ai: number, stt: number }, capUsd: number, remaining: number, paused: boolean },
 *   days: { day: string, usd: number }[], byUse: { use: string, label: string, usd: number }[], batches: { today: number, messagesRead: number } }} Usage
 */

const USE_ICON = { messages: 'bubble', meetings: 'video', files: 'file', speech: 'mic', voice: 'mic', other: 'ai' };
const POLL_MS = 60_000;

/** @param {Usage} u */
function render(u) {
  const t = u.today;
  const chart = usageChart(u.days, t.capUsd);
  const left = t.capUsd > 0 ? Math.round((t.remaining / t.capUsd) * 100) : 0;
  return `<div class="kpis kpis-4">
      <div class="card kpi"><div class="lab">${icon('dollar', 17)}Spent today</div><div class="num" data-count="${Number(t.spent)}" data-dec="2" data-pre="$">$0</div><div class="delta">${esc(`${u.batches.today} batch${u.batches.today === 1 ? '' : 'es'} · ${u.batches.messagesRead} messages read`)}</div></div>
      <div class="card kpi"><div class="lab">${icon('shield', 17)}Daily cap</div><div class="num">${esc(usd(t.capUsd))}</div><div class="delta">Set on the Mac (DAILY_SPEND_CAP_USD)</div></div>
      <div class="card kpi"><div class="lab">${icon('pie', 17)}Remaining</div><div class="num" data-count="${Number(t.remaining)}" data-dec="2" data-pre="$">$0</div><div class="delta">${esc(`${left}% left today`)}</div></div>
      <div class="card kpi"><div class="lab">${icon(t.paused ? 'alert' : 'ok', 17)}Status</div><div class="num num-word${t.paused ? ' is-warn' : ''}">${t.paused ? 'At the limit' : 'Under limit'}</div><div class="delta">${t.paused ? 'Paid work waits until midnight IST' : 'Paid work pauses at the cap'}</div></div></div>
    <div class="grid"><section class="card col-8"><div class="card-head"><h3>Daily spend · last 14 days</h3><span class="faint">USD</span></div>
      <div class="ubars" aria-hidden="true">${chart.bars.map((b) => `<div class="b${b.today ? ' today' : ''}" data-h="${b.pct}" data-tip="${esc(b.tip)}"></div>`).join('')}
        ${chart.capPct === null ? '' : `<div class="capline" data-bottom="${chart.capPct}"><span>${esc(`cap ${usd(t.capUsd)}`)}</span></div>`}</div>
      <div class="uaxis" aria-hidden="true">${chart.bars.map((b) => `<span>${esc(b.label)}</span>`).join('')}</div>
      <table class="sr-only"><caption>Daily AI spend, last 14 days</caption><thead><tr><th>Day</th><th>Spend</th></tr></thead><tbody>${chart.rows.map(([d, v]) => `<tr><th>${esc(d)}</th><td>${esc(v)}</td></tr>`).join('')}</tbody></table></section>
    <section class="card col-4"><div class="card-head"><h3>Today by kind</h3></div><div class="list">${u.byUse.map((x) => `<div class="li"><div class="ic">${icon(/** @type {Record<string, string>} */ (USE_ICON)[x.use] ?? 'ai', 17)}</div>
      <div><b>${esc(x.label)}</b></div><b class="mono">${esc(usd(x.usd))}</b></div>`).join('')}</div></section></div>`;
}

/** Bar heights and the cap line from the data-* values (no inline style attributes). @param {HTMLElement} root @param {boolean} animate */
function after(root, animate) {
  countUp(root, animate);
  for (const b of $$('.ubars .b', root)) b.style.height = `${Number(b.dataset.h) || 0}%`;
  for (const c of $$('.capline', root)) c.style.bottom = `${Number(c.dataset.bottom) || 0}%`;
  if (animate && gsap && !reduceMotion) gsap.from($$('.ubars .b', root), { scaleY: 0, duration: 0.8, ease: 'expo.out', stagger: 0.03, transformOrigin: 'bottom' });
}

/** @param {ScreenCtx} ctx */
export function mountUsage(ctx) {
  let first = true;
  /** @type {Usage | null} */
  let data = null;
  const load = async () => {
    try {
      const r = await get('/usage');
      if (!ctx.live()) return;
      data = r;
      ctx.redraw(render(r));
      after(ctx.view, first);
      first = false;
    } catch (e) {
      if (ctx.live() && !data) ctx.redraw(failed(e));
    }
  };
  ctx.redraw(loading('Loading AI usage…'));
  ctx.poll(load, POLL_MS);
  return listen(ctx.view, {
    click: (e) => {
      if (/** @type {Element} */ (e.target).closest('[data-retry]')) void load();
    },
  });
}
