// Overview: greeting, the five counts, the agent vitals monitor, AI spend, tasks by client, latest meetings, recent
// activity and the tracker. Every value from the agent goes through esc() or textContent.
import { problems } from '../contract.js';
import { $, $$, countUp, esc, gsap, icon, reduceMotion } from '../dom.js';
import { ago, clock, greeting, today, usd, when } from '../format.js';
import { fixFor } from './connect.js';

/** @typedef {ReturnType<typeof import('../contract.js').readStatus>} Status */
/** @typedef {ReturnType<typeof import('../contract.js').readOverview>} Overview */

const LAMP = { ok: '', warn: 'warn', down: 'down', off: 'off' };
/** @type {Record<string, string>} */
const ACTIVITY_ICON = { msg: 'bubble', task: 'task', issue: 'alert' };

/**
 * The attention banner, or ''. Shared with other screens. Fix now opens the dialog that fixes the first problem, or
 * Connections when no single dialog does. @param {Status | null} status
 */
export function attentionBanner(status) {
  if (!status) return '';
  const p = problems(status);
  if (p.length === 0) return '';
  const head = p.length === 1 ? 'One part needs you' : `${p.length} parts need you`;
  const fix = fixFor(p[0]);
  return `<div class="attn" role="status">${icon('alert', 20)}<div class="grow-1"><b>${esc(head)}</b><div>${p.map((x) => esc(x.detail ? `${x.label}: ${x.detail}` : x.label)).join(' · ')}</div></div>
    <button class="btn btn-primary btn-sm" type="button" ${fix ? `data-fix="${esc(fix)}"` : 'data-go="connections"'}>Fix now</button></div>`;
}

/** Setup mode: the founder's phone has never been linked, so nothing else can work yet. @param {Status | null} status */
export const isSetup = (status) => Boolean(status?.parts.some((p) => p.key === 'whatsapp' && p.detail === 'Not linked'));

/** The one thing to do in setup mode. @param {string} first */
function setupScreen(first) {
  return `<div class="hello"><div><h2>${esc(`Welcome, ${first}`)}</h2><p>${esc(today())}</p></div></div>
    <section class="card setup-cta"><div class="badge">${icon('phone', 26)}</div>
      <div class="grow-1"><h3>Link the founder's phone</h3>
        <p class="m-p">The agent isn't reading WhatsApp yet. Link the founder's phone once: in WhatsApp open Linked devices → Link a device, and scan the code shown here. Everything else starts on its own.</p></div>
      <button class="btn btn-primary" type="button" data-fix="founder-link">${icon('phone', 16)}Link the founder's phone</button></section>`;
}

/** @param {{ name: string, email: string } | null} me @param {Status | null} status @param {Overview | null} ov @param {unknown} [error] */
export function renderOverview(me, status, ov, error) {
  const first = (me?.name || '').trim().split(/\s+/)[0] || 'there';
  if (isSetup(status)) return setupScreen(first);
  const hello = `<div class="hello"><div><h2>${esc(`${greeting()}, ${first}`)}</h2><p>${esc(today())}${status?.lastMessageAt ? ` · last message ${esc(ago(status.lastMessageAt))}` : ''}</p></div>
    ${ov ? `<div class="row-gap"><span class="pill ${ov.tracker.ok ? 'p-done' : 'p-warn'}"><i></i>${ov.tracker.lastPublishedAt ? `Tracker synced ${esc(ago(ov.tracker.lastPublishedAt))}` : 'Tracker not uploaded yet'}</span></div>` : ''}</div>`;
  if (!ov) {
    return `${attentionBanner(status)}${hello}<p class="loading">${error ? 'The numbers could not be loaded. Trying again shortly.' : 'Loading the numbers…'}</p>`;
  }
  const t = ov.totals;
  const kpis = [
    ['Active clients', 'users', ov.clients, ov.clients === 1 ? 'One group approved' : `${ov.clients} groups approved`, 'rgba(37,211,102,.12)', ''],
    ['Open tasks', 'task', t.open, 'Across every client', 'rgba(0,143,122,.16)', ''],
    ['Overdue', 'alert', t.overdue, 'Deadline passed, not done', 'rgba(217,79,99,.16)', t.overdue > 0 ? 'alert' : ''],
    ['Needs review', 'info', t.review, 'Marked maybe done', 'rgba(61,143,217,.16)', ''],
    ['Done this week', 'ok', t.doneThisWeek, 'Closed since Monday', 'rgba(43,170,74,.16)', ''],
  ];
  return `${attentionBanner(status)}${hello}
  <div class="kpis">${kpis.map(([l, ic, n, d, glow, cls]) => `<div class="card kpi ${cls}" data-glow="${glow}"><div class="lab">${icon(String(ic), 17)}${esc(l)}</div><div class="num" data-count="${Number(n)}">0</div><div class="delta">${esc(d)}</div></div>`).join('')}</div>
  <div class="grid">
    ${monitor(status)}
    ${spend(status)}
    ${tasksByClient(ov)}
    <section class="card col-5"><div class="card-head"><h3>Latest meetings</h3><button class="link" type="button" data-go="meetings">All meetings ${icon('chevR', 14)}</button></div>
      ${ov.meetings.length ? `<div class="list">${ov.meetings.slice(0, 4).map((m) => `<div class="li"><div class="ic">${icon('video', 17)}</div><div><b>${esc(m.title || 'Meeting')}</b><small>${esc(m.statusLabel || m.status)} · ${esc(when(m.at))}</small></div><time>${m.minutes === null ? '' : `${esc(m.minutes)} min`}</time></div>`).join('')}</div>` : '<p class="empty-note">No meetings yet.</p>'}</section>
    <section class="card col-7"><div class="card-head"><h3>Recent activity</h3><button class="link" type="button" data-go="activity">See all ${icon('chevR', 14)}</button></div>
      ${ov.activity.length ? `<div class="list">${ov.activity.slice(0, 5).map((a) => `<div class="li"><div class="ic">${icon(ACTIVITY_ICON[a.kind] ?? 'task', 17)}</div><div><b>${esc(a.title)}${a.detail ? ` · ${esc(a.detail)}` : ''}</b>${a.who ? `<small>${esc(a.who)}</small>` : ''}</div><time>${esc(clock(a.at))}</time></div>`).join('')}</div>` : '<p class="empty-note">Nothing yet today.</p>'}</section>
    <section class="card col-5"><div class="card-head"><h3>Tracker</h3><span class="pill ${ov.tracker.ok ? 'p-done' : 'p-warn'}"><i></i>${ov.tracker.ok ? 'Healthy' : 'Needs attention'}</span></div>
      <div class="li flush"><div class="ic">${icon('xls', 17)}</div><div><b>Tracker.xlsx</b><small>${esc(ov.tracker.label || 'Google Drive · WA Agent folder')}</small></div><time>${esc(ago(ov.tracker.lastPublishedAt))}</time></div>
      <div class="split"><div><small>Last upload</small><b>${esc(clock(ov.tracker.lastPublishedAt))}</b></div><div><small>Clients</small><b>${esc(ov.clients)}</b></div></div>
      <div class="note">${icon('info', 16)}<span>The agent rebuilds this file. Change tasks here or in the CLI, not in the spreadsheet.</span></div></section>
  </div>`;
}

/** @param {Status | null} status */
function monitor(status) {
  const p = status ? problems(status) : [];
  const word = !status ? 'Checking' : p.some((x) => x.state === 'down') ? 'Down' : p.length ? 'Attention' : 'Healthy';
  return `<section class="monitor col-8" aria-label="Agent vitals">
      <div class="mon-head"><span>AGENT VITALS · OFFICE MAC</span><span class="mon-live"><i></i>LIVE${status?.checkedAt ? ` · CHECKED ${esc(ago(status.checkedAt).toUpperCase())}` : ''}</span></div>
      <div class="mon-body">
        <div><canvas id="ecg" aria-hidden="true"></canvas>
          <div class="eyebrow mon-eyebrow">Uptime · last 30 days</div>
          <p class="strip-note">Uptime history starts with the next update.</p></div>
        <div class="readouts">
          <div class="readout"><div class="t">Status</div><div class="v">${esc(word)}</div><div class="s">${esc(status ? (p.length ? p.length === 1 ? '1 part needs you' : `${p.length} parts need you` : 'every part answering') : '…')}</div></div>
          <div class="readout"><div class="t">Uptime 30 d</div><div class="v">—</div><div class="s">from the next update</div></div>
          <div class="readout"><div class="t">Last message</div><div class="v">${esc(status?.lastMessageAt ? ago(status.lastMessageAt).replace(' ago', '') : '—')}</div><div class="s">WhatsApp</div></div>
        </div>
      </div>
      <div class="parts">${(status?.parts ?? []).map((x) => `<span${x.detail ? ` data-tip="${esc(x.detail)}"` : ''}><i class="lamp ${LAMP[x.state] ?? 'off'}"></i>${esc(x.label)}</span>`).join('')}</div>
    </section>`;
}

/** @param {Status | null} status */
function spend(status) {
  const spent = status?.spentToday ?? 0;
  const cap = status?.capUsd ?? 0;
  return `<section class="card col-4"><div class="card-head"><h3>AI spend today</h3><button class="link" type="button" data-go="usage">Details ${icon('chevR', 14)}</button></div>
      <div class="gauge-wrap"><svg viewBox="0 0 220 120" width="100%" height="150" aria-hidden="true"><path d="M20 110 A90 90 0 0 1 200 110" fill="none" stroke="var(--line-2)" stroke-width="16" stroke-linecap="round"/>
        <path id="gauge" d="M20 110 A90 90 0 0 1 200 110" fill="none" stroke="#25D366" stroke-width="16" stroke-linecap="round" pathLength="100" stroke-dasharray="100" stroke-dashoffset="100"/></svg></div>
      <div class="gauge-num"><b data-count="${spent}" data-dec="2" data-pre="$">$0</b><small>${cap ? `of the ${esc(usd(cap))} daily cap` : 'no daily cap set'}</small></div>
      <div class="split"><div><small>Remaining</small><b>${cap ? esc(usd(Math.max(0, cap - spent))) : '—'}</b></div><div><small>Daily cap</small><b>${cap ? esc(usd(cap)) : '—'}</b></div></div></section>`;
}

/** @param {Overview} ov */
function tasksByClient(ov) {
  const segs = ov.segments;
  const head = `<div class="card-head"><h3>Tasks by client</h3>
      <div class="legend"><span><i class="k-overdue"></i>Overdue</span><span><i class="k-open"></i>Open</span><span><i class="k-review"></i>Needs review</span><span><i class="k-done"></i>Done this week</span></div></div>`;
  if (!segs.length) return `<section class="card col-7">${head}<p class="empty-note">No clients approved yet. Open Clients → Manage groups.</p></section>`;
  const parts = (/** @type {typeof segs[number]} */ c) => /** @type {const} */ ([['overdue', c.overdue, 'Overdue'], ['open', c.open, 'Open'], ['review', c.review, 'Needs review'], ['done', c.doneThisWeek, 'Done this week']]);
  const total = (/** @type {typeof segs[number]} */ c) => c.overdue + c.open + c.review + c.doneThisWeek;
  return `<section class="card col-7">${head}
      <div class="sbars" aria-hidden="true">${segs.map((c) => `<div class="sbar"><div class="nm"><b>${esc(c.code)}</b>${esc(c.name)}</div><div class="track">${parts(c).filter(([, n]) => n > 0).map(([k, n, l]) => `<i class="k-${k}" data-share="${n}" data-tip="${esc(`${c.name} · ${l}: ${n}`)}"></i>`).join('')}</div><div class="tot">${total(c)}</div></div>`).join('')}</div>
      <div class="sr-only"><table><caption>Tasks by client</caption><thead><tr><th>Client</th><th>Overdue</th><th>Open</th><th>Needs review</th><th>Done this week</th></tr></thead>
        <tbody>${segs.map((c) => `<tr><th>${esc(c.name)} (${esc(c.code)})</th><td>${c.overdue}</td><td>${c.open}</td><td>${c.review}</td><td>${c.doneThisWeek}</td></tr>`).join('')}</tbody></table></div></section>`;
}

/**
 * After the HTML is in place: numbers, gauge, bar widths, KPI glows and the monitor trace. @param {HTMLElement} root @param {Status | null} status
 * @param {{ animate: boolean }} [opts] animate: count up and grow (the first draw of a visit); otherwise show the values
 */
export function afterOverview(root, status, opts = { animate: true }) {
  const animate = opts.animate && !reduceMotion && Boolean(gsap);
  countUp(root, animate);
  for (const k of $$('.kpi[data-glow]', root)) k.style.setProperty('--glow', k.dataset.glow ?? '');
  const max = Math.max(1, ...$$('.sbar', root).map((b) => $$('.track i', b).reduce((s, i) => s + Number(i.dataset.share), 0)));
  for (const i of $$('.sbar .track i', root)) i.style.width = `${(Number(i.dataset.share) / max) * 100}%`;
  const gauge = /** @type {SVGPathElement | null} */ (root.querySelector('#gauge'));
  const cap = status?.capUsd ?? 0;
  const target = 100 - (cap > 0 ? Math.min(1, (status?.spentToday ?? 0) / cap) : 0) * 100;
  if (gauge) {
    if (!animate) gauge.style.strokeDashoffset = String(target);
    else gsap.to(gauge, { strokeDashoffset: target, duration: 1.2, ease: 'expo.out', delay: 0.2 });
  }
  if (animate) gsap.from($$('.sbar .track i', root), { scaleX: 0, duration: 0.9, ease: 'expo.out', stagger: 0.02, delay: 0.15 });
  startEcg(root);
}

let ecgRaf = 0;
/** The bedside-monitor trace. A still line with reduced motion. @param {HTMLElement} root */
function startEcg(root) {
  cancelAnimationFrame(ecgRaf);
  const cv = /** @type {HTMLCanvasElement | null} */ ($('#ecg', root));
  if (!cv) return;
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  const d = Math.min(2, devicePixelRatio || 1);
  const r = cv.getBoundingClientRect();
  cv.width = r.width * d;
  cv.height = r.height * d;
  ctx.setTransform(d, 0, 0, d, 0, 0);
  const w = r.width;
  const h = r.height;
  ctx.strokeStyle = '#25D366';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.shadowColor = 'rgba(37,211,102,.6)';
  ctx.shadowBlur = 6;
  const beat = (/** @type {number} */ p) =>
    p < 0.1 ? 0 : p < 0.16 ? Math.sin(((p - 0.1) / 0.06) * Math.PI) * 0.12 : p < 0.22 ? 0 : p < 0.24 ? -0.12 : p < 0.27 ? 1 : p < 0.3 ? -0.28 : p < 0.42 ? 0 : p < 0.56 ? Math.sin(((p - 0.42) / 0.14) * Math.PI) * 0.22 : 0;
  if (reduceMotion) {
    ctx.beginPath();
    for (let x = 0; x <= w; x += 2) {
      const y = h * 0.58 - beat((x / 160) % 1) * h * 0.42;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    return;
  }
  let x = 0;
  /** @type {number | null} */
  let last = null;
  let t = 0;
  let prev = performance.now();
  const loop = (/** @type {number} */ now) => {
    if (!document.contains(cv)) return;
    const dt = Math.min(50, now - prev);
    prev = now;
    for (let k = 0; k < 3; k++) {
      const sdt = dt / 3;
      t += sdt / 1000;
      const nx = x + (130 * sdt) / 1000;
      ctx.clearRect(x, 0, 26, h);
      const y = h * 0.58 - beat(((t * 72) / 60) % 1) * h * 0.42;
      if (last !== null) {
        ctx.beginPath();
        ctx.moveTo(x, last);
        ctx.lineTo(nx, y);
        ctx.stroke();
      }
      last = y;
      x = nx;
      if (x > w) {
        x = 0;
        last = null;
      }
    }
    ecgRaf = requestAnimationFrame(loop);
  };
  ecgRaf = requestAnimationFrame(loop);
}
