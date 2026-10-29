// The AI assistant (owner request, 29 Oct 2026): a button at the bottom right of every screen opens a chat panel, a
// slide-over on laptops and the whole screen on phones. Answers stream in as plain text (escaped; **bold** is the only
// mark kept). The agent may open a screen (ASSISTANT_GO, handled by the shell) or show a card with a drafted change:
// only the owner's Confirm here runs it, on the agent, with this session's CSRF token. Nothing of the chat is stored in
// the browser; signing out removes the panel and the agent forgets the chat.
import { ApiError, get, post, postLines } from '../api.js';
import { $, esc, icon, reduceMotion } from '../dom.js';

/** The shell opens this screen and filter: detail { screen, search }. */
export const ASSISTANT_GO = 'wa:assistant-go';
/** A confirmed change: the shell redraws the screen on show. */
export const ASSISTANT_CHANGED = 'wa:assistant-changed';

const PHONE = '(max-width: 640px)';

if (!document.querySelector('link[data-assistant-css]')) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/dashboard/static/assistant.css';
  link.dataset.assistantCss = '';
  document.head.append(link);
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

/** @type {{ unmount: () => void } | null} */
let mounted = null;

/** Adds the button and the panel (after sign-in). */
export function mountAssistant() {
  if (mounted) return;
  const fab = document.createElement('button');
  fab.className = 'asst-fab';
  fab.id = 'asst-fab';
  fab.type = 'button';
  fab.setAttribute('aria-controls', 'asst');
  fab.setAttribute('aria-expanded', 'false');
  fab.innerHTML = `${icon('spark', 18)}<span>Ask</span>`;
  fab.setAttribute('aria-label', 'Open the assistant');
  const panel = document.createElement('section');
  panel.className = 'asst';
  panel.id = 'asst';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-labelledby', 'asst-title');
  panel.innerHTML = `<header class="asst-head"><div><div class="eyebrow">AI assistant</div><h2 id="asst-title">Ask about your work</h2></div>
      <div class="asst-tools"><button class="btn btn-ghost btn-sm" type="button" data-new>New chat</button>
        <button class="icon-btn" type="button" data-close aria-label="Close the assistant">${icon('close', 16)}</button></div></header>
    <div class="asst-log" data-log role="log" aria-live="polite" tabindex="0" aria-label="Conversation"></div>
    <div class="asst-sugg" data-sugg></div>
    <form class="asst-form" data-form novalidate><label class="sr-only" for="asst-q">Your question</label>
      <textarea id="asst-q" rows="2" maxlength="2000" placeholder="Ask about clients, tasks, meetings…" autocomplete="off"></textarea>
      <button class="btn btn-primary asst-send" type="submit" aria-label="Send">${icon('arrowR', 18)}</button></form>
    <p class="asst-foot">Answers use Claude and count toward the daily AI cap. Changes need your Confirm.</p>`;
  document.body.append(fab, panel);
  document.body.classList.add('has-asst');

  const log = /** @type {HTMLElement} */ ($('[data-log]', panel));
  const sugg = /** @type {HTMLElement} */ ($('[data-sugg]', panel));
  const form = /** @type {HTMLFormElement} */ ($('[data-form]', panel));
  const input = /** @type {HTMLTextAreaElement} */ ($('#asst-q', panel));
  const send = /** @type {HTMLButtonElement} */ ($('.asst-send', panel));
  let busy = false;
  let alive = true;
  /** @type {string[]} */
  let suggestions = [];

  const isPhone = () => matchMedia(PHONE).matches;
  const scrollDown = () => {
    log.scrollTop = log.scrollHeight;
  };

  function drawSuggestions() {
    sugg.hidden = log.childElementCount > 0 || suggestions.length === 0;
    sugg.innerHTML = '<p class="asst-hint">Ask about clients, tasks, messages, meetings or AI spend. It can open a screen for you, and draft a change that happens only when you press Confirm.</p>'
      + suggestions.map((s) => `<button class="chip" type="button" data-ask="${esc(s)}">${esc(s)}</button>`).join('');
  }

  async function loadSuggestions() {
    try {
      const r = await get('/assistant');
      suggestions = Array.isArray(r?.suggestions) ? r.suggestions.filter((/** @type {unknown} */ s) => typeof s === 'string').slice(0, 8) : [];
      input.maxLength = Number.isInteger(r?.questionMax) ? r.questionMax : 2000;
    } catch {
      suggestions = [];
    }
    if (alive) drawSuggestions();
  }

  function open() {
    if (!panel.hidden) return;
    panel.hidden = false;
    fab.setAttribute('aria-expanded', 'true');
    document.body.classList.toggle('asst-full', isPhone());
    requestAnimationFrame(() => panel.classList.add('in'));
    if (suggestions.length === 0) void loadSuggestions();
    input.focus();
  }

  function close() {
    if (panel.hidden) return;
    panel.classList.remove('in');
    document.body.classList.remove('asst-full');
    fab.setAttribute('aria-expanded', 'false');
    const done = () => {
      if (!panel.classList.contains('in')) panel.hidden = true;
    };
    if (reduceMotion) done();
    else setTimeout(done, 220);
    fab.focus();
  }

  /** One message in the log. @param {'me' | 'bot'} who @param {string} html */
  function bubble(who, html) {
    const el = document.createElement('div');
    el.className = `asst-msg ${who}`;
    el.innerHTML = html;
    log.append(el);
    drawSuggestions();
    scrollDown();
    return el;
  }

  /** @param {{ id: string, title: string, lines: string[], expiresAt: string }} c */
  function card(c) {
    const el = document.createElement('div');
    el.className = 'asst-card';
    el.dataset.card = c.id;
    el.innerHTML = `<b>${esc(c.title)}</b><ul>${c.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
      <div class="asst-card-acts"><button class="btn btn-primary btn-sm" type="button" data-confirm>Confirm</button>
        <button class="btn btn-ghost btn-sm" type="button" data-cancel>Cancel</button><small>Waits until ${esc(hhmm(c.expiresAt))}</small></div>`;
    return el;
  }

  /** @param {string} question */
  async function ask(question) {
    const q = question.trim();
    if (!q || busy) return;
    busy = true;
    send.disabled = true;
    input.value = '';
    bubble('me', esc(q));
    const bot = bubble('bot', '<div class="asst-text"></div><div class="asst-step" aria-hidden="true"><i></i><i></i><i></i></div>');
    const text = /** @type {HTMLElement} */ ($('.asst-text', bot));
    const step = /** @type {HTMLElement} */ ($('.asst-step', bot));
    let answer = '';
    try {
      await postLines('/assistant/ask', { question: q }, (e) => {
        if (!alive || !e || typeof e.type !== 'string') return;
        if (e.type === 'text' && typeof e.text === 'string') {
          answer += e.text;
          text.textContent = answer;
        } else if (e.type === 'tool' && typeof e.label === 'string') {
          step.dataset.label = `${e.label}…`;
        } else if (e.type === 'navigate' && typeof e.screen === 'string') {
          const search = typeof e.search === 'string' && /^(\?[\w=&%+.,-]*)?$/.test(e.search) ? e.search : '';
          dispatchEvent(new CustomEvent(ASSISTANT_GO, { detail: { screen: e.screen, search } }));
          const note = document.createElement('div');
          note.className = 'asst-note';
          note.innerHTML = `${icon('arrowR', 14)}<span>Opened ${esc(String(e.label ?? e.screen))}</span>${isPhone() ? '<button class="link" type="button" data-show>Show</button>' : ''}`;
          bot.insertBefore(note, step);
        } else if (e.type === 'proposal' && e.card && typeof e.card.id === 'string') {
          bot.insertBefore(card(e.card), step);
        } else if (e.type === 'done') {
          const meta = document.createElement('small');
          meta.className = 'asst-meta';
          meta.textContent = `${typeof e.note === 'string' ? `${e.note} · ` : ''}${cost(Number(e.costUsd))}`;
          bot.append(meta);
        }
        scrollDown();
      });
    } catch (e) {
      const meta = document.createElement('small');
      meta.className = 'asst-meta warn';
      meta.textContent = e instanceof ApiError ? e.message : 'The assistant could not be reached. Try again.';
      bot.append(meta);
    } finally {
      step.remove();
      text.innerHTML = rich(answer.trim());
      if (!answer.trim()) text.remove();
      busy = false;
      send.disabled = false;
      scrollDown();
      if (alive && !panel.hidden) input.focus();
    }
  }

  /** @param {HTMLElement} el @param {'confirm' | 'cancel'} what */
  async function decide(el, what) {
    const id = el.dataset.card ?? '';
    const acts = /** @type {HTMLElement} */ ($('.asst-card-acts', el));
    for (const b of acts.querySelectorAll('button')) b.disabled = true;
    try {
      if (what === 'cancel') {
        await post('/assistant/cancel', { id });
        acts.innerHTML = '<small>Cancelled. Nothing changed.</small>';
        return;
      }
      const r = await post('/assistant/confirm', { id });
      acts.innerHTML = `<small class="ok">${icon('check', 14)} ${esc(typeof r?.message === 'string' ? r.message : 'Done.')}</small>`;
      dispatchEvent(new CustomEvent(ASSISTANT_CHANGED));
    } catch (e) {
      acts.innerHTML = `<small class="warn">${esc(e instanceof ApiError ? e.message : 'That did not work. Try again.')}</small>`;
    }
  }

  async function newChat() {
    if (busy) return;
    try {
      await post('/assistant/reset', {});
    } catch {
      // the agent forgets it within two hours anyway
    }
    log.replaceChildren();
    drawSuggestions();
    input.focus();
  }

  const onClick = (/** @type {MouseEvent} */ e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (t.closest('#asst-fab')) return void (panel.hidden ? open() : close());
    if (!panel.contains(t)) return;
    if (t.closest('[data-close]') || t.closest('[data-show]')) return void close();
    if (t.closest('[data-new]')) return void newChat();
    const chip = /** @type {HTMLElement | null} */ (t.closest('[data-ask]'));
    if (chip) return void ask(chip.dataset.ask ?? '');
    const c = /** @type {HTMLElement | null} */ (t.closest('[data-card]'));
    if (c && t.closest('[data-confirm]')) return void decide(c, 'confirm');
    if (c && t.closest('[data-cancel]')) return void decide(c, 'cancel');
  };
  const onKey = (/** @type {KeyboardEvent} */ e) => {
    if (e.key === 'Escape' && !panel.hidden && panel.contains(/** @type {Node} */ (document.activeElement))) {
      e.stopPropagation();
      close();
    }
  };
  const onSubmit = (/** @type {SubmitEvent} */ e) => {
    e.preventDefault();
    void ask(input.value);
  };
  const onEnter = (/** @type {KeyboardEvent} */ e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void ask(input.value);
    }
  };
  document.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey, true);
  form.addEventListener('submit', onSubmit);
  input.addEventListener('keydown', onEnter);

  mounted = {
    unmount() {
      alive = false;
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey, true);
      document.body.classList.remove('has-asst', 'asst-full');
      fab.remove();
      panel.remove();
    },
  };
}

/** Removes the button, the panel and everything in it (sign-out). */
export function unmountAssistant() {
  mounted?.unmount();
  mounted = null;
}
