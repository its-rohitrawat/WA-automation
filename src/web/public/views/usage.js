// AI usage (D5 Task 5; reworked in the November release, change 4): the KPI row, the 14-day bar chart and today by kind.
// The chart has one axis (US$, 0 and up to 4 round steps), a recessive grid, the cap as a dashed line with its label,
// today's bar marked, a text tip on every day's column (a day with no spend too), and a visually hidden table for
// screen readers. The cap is set on the Mac only. Sizes and positions are set from data-* values after drawing (the
// Content-Security-Policy allows no inline style attributes).
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

const USE_ICON = { messages: 'bubble', meetings: 'video', files: 'file', speech: 'mic', voice: 'mic', assistant: 'spark', other: 'ai' };
const POLL_MS = 60_000;

/**
 * The y axis: 0 and up to 4 round steps (1, 2, 2.5 or 5 times a power of ten) that reach at least `top`. With nothing
 * to show (0, or not a number) the scale goes to $1, so the empty chart keeps its axis. decimals: 2 for steps that are
 * not whole dollars ("$0.25"), else 0 ("$5").
 * @param {number} top @returns {{ max: number, ticks: number[], decimals: number }}
 */
export function niceScale(top) {
  const t = Number.isFinite(top) && top > 0 ? top : 1;
  const pow = 10 ** Math.floor(Math.log10(t / 4));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s * 4 >= t * (1 - 1e-9)) ?? 10 * pow;
  const n = Math.max(1, Math.ceil(t / step - 1e-9));
  const ticks = Array.from({ length: n + 1 }, (_, i) => Math.round(i * step * 1e6) / 1e6);
  return { max: /** @type {number} */ (ticks[ticks.length - 1]), ticks, decimals: Number.isInteger(Math.round(step * 1e6) / 1e6) ? 0 : 2 };
}

/**
 * What the chart draws, from the days and the cap: each column's height (% of the plot), tip and state, the axis ticks,
 * the cap line's height (null without a cap), and whether every day is at $0.
 * @param {{ day: string, usd: number }[]} days @param {number} cap
 */
export function chartModel(days, cap) {
  const base = usageChart(days, cap);
  const top = Math.max(cap > 0 ? cap : 0, ...days.map((d) => (Number.isFinite(d.usd) ? d.usd : 0)), 0);
  const scale = niceScale(top);
  const pct = (/** @type {number} */ v) => Math.max(0, Math.min(100, Math.round((v / scale.max) * 1000) / 10));
  return {
    cols: base.bars.map((/** @type {{ label: string, usd: number, today: boolean, tip: string }} */ b) => {
      const over = cap > 0 && b.usd > cap;
      return { label: b.label, h: pct(b.usd), today: b.today, over, tip: `${b.tip}${b.today ? ' · today' : ''}${over ? ' · over the cap' : ''}` };
    }),
    ticks: scale.ticks.map((v) => ({ at: pct(v), label: `$${v.toFixed(scale.decimals)}` })),
    capAt: cap > 0 ? pct(cap) : null,
    rows: base.rows,
    empty: days.every((d) => !(d.usd > 0)),
  };
}

/** @param {Usage} u */
function render(u) {
  const t = u.today;
  const chart = chartModel(u.days, t.capUsd);
  const left = t.capUsd > 0 ? Math.max(0, Math.round((t.remaining / t.capUsd) * 100)) : 0;
  const used = t.capUsd > 0 ? Math.min(100, Math.max(0, Math.round((t.spent / t.capUsd) * 100))) : 0;
  const meter = used >= 100 ? ' is-full' : used >= 80 ? ' is-high' : '';
  const kinds = u.byUse.length
    ? u.byUse.map((x) => `<div class="li"><div class="ic">${icon(/** @type {Record<string, string>} */ (USE_ICON)[x.use] ?? 'ai', 17)}</div>
      <div class="u-kind">${esc(x.label)}</div><b class="mono u-amt${x.usd > 0 ? '' : ' is-zero'}">${esc(usd(x.usd))}</b></div>`).join('')
    : '<div class="empty">No AI work today yet.</div>';
  return `<div class="kpis kpis-4 u-kpis">
      <div class="card kpi"><div class="lab">${icon('dollar', 17)}Spent today</div><div class="num" data-count="${Number(t.spent)}" data-dec="2" data-pre="$">$0</div><div class="delta">${esc(`${u.batches.today} batch${u.batches.today === 1 ? '' : 'es'} · ${u.batches.messagesRead} messages read`)}</div></div>
      <div class="card kpi"><div class="lab">${icon('shield', 17)}Daily cap</div><div class="num">${esc(usd(t.capUsd))}</div><div class="delta">Set on the Mac<span class="u-env">DAILY_SPEND_CAP_USD</span></div></div>
      <div class="card kpi"><div class="lab">${icon('pie', 17)}Remaining</div><div class="num" data-count="${Number(t.remaining)}" data-dec="2" data-pre="$">$0</div><div class="delta">${esc(`${left}% left today`)}</div>
        <div class="u-meter${meter}" aria-hidden="true"><i data-w="${used}"></i></div></div>
      <div class="card kpi"><div class="lab">${icon(t.paused ? 'alert' : 'ok', 17)}Status</div><div class="num num-word${t.paused ? ' is-warn' : ''}">${t.paused ? 'At the limit' : 'Under limit'}</div><div class="delta">${t.paused ? 'Paid work waits until midnight IST' : 'Paid work pauses at the cap'}</div></div></div>
    <div class="grid"><section class="card col-8 u-card"><div class="card-head"><h3>Daily spend · last 14 days</h3>
        <div class="u-keys" aria-hidden="true"><span><i class="u-key"></i>Spend</span><span><i class="u-key is-today"></i>Today</span>${chart.capAt === null ? '' : '<span><i class="u-key is-cap"></i>Daily cap</span>'}</div></div>
      <div class="uchart" aria-hidden="true">
        <div class="uyaxis">${chart.ticks.map((k) => `<span data-bottom="${k.at}">${esc(k.label)}</span>`).join('')}</div>
        <div class="uplot">${chart.ticks.map((k) => `<i class="ugrid${k.at === 0 ? ' is-base' : ''}" data-bottom="${k.at}"></i>`).join('')}
          <div class="ubars">${chart.cols.map((c) => `<div class="ucol${c.today ? ' today' : ''}${c.over ? ' over' : ''}" data-tip="${esc(c.tip)}"><div class="b" data-h="${c.h}"></div></div>`).join('')}</div>
          ${chart.capAt === null ? '' : `<div class="capline${chart.capAt > 85 ? ' is-top' : ''}" data-bottom="${chart.capAt}"><span>${esc(`Cap ${usd(t.capUsd)}`)}</span></div>`}
          ${chart.empty ? '<p class="u-none">No AI spend in these 14 days.</p>' : ''}</div>
        <div class="uaxis">${chart.cols.map((c) => `<span${c.today ? ' class="today"' : ''}>${esc(c.label)}</span>`).join('')}</div></div>
      <table class="sr-only"><caption>Daily AI spend, last 14 days</caption><thead><tr><th>Day</th><th>Spend</th></tr></thead><tbody>${chart.rows.map(([d, v]) => `<tr><th>${esc(d)}</th><td>${esc(v)}</td></tr>`).join('')}</tbody></table></section>
    <section class="card col-4"><div class="card-head"><h3>Today by kind</h3></div><div class="list u-kinds">${kinds}</div></section></div>`;
}

/** Column heights, the axis, the grid, the cap line and the meter from the data-* values. @param {HTMLElement} root @param {boolean} animate */
function after(root, animate) {
  countUp(root, animate);
  for (const b of $$('.ucol .b', root)) b.style.height = `${Number(b.dataset.h) || 0}%`;
  for (const el of $$('.uchart [data-bottom]', root)) el.style.bottom = `${Number(el.dataset.bottom) || 0}%`;
  for (const m of $$('.u-meter i', root)) m.style.width = `${Number(m.dataset.w) || 0}%`;
  if (animate && gsap && !reduceMotion) gsap.from($$('.ucol .b', root), { scaleY: 0, duration: 0.8, ease: 'expo.out', stagger: 0.03, transformOrigin: 'bottom' });
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
