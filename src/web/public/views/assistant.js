// The AI assistant's page (November release, changes 1 and 8), like a chat app: past chats on the left (New chat, then
// Today, Yesterday, Previous 7 days and Older, each renamed or deleted from its row; delete asks first), the
// conversation in the middle, and the composer at the bottom (Enter sends, Shift+Enter is a new line), with Stop while an
// answer streams. On a phone the chat list is a drawer. Chats are kept by the agent for the workspace
// (/dashboard/assistant/<id> opens one). Answers stream in as plain text (escaped; **bold** is the only mark kept). A
// screen the agent names is an "Open …" link the owner taps: the page never jumps away on its own. A card with a drafted
// change runs only on the owner's Confirm here, with this session's CSRF token. Leaving the page stops its work in the
// browser (the stream's reading and the polls); an answer still running finishes on the agent and is saved, and a chat
// opened while its answer runs is read again every 2 s until it ends. The look follows the website's hero: an empty
// chat shows the agent's particle core (core3d.js, loaded only then, one still frame with reduced motion, nothing without
// WebGL, stopped as soon as the chat has messages or the page is left); after that a small CSS orb stands beside each
// answer and quickens while the agent is thinking.
import { ApiError, get, post, postLines } from '../api.js';
import { $, esc, icon, reduceMotion } from '../dom.js';
import { SCREENS } from '../router.js';
import { confirmDialog } from './ui.js';

/** The shell opens this screen and filter: detail { screen, search }. */
export const ASSISTANT_GO = 'wa:assistant-go';

if (typeof document !== 'undefined' && !document.querySelector('link[data-assistant-css]')) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/dashboard/static/assistant.css';
  link.dataset.assistantCss = '';
  document.head.append(link);
}

/** A screen's filter as the agent gives it: a query string of plain characters, or nothing. */
const SEARCH = /^(\?[\w=&%+.,-]*)?$/;
/** How often a chat whose answer runs elsewhere (another visit, another owner) is read again. */
const RUNNING_POLL_MS = 2_000;
const PHONE = '(max-width: 960px)';

/**
 * @typedef {{ id: string, title: string, lines: string[], expiresAt: string, state: 'live' | 'busy' | 'done' | 'cancelled' | 'expired' | 'failed', said?: string }} Card
 * @typedef {{ screen: string, search: string, label: string }} Link
 * @typedef {{ who: 'me', text: string, fresh?: boolean }
 *   | { who: 'bot', text: string, links: Link[], cards: Card[], meta: string, warn: boolean, running: boolean, step: string, fresh?: boolean }} Entry
 * @typedef {{ id: number, title: string, updatedAt: string, running: boolean }} ChatRow
 */

/** An icon for each question the agent offers (others get the spark). */
const SUGGESTION_ICONS = /** @type {Record<string, string>} */ ({
  'Summarise today': 'cal', 'What needs my attention?': 'bell', 'Show overdue tasks': 'clock', 'Which client has the most open tasks?': 'users',
  "Explain today's AI spend": 'ai', 'Summarise the latest meeting': 'video',
});

/** The questions offered before the first one, and the length limit (GET /assistant), once read while signed in. */
let offer = /** @type {{ suggestions: string[], questionMax: number } | null} */ (null);

/** Signing out: nothing of the assistant stays in the page. */
export function forgetAssistant() {
  offer = null;
}

/** Plain text to safe HTML: escaped, line breaks kept by CSS, **bold** kept. @param {string} text */
function rich(text) {
  return esc(text).replace(/\*\*([^*\n]{1,200})\*\*/g, '<b>$1</b>');
}

/** "≈ $0.04" for an answer's cost. @param {number} usd */
function cost(usd) {
  if (!(usd > 0)) return 'no AI cost';
  return usd < 0.01 ? '≈ under $0.01' : `≈ $${usd.toFixed(2)}`;
}

/** @param {string} iso */
const hhmm = (iso) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });

/** A date's day in India time, as YYYY-MM-DD. @param {Date} d */
const istDay = (d) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

/**
 * The list's group for a chat last used at `iso`: Today, Yesterday, Previous 7 days or Older (India time).
 * @param {string} iso @param {Date} now
 */
export function chatGroup(iso, now) {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return 'Older';
  const day = istDay(new Date(at));
  const today = istDay(now);
  if (day >= today) return 'Today';
  const days = Math.round((Date.parse(today) - Date.parse(day)) / 86_400_000);
  if (days <= 1) return 'Yesterday';
  if (days <= 7) return 'Previous 7 days';
  return 'Older';
}

/** A stored answer's line under it: its note and cost, or what became of it. @param {any} m */
function storedMeta(m) {
  if (m.status === 'interrupted') return 'This answer was cut off when the agent restarted.';
  const note = typeof m.note === 'string' && m.note ? `${m.note} · ` : '';
  return `${note}${cost(Number(m.costUsd))}`;
}

/** A stored message as the page draws it. @param {any} m @returns {Entry} */
export function entryOf(m) {
  const body = typeof m?.body === 'string' ? m.body : '';
  if (m?.role === 'user') return { who: 'me', text: body };
  const running = m?.status === 'running';
  return {
    who: 'bot', text: body, running, step: running ? 'Still answering…' : '', warn: m?.status === 'failed' || m?.status === 'interrupted',
    meta: running ? '' : storedMeta(m),
    links: (Array.isArray(m?.links) ? m.links : []).flatMap((/** @type {any} */ l) => (typeof l?.screen === 'string'
      ? [{ screen: l.screen, search: typeof l.search === 'string' && SEARCH.test(l.search) ? l.search : '', label: String(l.label ?? l.screen).slice(0, 80) }] : [])),
    cards: (Array.isArray(m?.cards) ? m.cards : []).flatMap((/** @type {any} */ c) => (typeof c?.id === 'string' ? [{
      id: c.id, title: String(c.title ?? ''), lines: Array.isArray(c.lines) ? c.lines.map(String) : [], expiresAt: String(c.expiresAt ?? ''),
      state: /** @type {Card['state']} */ (c.state === 'confirmed' ? 'done' : c.state === 'cancelled' ? 'cancelled' : c.live === true ? 'live' : 'expired'),
      ...(typeof c.said === 'string' ? { said: c.said } : {}),
    }] : [])),
  };
}

/** @param {Card} c */
function cardActs(c) {
  if (c.state === 'live' || c.state === 'busy') {
    const off = c.state === 'busy' ? ' disabled' : '';
    return `<button class="btn btn-primary btn-sm" type="button" data-confirm${off}>Confirm</button>
      <button class="btn btn-ghost btn-sm" type="button" data-cancel${off}>Cancel</button><small>Waits until ${esc(hhmm(c.expiresAt))}</small>`;
  }
  if (c.state === 'done') return `<small class="ok">${icon('check', 14)} ${esc(c.said ?? 'Done.')}</small>`;
  if (c.state === 'cancelled') return '<small>Cancelled. Nothing changed.</small>';
  if (c.state === 'expired') return '<small>Not confirmed. Nothing changed.</small>';
  return `<small class="warn">${esc(c.said ?? 'That did not work. Try again.')}</small>`;
}

/** The agent's small orb: beside each answer, quickening while it thinks. @param {boolean} thinking */
const orb = (thinking) => `<span class="asst-orb${thinking ? ' thinking' : ''}" aria-hidden="true"></span>`;

/**
 * An entry as HTML. `fresh` (added in this visit) fades up once as it enters; a chat opened again draws still.
 * @param {Entry} e @param {number} i
 */
export function entryHtml(e, i) {
  const enter = e.fresh ? ' enter' : '';
  if (e.who === 'me') return `<div class="asst-msg me${enter}">${esc(e.text)}</div>`;
  const text = rich(e.running ? e.text : e.text.trim());
  // Only a screen this session has (a customer has no Connections or AI usage): no link to any other.
  const links = e.links.map((l, j) => (SCREENS.has(l.screen)
    ? `<button class="asst-open" type="button" data-open="${i}:${j}">${icon('arrowR', 14)}<span>Open ${esc(l.label)}</span></button>` : '')).join('');
  const cards = e.cards.map((c, j) => `<div class="asst-card" data-card="${i}:${j}"><b>${esc(c.title)}</b><ul>${c.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
      <div class="asst-card-acts">${cardActs(c)}</div></div>`).join('');
  const step = e.running ? `<div class="asst-step" aria-hidden="true" data-label="${esc(e.step)}"><i></i><i></i><i></i></div>` : '';
  const meta = e.meta ? `<small class="asst-meta${e.warn ? ' warn' : ''}">${esc(e.meta)}</small>` : '';
  return `<div class="asst-msg bot${enter}" data-entry="${i}">${orb(e.running)}<div class="asst-body">${e.text.trim() || e.running ? `<div class="asst-text">${text}</div>` : ''}${links}${cards}${step}${meta}</div></div>`;
}

/**
 * The empty chat: the agent's core, the heading in the website's style, and the questions it offers as cards.
 * @param {string[]} suggestions
 */
export function heroHtml(suggestions) {
  return `<div class="asst-hero">
    <div class="asst-core" data-core aria-hidden="true"><canvas></canvas></div>
    <div class="eyebrow asst-hero-eyebrow"><span class="asst-live-dot" aria-hidden="true"></span>Your agent · answers from your workspace</div>
    <h3 class="asst-hero-title">Ask your agent <em>anything.</em></h3>
    <p class="asst-hero-sub">Clients, tasks, messages, meetings and AI spend. Changes wait for your Confirm.</p>
    <div class="asst-hero-sugg" data-sugg>${suggestionsHtml(suggestions)}</div>
  </div>`;
}

/** @param {string[]} suggestions */
function suggestionsHtml(suggestions) {
  return suggestions.map((s) => `<button class="asst-sugg-card" type="button" data-ask="${esc(s)}"><span class="asst-sugg-ic">${icon(SUGGESTION_ICONS[s] ?? 'spark', 17)}</span><span>${esc(s)}</span></button>`).join('');
}

/** The chat list, grouped by when each was last used. @param {ChatRow[]} chats @param {number | null} on */
export function listHtml(chats, on) {
  if (chats.length === 0) return '<p class="asst-chats-empty">Your chats show here.</p>';
  const now = new Date();
  /** @type {Map<string, ChatRow[]>} */
  const groups = new Map();
  for (const c of chats) {
    const g = chatGroup(c.updatedAt, now);
    groups.set(g, [...(groups.get(g) ?? []), c]);
  }
  return [...groups].map(([g, rows]) => `<div class="asst-chats-group"><div class="eyebrow">${esc(g)}</div>${rows.map((c) => `
    <div class="asst-chat${c.id === on ? ' on' : ''}" data-row="${c.id}">
      <a href="/dashboard/assistant/${c.id}" data-chat="${c.id}"${c.id === on ? ' aria-current="page"' : ''}>${c.running ? '<i class="asst-live" aria-label="Answering"></i>' : ''}<span>${esc(c.title)}</span></a>
      <button class="asst-row-btn" type="button" data-rename="${c.id}" aria-label="Rename ${esc(c.title)}">${icon('edit', 15)}</button>
      <button class="asst-row-btn" type="button" data-delete="${c.id}" aria-label="Delete ${esc(c.title)}">${icon('trash', 15)}</button>
    </div>`).join('')}</div>`).join('');
}

/**
 * The Assistant screen. `ctx.sub`: the chat to open (its id), or none for a new chat.
 * @param {import('./registry.js').ScreenCtx} ctx
 */
export function mountAssistant(ctx) {
  ctx.view.innerHTML = `<div class="asst-page">
    <aside class="asst-side" data-side aria-label="Chats">
      <div class="asst-side-head"><button class="btn btn-primary asst-newchat" type="button" data-new>${icon('newchat', 16)}<span>New chat</span></button>
        <button class="icon-btn asst-side-close" type="button" data-drawer-close aria-label="Close the chat list">${icon('close', 16)}</button></div>
      <nav class="asst-chats" data-chats aria-label="Past chats"></nav>
    </aside>
    <div class="asst-scrim" data-scrim hidden></div>
    <section class="asst-main" aria-label="Assistant">
      <div class="asst-bar"><button class="icon-btn asst-drawer-btn" type="button" data-drawer aria-label="Past chats" aria-expanded="false">${icon('sidebar', 17)}</button>
        <span class="asst-orb asst-bar-orb" data-bar-orb aria-hidden="true"></span>
        <div class="asst-bar-title"><div class="eyebrow">AI assistant</div><h2 class="asst-title" data-title>New chat</h2></div></div>
      <div class="asst-log" data-log role="log" aria-live="polite" tabindex="0" aria-label="Conversation"><div class="asst-col" data-col></div></div>
      <div class="asst-dock">
        <form class="asst-form" data-form novalidate><label class="sr-only" for="asst-q">Your question</label>
          <textarea id="asst-q" rows="1" maxlength="2000" placeholder="Ask about clients, tasks, meetings…" autocomplete="off"></textarea>
          <button class="btn btn-primary asst-send" type="submit" aria-label="Send">${icon('arrowR', 18)}</button>
          <button class="btn btn-ghost asst-stop" type="button" data-stop aria-label="Stop the answer" hidden>${icon('stop', 18)}</button></form>
        <p class="asst-foot">Answers use Claude and count toward the daily AI cap. Changes need your Confirm.</p>
      </div></section></div>`;
  const page = /** @type {HTMLElement} */ ($('.asst-page', ctx.view));
  const list = /** @type {HTMLElement} */ ($('[data-chats]', page));
  const scrim = /** @type {HTMLElement} */ ($('[data-scrim]', page));
  const drawerBtn = /** @type {HTMLButtonElement} */ ($('[data-drawer]', page));
  const titleEl = /** @type {HTMLElement} */ ($('[data-title]', page));
  const log = /** @type {HTMLElement} */ ($('[data-log]', page));
  const col = /** @type {HTMLElement} */ ($('[data-col]', page));
  const barOrb = /** @type {HTMLElement} */ ($('[data-bar-orb]', page));
  const form = /** @type {HTMLFormElement} */ ($('[data-form]', page));
  const input = /** @type {HTMLTextAreaElement} */ ($('#asst-q', page));
  const send = /** @type {HTMLButtonElement} */ ($('.asst-send', page));
  const stopBtn = /** @type {HTMLButtonElement} */ ($('[data-stop]', page));

  /** The open chat: its id (null for a new one, until the agent names it), title and messages. */
  let chatId = ctx.sub ? Number(ctx.sub) : null;
  let title = 'New chat';
  let entries = /** @type {Entry[]} */ ([]);
  let chats = /** @type {ChatRow[]} */ ([]);
  /** The answer this visit is reading, if any: leaving the page aborts the reading (the agent goes on). */
  let reading = /** @type {AbortController | null} */ (null);
  /** The open chat's answer runs elsewhere: it is read again until it ends. */
  let runningElsewhere = false;
  let pollTimer = /** @type {ReturnType<typeof setTimeout> | undefined} */ (undefined);
  let alive = true;
  /** The platform has the assistant switched off (GET /assistant is a 404): the page says so instead of a chat. */
  let switchedOff = false;
  /** The particle core's stop, while the empty chat shows it; `coreTurn` drops a start that finishes too late. */
  let stopCore = /** @type {(() => void) | null} */ (null);
  let coreTurn = 0;

  const scrollDown = () => {
    log.scrollTop = log.scrollHeight;
  };
  const busy = () => reading !== null || runningElsewhere;

  /** The empty chat's questions, once the agent has said them (the core is left as it is). */
  function drawSuggestions() {
    const box = col.querySelector('[data-sugg]');
    if (box) box.innerHTML = suggestionsHtml(offer?.suggestions ?? []);
  }

  /** The core, on the empty chat's canvas: loaded only now, and never left running when it is gone. */
  function coreOn() {
    const canvas = /** @type {HTMLCanvasElement | null} */ (col.querySelector('[data-core] canvas'));
    if (!canvas || stopCore) return;
    const turn = ++coreTurn;
    const still = () => alive && turn === coreTurn && canvas.isConnected;
    void import('../core3d.js').then(async ({ startCore }) => {
      if (!still()) return;
      const stop = await startCore(canvas, { reduceMotion });
      if (still()) stopCore = stop;
      else stop();
    }).catch(() => {});
  }

  function coreOff() {
    coreTurn++;
    stopCore?.();
    stopCore = null;
  }

  function drawChat() {
    titleEl.textContent = title;
    coreOff();
    input.disabled = switchedOff;
    send.disabled = switchedOff;
    if (switchedOff) {
      col.innerHTML = '<div class="asst-off"><span class="asst-orb" aria-hidden="true"></span><h3>The assistant is switched off</h3><p>It is not on for this workspace. Ask the person who runs the dashboard to switch it on.</p></div>';
    } else if (entries.length === 0 && chatId !== null) {
      col.innerHTML = '<div class="asst-loading" aria-hidden="true"><span class="asst-orb thinking"></span></div>'; // a past chat, being read
    } else if (entries.length === 0) {
      col.innerHTML = heroHtml(offer?.suggestions ?? []);
      coreOn();
    } else {
      col.innerHTML = entries.map(entryHtml).join('');
      for (const e of entries) e.fresh = false; // each fades up once
    }
    drawDock();
    scrollDown();
  }

  /** Redraws one entry in place. @param {number} i */
  function drawEntry(i) {
    const el = col.querySelector(`[data-entry="${i}"]`);
    const e = entries[i];
    if (el && e) el.outerHTML = entryHtml(e, i);
  }

  function drawDock() {
    send.hidden = busy();
    stopBtn.hidden = !busy();
    stopBtn.disabled = chatId === null; // a new chat's Stop works once the agent has named it
    barOrb.classList.toggle('thinking', busy());
  }

  function drawList() {
    list.innerHTML = listHtml(chats, chatId);
  }

  function setDrawer(/** @type {boolean} */ open) {
    page.classList.toggle('side-open', open);
    scrim.hidden = !open;
    drawerBtn.setAttribute('aria-expanded', String(open));
  }

  async function loadOffer() {
    if (!offer) {
      try {
        const r = await get('/assistant');
        offer = {
          suggestions: Array.isArray(r?.suggestions) ? r.suggestions.filter((/** @type {unknown} */ s) => typeof s === 'string').slice(0, 8) : [],
          questionMax: Number.isInteger(r?.questionMax) ? r.questionMax : 2000,
        };
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          switchedOff = true;
          if (alive) drawChat();
          return;
        }
        offer = { suggestions: [], questionMax: 2000 };
      }
    }
    if (alive) {
      input.maxLength = offer.questionMax;
      drawSuggestions();
    }
  }

  async function loadList() {
    try {
      const r = await get('/assistant/chats');
      chats = (Array.isArray(r?.chats) ? r.chats : []).flatMap((/** @type {any} */ c) => (Number.isSafeInteger(c?.id) && typeof c.title === 'string'
        ? [{ id: c.id, title: c.title, updatedAt: String(c.updatedAt ?? ''), running: c.running === true }] : []));
    } catch {
      chats = [];
    }
    if (alive) drawList();
  }

  /** Reads the open chat from the agent and draws it; polls while its answer runs elsewhere. */
  async function loadChat() {
    if (chatId === null) return;
    const id = chatId;
    let r;
    try {
      r = await get(`/assistant/chats/${id}`);
    } catch (e) {
      if (!alive || id !== chatId) return;
      if (e instanceof ApiError && e.status === 404) {
        // Deleted, or another workspace's: a new chat instead.
        ctx.go('assistant', null);
        return;
      }
      runningElsewhere = false;
      entries = [{ who: 'bot', text: '', links: [], cards: [], running: false, step: '', warn: true, meta: 'This chat could not be opened. Try again.' }];
      drawChat();
      return;
    }
    if (!alive || id !== chatId || reading) return;
    title = typeof r?.chat?.title === 'string' ? r.chat.title : 'Chat';
    entries = (Array.isArray(r?.messages) ? r.messages : []).map(entryOf);
    runningElsewhere = r?.running === true;
    drawChat();
    clearTimeout(pollTimer);
    if (runningElsewhere) pollTimer = setTimeout(() => void loadChat(), RUNNING_POLL_MS);
    else if (chats.some((c) => c.id === id && c.running)) void loadList();
  }

  /** @param {string} question */
  async function ask(question) {
    const q = question.trim();
    if (!q || busy()) return;
    input.value = '';
    entries.push({ who: 'me', text: q, fresh: true });
    const bot = /** @type {Extract<Entry, { who: 'bot' }>} */ ({ who: 'bot', text: '', links: [], cards: [], meta: '', warn: false, running: true, step: '', fresh: true });
    entries.push(bot);
    const at = entries.length - 1;
    const ctrl = new AbortController();
    reading = ctrl;
    drawChat();
    const textEl = () => /** @type {HTMLElement | null} */ (col.querySelector(`[data-entry="${at}"] .asst-text`));
    try {
      await postLines('/assistant/ask', { question: q, ...(chatId === null ? {} : { chatId }) }, (e) => {
        if (!alive || !e || typeof e.type !== 'string') return;
        if (e.type === 'chat' && Number.isSafeInteger(e.id)) {
          chatId = e.id;
          title = typeof e.title === 'string' ? e.title : title;
          titleEl.textContent = title;
          drawDock();
          chats = [{ id: e.id, title, updatedAt: new Date().toISOString(), running: true }, ...chats.filter((c) => c.id !== e.id)];
          drawList();
        } else if (e.type === 'text' && typeof e.text === 'string') {
          bot.text += e.text;
          const t = textEl();
          if (t) t.innerHTML = rich(bot.text); // escaped first; a **bold** shows as soon as it closes
        } else if (e.type === 'tool' && typeof e.label === 'string') {
          bot.step = `${e.label}…`;
          col.querySelector(`[data-entry="${at}"] .asst-step`)?.setAttribute('data-label', bot.step);
        } else if (e.type === 'navigate' && typeof e.screen === 'string') {
          const search = typeof e.search === 'string' && SEARCH.test(e.search) ? e.search : '';
          bot.links.push({ screen: e.screen, search, label: String(e.label ?? e.screen).slice(0, 80) });
          drawEntry(at);
        } else if (e.type === 'proposal' && e.card && typeof e.card.id === 'string') {
          const c = e.card;
          bot.cards.push({ id: c.id, title: String(c.title ?? ''), lines: Array.isArray(c.lines) ? c.lines.map(String) : [], expiresAt: String(c.expiresAt ?? ''), state: 'live' });
          drawEntry(at);
        } else if (e.type === 'done') {
          bot.meta = `${typeof e.note === 'string' ? `${e.note} · ` : ''}${cost(Number(e.costUsd))}`;
          bot.warn = e.status === 'failed';
        }
        scrollDown();
      }, ctrl.signal);
    } catch (e) {
      if (!ctrl.signal.aborted) {
        bot.meta = e instanceof ApiError ? e.message : 'The assistant could not be reached. Try again.';
        bot.warn = true;
      }
    } finally {
      if (reading === ctrl) reading = null;
      bot.running = false;
      if (alive) {
        drawEntry(at);
        drawDock();
        chats = chats.map((c) => (c.id === chatId ? { ...c, running: false } : c));
        drawList();
        scrollDown();
        input.focus();
      }
    }
  }

  async function stop() {
    if (chatId === null) return;
    stopBtn.disabled = true;
    try {
      await post(`/assistant/chats/${chatId}/stop`, {});
    } catch {
      stopBtn.disabled = false;
    }
    // The answer ends on the agent; this page sees it end (the stream, or the next read).
  }

  /** @param {string} ref "<entry>:<card>" @param {'confirm' | 'cancel'} what */
  async function decide(ref, what) {
    const [i, j] = ref.split(':').map(Number);
    const e = entries[i ?? -1];
    const c = e && e.who === 'bot' ? e.cards[j ?? -1] : undefined;
    if (!c || c.state !== 'live') return;
    c.state = 'busy';
    drawEntry(/** @type {number} */ (i));
    try {
      if (what === 'cancel') {
        await post('/assistant/cancel', { id: c.id });
        c.state = 'cancelled';
      } else {
        const r = await post('/assistant/confirm', { id: c.id });
        c.state = 'done';
        c.said = typeof r?.message === 'string' ? r.message : 'Done.';
      }
    } catch (err) {
      c.state = 'failed';
      c.said = err instanceof ApiError ? err.message : 'That did not work. Try again.';
    }
    if (alive) drawEntry(/** @type {number} */ (i));
  }

  /** Renames a chat in its row: an input, Enter saves, Escape puts the name back. @param {number} id */
  function startRename(id) {
    const row = list.querySelector(`[data-row="${id}"]`);
    const c = chats.find((x) => x.id === id);
    if (!row || !c) return;
    row.innerHTML = `<input class="asst-rename" type="text" maxlength="80" aria-label="Chat name" value="${esc(c.title)}">`;
    const field = /** @type {HTMLInputElement} */ (row.querySelector('input'));
    field.focus();
    field.select();
    let done = false;
    const finish = async (/** @type {boolean} */ save) => {
      if (done) return;
      done = true;
      const next = field.value.replace(/\s+/g, ' ').trim();
      if (save && next && next !== c.title) {
        try {
          await post(`/assistant/chats/${id}/rename`, { title: next });
          c.title = next;
          if (id === chatId) {
            title = next;
            titleEl.textContent = next;
          }
        } catch (e) {
          if (alive) toastWarn(e instanceof ApiError ? e.message : 'The name could not be saved. Try again.');
        }
      }
      if (alive) drawList();
    };
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        void finish(false);
      }
    });
    field.addEventListener('blur', () => void finish(true));
  }

  /** @param {number} id */
  async function remove(id) {
    const c = chats.find((x) => x.id === id);
    if (!c) return;
    const yes = await confirmDialog({
      eyebrow: 'Delete chat', title: `Delete “${c.title}”?`, yes: 'Delete',
      text: 'The chat and its answers are removed for everyone in this workspace. Changes you confirmed in it stay. This cannot be undone.',
    });
    if (!yes || !alive) return;
    try {
      await post(`/assistant/chats/${id}/delete`, {});
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) {
        if (alive) toastWarn(e instanceof ApiError ? e.message : 'The chat could not be deleted. Try again.');
        return;
      }
    }
    if (!alive) return;
    chats = chats.filter((x) => x.id !== id);
    if (id === chatId) newChat();
    else drawList();
  }

  /**
   * A new chat. Opened at /dashboard/assistant (no chat in the address), the page starts one itself: the shell would see
   * the same screen and address, and draw nothing. Opened on a chat, the shell opens /dashboard/assistant.
   */
  function newChat() {
    if (ctx.sub !== null) return void ctx.go('assistant', null);
    clearTimeout(pollTimer);
    reading?.abort();
    reading = null;
    runningElsewhere = false;
    chatId = null;
    title = 'New chat';
    entries = [];
    drawChat();
    drawList();
    input.focus();
  }

  /** A short warning under the conversation. @param {string} text */
  function toastWarn(text) {
    entries.push({ who: 'bot', text: '', links: [], cards: [], running: false, step: '', warn: true, meta: text });
    drawChat();
  }

  page.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (t.closest('[data-new]')) {
      setDrawer(false);
      return void newChat();
    }
    if (t.closest('[data-drawer]')) return void setDrawer(!page.classList.contains('side-open'));
    if (t.closest('[data-drawer-close]') || t.closest('[data-scrim]')) return void setDrawer(false);
    if (t.closest('[data-stop]')) return void stop();
    const rename = /** @type {HTMLElement | null} */ (t.closest('[data-rename]'));
    if (rename) return void startRename(Number(rename.dataset.rename));
    const del = /** @type {HTMLElement | null} */ (t.closest('[data-delete]'));
    if (del) return void remove(Number(del.dataset.delete));
    const link = /** @type {HTMLAnchorElement | null} */ (t.closest('a[data-chat]'));
    if (link) {
      // A link opened in a new tab keeps the browser's own behaviour.
      if (/** @type {MouseEvent} */ (e).ctrlKey || /** @type {MouseEvent} */ (e).metaKey || /** @type {MouseEvent} */ (e).shiftKey) return;
      e.preventDefault();
      setDrawer(false);
      const id = Number(link.dataset.chat);
      if (id !== chatId || ctx.sub !== String(id)) ctx.go('assistant', String(id));
      return;
    }
    const chip = /** @type {HTMLElement | null} */ (t.closest('[data-ask]'));
    if (chip) return void ask(chip.dataset.ask ?? '');
    const open = /** @type {HTMLElement | null} */ (t.closest('[data-open]'));
    if (open) {
      const [i, j] = (open.dataset.open ?? '').split(':').map(Number);
      const en = entries[i ?? -1];
      const l = en && en.who === 'bot' ? en.links[j ?? -1] : undefined;
      if (l) dispatchEvent(new CustomEvent(ASSISTANT_GO, { detail: { screen: l.screen, search: l.search } }));
      return;
    }
    const card = /** @type {HTMLElement | null} */ (t.closest('[data-card]'));
    if (card && t.closest('[data-confirm]')) return void decide(card.dataset.card ?? '', 'confirm');
    if (card && t.closest('[data-cancel]')) return void decide(card.dataset.card ?? '', 'cancel');
  });
  page.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && page.classList.contains('side-open')) {
      e.stopPropagation();
      setDrawer(false);
      drawerBtn.focus();
    }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void ask(input.value);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void ask(input.value);
    }
  });

  drawChat();
  void loadOffer();
  void loadList();
  void loadChat();
  if (!matchMedia(PHONE).matches) input.focus();

  // Leaving the page: the stream's reading and the polls stop, so nothing keeps running behind the next screen. The
  // answer itself runs on in the agent and is saved.
  return () => {
    alive = false;
    coreOff();
    clearTimeout(pollTimer);
    reading?.abort();
    reading = null;
  };
}
