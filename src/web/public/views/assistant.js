// The AI assistant's page (November release, changes 1 and 8): a screen of its own, opened from the side menu's
// Assistant entry or the "Ask the assistant" button at its foot. The conversation fills the middle and the composer sits
// at the bottom (Enter sends, Shift+Enter is a new line), with Stop while an answer streams. Answers stream in as plain
// text (escaped; **bold** is the only mark kept). A screen the agent names is an "Open …" link the owner taps: the page
// never jumps away on its own. A card with a drafted change runs only on the owner's Confirm here, on the agent, with
// this session's CSRF token. Leaving the page stops its work in the browser: the stream's reading is aborted and nothing
// keeps running behind the next screen. This page's copy of the chat is kept in memory while signed in, and forgotten on
// sign-out.
import { ApiError, get, post, postLines } from '../api.js';
import { $, esc, icon } from '../dom.js';

/** The shell opens this screen and filter: detail { screen, search }. */
export const ASSISTANT_GO = 'wa:assistant-go';

if (!document.querySelector('link[data-assistant-css]')) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/dashboard/static/assistant.css';
  link.dataset.assistantCss = '';
  document.head.append(link);
}

/** A screen's filter as the agent gives it: a query string of plain characters, or nothing. */
const SEARCH = /^(\?[\w=&%+.,-]*)?$/;

/**
 * @typedef {{ id: string, title: string, lines: string[], expiresAt: string, state: 'live' | 'busy' | 'done' | 'cancelled' | 'failed', said?: string }} Card
 * @typedef {{ screen: string, search: string, label: string }} Link
 * @typedef {{ who: 'me', text: string } | { who: 'bot', text: string, links: Link[], cards: Card[], meta: string, warn: boolean, running: boolean, step: string }} Entry
 */

/** This page's copy of the chat, kept while signed in (the agent keeps its own for the questions that follow). */
let entries = /** @type {Entry[]} */ ([]);
/** The questions offered before the first one, and the length limit (GET /assistant), once read. */
let offer = /** @type {{ suggestions: string[], questionMax: number } | null} */ (null);

/** Signing out: nothing of the chat stays in the page. */
export function forgetAssistant() {
  entries = [];
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

/** @param {Card} c */
function cardActs(c) {
  if (c.state === 'live' || c.state === 'busy') {
    const off = c.state === 'busy' ? ' disabled' : '';
    return `<button class="btn btn-primary btn-sm" type="button" data-confirm${off}>Confirm</button>
      <button class="btn btn-ghost btn-sm" type="button" data-cancel${off}>Cancel</button><small>Waits until ${esc(hhmm(c.expiresAt))}</small>`;
  }
  if (c.state === 'done') return `<small class="ok">${icon('check', 14)} ${esc(c.said ?? 'Done.')}</small>`;
  if (c.state === 'cancelled') return '<small>Cancelled. Nothing changed.</small>';
  return `<small class="warn">${esc(c.said ?? 'That did not work. Try again.')}</small>`;
}

/** @param {Entry} e @param {number} i */
function entryHtml(e, i) {
  if (e.who === 'me') return `<div class="asst-msg me">${esc(e.text)}</div>`;
  const text = e.running ? esc(e.text) : rich(e.text.trim());
  const links = e.links.map((l, j) => `<button class="asst-open" type="button" data-open="${i}:${j}">${icon('arrowR', 14)}<span>Open ${esc(l.label)}</span></button>`).join('');
  const cards = e.cards.map((c, j) => `<div class="asst-card" data-card="${i}:${j}"><b>${esc(c.title)}</b><ul>${c.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
      <div class="asst-card-acts">${cardActs(c)}</div></div>`).join('');
  const step = e.running ? `<div class="asst-step" aria-hidden="true" data-label="${esc(e.step)}"><i></i><i></i><i></i></div>` : '';
  const meta = e.meta ? `<small class="asst-meta${e.warn ? ' warn' : ''}">${esc(e.meta)}</small>` : '';
  return `<div class="asst-msg bot" data-entry="${i}">${e.text.trim() || e.running ? `<div class="asst-text">${text}</div>` : ''}${links}${cards}${step}${meta}</div>`;
}

/**
 * The Assistant screen.
 * @param {import('./registry.js').ScreenCtx} ctx
 */
export function mountAssistant(ctx) {
  ctx.view.innerHTML = `<div class="asst-page"><section class="asst-main" aria-label="Assistant">
      <div class="asst-bar"><div><div class="eyebrow">AI assistant</div><h2 class="asst-title">Ask about your work</h2></div>
        <button class="btn btn-ghost btn-sm" type="button" data-new>${icon('newchat', 16)}<span>New chat</span></button></div>
      <div class="asst-log" data-log role="log" aria-live="polite" tabindex="0" aria-label="Conversation"><div class="asst-col" data-col></div></div>
      <div class="asst-dock">
        <div class="asst-sugg" data-sugg hidden></div>
        <form class="asst-form" data-form novalidate><label class="sr-only" for="asst-q">Your question</label>
          <textarea id="asst-q" rows="1" maxlength="2000" placeholder="Ask about clients, tasks, meetings…" autocomplete="off"></textarea>
          <button class="btn btn-primary asst-send" type="submit" aria-label="Send">${icon('arrowR', 18)}</button>
          <button class="btn btn-ghost asst-stop" type="button" data-stop aria-label="Stop the answer" hidden>${icon('stop', 18)}</button></form>
        <p class="asst-foot">Answers use Claude and count toward the daily AI cap. Changes need your Confirm.</p>
      </div></section></div>`;
  const page = /** @type {HTMLElement} */ ($('.asst-page', ctx.view));
  const log = /** @type {HTMLElement} */ ($('[data-log]', page));
  const col = /** @type {HTMLElement} */ ($('[data-col]', page));
  const sugg = /** @type {HTMLElement} */ ($('[data-sugg]', page));
  const form = /** @type {HTMLFormElement} */ ($('[data-form]', page));
  const input = /** @type {HTMLTextAreaElement} */ ($('#asst-q', page));
  const send = /** @type {HTMLButtonElement} */ ($('.asst-send', page));
  const stopBtn = /** @type {HTMLButtonElement} */ ($('[data-stop]', page));
  /** The answer being read, if any: aborting it stops the browser's part (Stop, or leaving the page). */
  let reading = /** @type {{ ctrl: AbortController, bot: Extract<Entry, { who: 'bot' }> } | null} */ (null);
  let alive = true;

  const scrollDown = () => {
    log.scrollTop = log.scrollHeight;
  };

  function drawSuggestions() {
    const list = offer?.suggestions ?? [];
    sugg.hidden = entries.length > 0 || list.length === 0;
    sugg.innerHTML = '<p class="asst-hint">Ask about clients, tasks, messages, meetings or AI spend. It can point you to a screen, and draft a change that happens only when you press Confirm.</p>'
      + list.map((s) => `<button class="chip" type="button" data-ask="${esc(s)}">${esc(s)}</button>`).join('');
  }

  function drawAll() {
    col.innerHTML = entries.map(entryHtml).join('');
    drawSuggestions();
    scrollDown();
  }

  /** Redraws one entry in place. @param {number} i */
  function drawEntry(i) {
    const el = col.querySelector(`[data-entry="${i}"]`);
    const e = entries[i];
    if (!el || !e) return;
    el.outerHTML = entryHtml(e, i);
  }

  function setBusy(/** @type {boolean} */ on) {
    send.hidden = on;
    stopBtn.hidden = !on;
  }

  async function loadOffer() {
    if (offer) return;
    try {
      const r = await get('/assistant');
      offer = {
        suggestions: Array.isArray(r?.suggestions) ? r.suggestions.filter((/** @type {unknown} */ s) => typeof s === 'string').slice(0, 8) : [],
        questionMax: Number.isInteger(r?.questionMax) ? r.questionMax : 2000,
      };
    } catch {
      offer = { suggestions: [], questionMax: 2000 };
    }
    if (alive) {
      input.maxLength = offer.questionMax;
      drawSuggestions();
    }
  }

  /** @param {string} question */
  async function ask(question) {
    const q = question.trim();
    if (!q || reading) return;
    input.value = '';
    entries.push({ who: 'me', text: q });
    const bot = /** @type {Extract<Entry, { who: 'bot' }>} */ ({ who: 'bot', text: '', links: [], cards: [], meta: '', warn: false, running: true, step: '' });
    entries.push(bot);
    const at = entries.length - 1;
    drawAll();
    const ctrl = new AbortController();
    reading = { ctrl, bot };
    setBusy(true);
    const textEl = () => /** @type {HTMLElement | null} */ (col.querySelector(`[data-entry="${at}"] .asst-text`));
    try {
      await postLines('/assistant/ask', { question: q }, (e) => {
        if (!e || typeof e.type !== 'string') return;
        if (e.type === 'text' && typeof e.text === 'string') {
          bot.text += e.text;
          const t = alive ? textEl() : null;
          if (t) t.textContent = bot.text;
        } else if (e.type === 'tool' && typeof e.label === 'string') {
          bot.step = `${e.label}…`;
          const s = alive ? col.querySelector(`[data-entry="${at}"] .asst-step`) : null;
          if (s) s.setAttribute('data-label', bot.step);
        } else if (e.type === 'navigate' && typeof e.screen === 'string') {
          const search = typeof e.search === 'string' && SEARCH.test(e.search) ? e.search : '';
          bot.links.push({ screen: e.screen, search, label: String(e.label ?? e.screen).slice(0, 80) });
          if (alive) drawEntry(at);
        } else if (e.type === 'proposal' && e.card && typeof e.card.id === 'string') {
          const c = e.card;
          bot.cards.push({ id: c.id, title: String(c.title ?? ''), lines: Array.isArray(c.lines) ? c.lines.map(String) : [], expiresAt: String(c.expiresAt ?? ''), state: 'live' });
          if (alive) drawEntry(at);
        } else if (e.type === 'done') {
          bot.meta = `${typeof e.note === 'string' ? `${e.note} · ` : ''}${cost(Number(e.costUsd))}`;
        }
        if (alive) scrollDown();
      }, ctrl.signal);
    } catch (e) {
      if (ctrl.signal.aborted) bot.meta ||= 'Stopped.';
      else {
        bot.meta = e instanceof ApiError ? e.message : 'The assistant could not be reached. Try again.';
        bot.warn = true;
      }
    } finally {
      bot.running = false;
      if (reading?.ctrl === ctrl) reading = null;
      if (alive) {
        drawEntry(at);
        setBusy(false);
        scrollDown();
        input.focus();
      }
    }
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

  async function newChat() {
    if (reading) return;
    try {
      await post('/assistant/reset', {});
    } catch {
      // the agent forgets it within two hours anyway
    }
    entries = [];
    if (alive) {
      drawAll();
      input.focus();
    }
  }

  page.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (t.closest('[data-new]')) return void newChat();
    if (t.closest('[data-stop]')) return void reading?.ctrl.abort();
    const chip = /** @type {HTMLElement | null} */ (t.closest('[data-ask]'));
    if (chip) return void ask(chip.dataset.ask ?? '');
    const open = /** @type {HTMLElement | null} */ (t.closest('[data-open]'));
    if (open) {
      const [i, j] = (open.dataset.open ?? '').split(':').map(Number);
      const e = entries[i ?? -1];
      const l = e && e.who === 'bot' ? e.links[j ?? -1] : undefined;
      if (l) dispatchEvent(new CustomEvent(ASSISTANT_GO, { detail: { screen: l.screen, search: l.search } }));
      return;
    }
    const card = /** @type {HTMLElement | null} */ (t.closest('[data-card]'));
    if (card && t.closest('[data-confirm]')) return void decide(card.dataset.card ?? '', 'confirm');
    if (card && t.closest('[data-cancel]')) return void decide(card.dataset.card ?? '', 'cancel');
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

  drawAll();
  void loadOffer();
  input.focus();

  // Leaving the page: the stream's reading stops, so nothing keeps running behind the next screen. The answer is marked
  // now, so this page's copy never shows it still running.
  return () => {
    alive = false;
    if (reading) {
      reading.bot.running = false;
      reading.bot.meta ||= 'Stopped when you left the page.';
      reading.ctrl.abort();
      reading = null;
    }
  };
}
