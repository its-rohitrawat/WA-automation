// Automations (D5 Task 5): the morning briefing. The switch stays off until the spare phone is linked (Link phone opens
// the link dialog); switching on asks "Start sending to the founder?" and sends the confirmation the agent requires.
// The send time is a time field saved with its own button (the server checks it), with the next report under it.
// Days are a select. Change number takes the number twice; the page only ever shows it masked, and the typed number
// is cleared from the form at once. The preview uses today's real counts.
// The morning message (November release, change 5): the owner writes the whole text, with the placeholders the agent
// really fills (listed beside the editor with today's values; tapping one puts it in at the cursor). The preview fills
// them in as the owner types, the way the agent does; an unknown {word} is named and sent as written. Reset to default
// puts the default text back in the editor; Save sends it (the agent checks it again: text, up to the limit, no control
// characters but line breaks). Everything from the agent goes in through esc() or textContent.
import { get, post } from '../api.js';
import { $, esc, icon, toast } from '../dom.js';
import { CONNECTIONS_CHANGED } from './connect.js';
import { confirmDialog, errorText, failed, listen, loading, pill } from './ui.js';
import { numbersMatch } from './workLib.js';

/** @typedef {import('./registry.js').ScreenCtx} ScreenCtx */
/** @typedef {{ reportEnabled: boolean, reportDays: string, recipientMasked: string | null, sendAt: string, deadline: string, nextReport: string | null, source: Record<string, 'env' | 'dashboard'> }} Settings */

const STATE_PILL = { ok: 'p-done', warn: 'p-warn', down: 'p-overdue', off: 'p-muted' };

const DAYS = [['weekdays', 'Monday to Friday'], ['mon-sat', 'Monday to Saturday'], ['daily', 'Every day']];

/**
 * @typedef {{ key: string, hint: string, value: string }} Placeholder
 * @typedef {{ template: string, isDefault: boolean, defaultTemplate: string, maxChars: number, placeholders: Placeholder[], trackerLinked: boolean }} MessageEditor
 * @typedef {{ editor: MessageEditor, draft: string, problem: string | null }} MessageState
 */

const str = (/** @type {unknown} */ v) => (typeof v === 'string' ? v : '');

/** GET /settings/report-message, read defensively; null when the answer is not the editor's (an older agent). @param {unknown} raw @returns {MessageEditor | null} */
export function readMessageEditor(raw) {
  const r = /** @type {Record<string, unknown>} */ (raw && typeof raw === 'object' ? raw : {});
  const template = str(r.template);
  const defaultTemplate = str(r.defaultTemplate);
  const maxChars = typeof r.maxChars === 'number' && Number.isInteger(r.maxChars) && r.maxChars > 0 ? r.maxChars : 0;
  if (!template || !defaultTemplate || !maxChars || !Array.isArray(r.placeholders)) return null;
  const placeholders = r.placeholders.flatMap((x) => {
    const o = /** @type {Record<string, unknown>} */ (x && typeof x === 'object' ? x : {});
    return /^[a-z_]{1,30}$/.test(str(o.key)) ? [{ key: str(o.key), hint: str(o.hint), value: str(o.value) }] : [];
  });
  return { template, isDefault: r.isDefault === true, defaultTemplate, maxChars, placeholders, trackerLinked: r.trackerLinked === true };
}

/**
 * The text with each placeholder filled in, as the agent fills it (fillMessage in src/report/morningReport.ts): one pass,
 * a value never read again, anything else as written.
 * @param {string} template @param {Placeholder[]} placeholders
 */
export function fillPreview(template, placeholders) {
  const values = new Map(placeholders.map((p) => [p.key, p.value]));
  return template.replace(/\{([a-z_]+)\}/g, (whole, key) => values.get(key) ?? whole);
}

/** The {words} in the text that are not placeholders (each once, in order): the agent sends them as written. @param {string} template @param {Placeholder[]} placeholders */
export function unknownPlaceholders(template, placeholders) {
  const known = new Set(placeholders.map((p) => p.key));
  /** @type {string[]} */
  const out = [];
  for (const m of template.matchAll(/\{([^{}\n]{1,40})\}/g)) if (!known.has(m[1] ?? '') && !out.includes(m[0])) out.push(m[0]);
  return out;
}

/** Characters as the agent counts them (an emoji counts once). @param {string} text */
export const charCount = (text) => Array.from(text).length;

/** @param {string[]} unknown */
const unknownText = (unknown) => (unknown.length ? `Not a placeholder, so sent as written: ${unknown.join(', ')}` : '');

/** What the editor says under its buttons, whether Save and Reset can be used, and the unknown placeholders. @param {MessageState} m */
function messageStatus(m) {
  const e = m.editor;
  const n = charCount(m.draft);
  const dirty = m.draft !== e.template;
  return {
    n, over: n > e.maxChars, unknown: unknownPlaceholders(m.draft, e.placeholders),
    canSave: dirty && n <= e.maxChars && m.draft.trim() !== '', canReset: m.draft !== e.defaultTemplate,
    state: dirty ? 'Not saved yet' : e.isDefault ? 'The default text is in use' : 'Your text is in use',
  };
}

/** The Morning message card: the editor, the placeholders beside it, Save and Reset to default. @param {MessageState} m */
function messageCard(m) {
  const e = m.editor;
  const st = messageStatus(m);
  const places = e.placeholders.map((p) => `<li><button class="mm-ph" type="button" data-ph="${esc(p.key)}" aria-label="${esc(`Put in {${p.key}}: ${p.hint}`)}">{${esc(p.key)}}</button>
      <span class="mm-ph-text"><span>${esc(p.hint)}</span><b data-tip="${esc(p.value)}">${esc(p.value)}</b></span></li>`).join('');
  return `<section class="card col-7 mm-card" id="mm-card"><div class="card-head"><h3>Morning message</h3>${pill(e.isDefault ? { cls: 'p-muted', label: 'Default text' } : { cls: 'p-done', label: 'Your text' })}</div>
    <p class="muted-p mm-intro">Write the whole message. Each placeholder in curly brackets is filled in with that day's numbers when the briefing is sent; everything else goes as you write it.</p>
    <div class="mm-body"><div class="mm-edit">
        <label class="sr-only" for="mm-text">Morning message text</label>
        <textarea id="mm-text" class="mm-text" rows="6" maxlength="${e.maxChars}" spellcheck="true" aria-describedby="mm-count mm-unknown">${esc(m.draft)}</textarea>
        <div class="mm-meta"><span class="mm-count${st.over ? ' is-over' : ''}" id="mm-count">${esc(`${st.n} / ${e.maxChars}`)}</span></div>
        <p class="mm-unknown" id="mm-unknown"${st.unknown.length ? '' : ' hidden'}>${esc(unknownText(st.unknown))}</p></div>
      <div class="mm-places"><div class="h4">Placeholders · today</div><ul aria-label="Placeholders">${places}</ul></div></div>
    ${e.trackerLinked ? '' : `<div class="note">${icon('info', 16)}<span>The tracker is not on Google Drive yet: the briefing waits until it is. The preview shows a stand-in for the link.</span></div>`}
    <p class="field-err mm-err" id="mm-err" role="alert"${m.problem ? '' : ' hidden'}>${esc(m.problem ?? '')}</p>
    <div class="row-gap row-top"><button class="btn btn-primary btn-sm" type="button" data-mm-save${st.canSave ? '' : ' disabled'}>Save message</button>
      <button class="btn btn-ghost btn-sm" type="button" data-mm-reset${st.canReset ? '' : ' disabled'}>Reset to default</button>
      <small class="faint" id="mm-state" aria-live="polite">${esc(st.state)}</small></div></section>`;
}

/**
 * @param {{ settings: Settings, spare: { state: string, label: string }, report: { state: string, label: string } | null, counts: { open: number, overdue: number } | null,
 *   message: MessageState | null }} d
 * @param {string} [problem]
 */
function render(d, problem = '') {
  const s = d.settings;
  const linked = d.spare.state === 'ok';
  // Never linked: the first-link dialog. A link that is gone (logged out, refused, unreadable): the relink, which asks first.
  const firstLink = d.spare.label === 'Not linked' || d.spare.state === 'off';
  const dayWords = DAYS.find(([k]) => k === s.reportDays)?.[1] ?? s.reportDays;
  const preview = d.message
    ? fillPreview(d.message.draft, d.message.editor.placeholders)
    : d.counts
      ? `Good morning. ${d.counts.open} open task${d.counts.open === 1 ? '' : 's'}, ${d.counts.overdue} overdue. Today's tracker: drive.google.com/…`
      : "Good morning. The open and overdue count, and today's tracker link.";
  const messageLine = d.message
    ? (d.message.editor.isDefault ? 'The default text, shown below' : 'Your own text, shown below')
    : 'One short text with the open and overdue count and the tracker link';
  return `<div class="grid auto-grid"><section class="card col-7"><div class="card-head"><h3>Morning briefing</h3>${s.reportEnabled ? pill({ cls: /** @type {Record<string, string>} */ (STATE_PILL)[d.report?.state ?? 'ok'] ?? 'p-done', label: d.report?.label && d.report.label !== 'Off' ? `On · ${d.report.label}` : 'On' }) : pill({ cls: 'p-warn', label: 'Off' })}</div>
    <div class="brief-toggle"><div><b>Send the morning briefing</b><small>${!linked ? 'Link the spare phone first.' : !s.recipientMasked ? "Set the founder's number first (Change number)." : esc(`One message to the founder, ${dayWords.toLowerCase()}.`)}</small></div>
      <button class="switch" type="button" role="switch" data-brief aria-checked="${String(Boolean(s.reportEnabled))}" aria-label="Send the morning briefing"${s.reportEnabled || (linked && s.recipientMasked) ? '' : ' disabled'}></button></div>
    <dl class="kv kv-top"><dt>Sends at</dt><dd><form class="row-gap" data-timeform method="post" novalidate><input class="sel time-in" type="time" name="t" step="60" required value="${esc(s.sendAt)}" aria-label="Briefing send time, IST">
        <span>IST</span><button class="btn btn-ghost btn-sm" type="submit">Save time</button></form>
        <small class="faint">${esc(`Catches up until ${s.deadline}`)}${s.source.reportTime === 'env' ? " · from the Mac's settings" : ''}</small></dd>
      <dt>Next report</dt><dd data-next>${esc(s.nextReport ?? 'none while the briefing is off')}</dd><dt>Days</dt><dd><select class="sel" data-days aria-label="Briefing days">${DAYS.map(([k, l]) => `<option value="${k}"${s.reportDays === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>
        ${s.source.reportDays === 'env' ? '<small class="faint"> · from the Mac\'s settings</small>' : ''}</dd>
      <dt>Time zone</dt><dd>Asia/Kolkata</dd>
      <dt>To</dt><dd>Founder's WhatsApp · ${esc(s.recipientMasked ?? 'not set')} <button class="link" type="button" data-number>Change number</button></dd>
      <dt>From</dt><dd>Spare WhatsApp · ${pill(linked ? { cls: 'p-done', label: 'Linked' } : { cls: 'p-warn', label: d.spare.label || 'Not linked' })}</dd>
      <dt>Message</dt><dd>${esc(messageLine)}</dd></dl>
    <form class="edit-form" data-numform method="post" hidden novalidate><label><span>New number</span><input name="n1" inputmode="tel" autocomplete="off" maxlength="20" placeholder="91 98765 43210"></label>
      <label><span>Type it again</span><input name="n2" inputmode="tel" autocomplete="off" maxlength="20"></label>${problem ? `<p class="field-err" role="alert">${esc(problem)}</p>` : ''}
      <div class="row-gap"><button class="btn btn-primary btn-sm" type="submit">Save number</button><button class="btn btn-ghost btn-sm" type="button" data-numcancel>Cancel</button></div></form>
    ${linked ? '' : `<div class="note note-row">${icon('phone', 16)}<span class="grow-1">The briefing is sent from the spare phone, so link it before switching this on.</span><button class="btn btn-primary btn-sm" type="button" data-fix="${firstLink ? 'spare-link' : 'spare'}">${icon('phone', 15)}Link phone</button></div>`}
    <div class="note">${icon('info', 16)}<span>Switching this on starts real messages to the founder's number. Every change is recorded in Audit logs.</span></div></section>
  ${d.message ? messageCard(d.message) : ''}
  <section class="card col-5 auto-preview"><div class="card-head"><h3>Preview</h3><span class="eyebrow">Today's numbers</span></div>
    <div class="phone"><div class="bar"><i></i><div><b>WA Agent</b><div class="phone-sub">spare number</div></div></div><div class="chat"><div class="msg"><span class="mm-preview" id="mm-preview">${esc(preview)}</span><small>${esc(s.sendAt)}</small></div></div></div></section></div>`;
}

/** The briefing's line from the shell's status reading (its part's title is label, its state in words is detail). @param {ScreenCtx} ctx */
function reportPart(ctx) {
  const p = ctx.status()?.parts?.find((x) => x.key === 'report');
  return p ? { state: p.state, label: p.detail } : null;
}

/** @param {ScreenCtx} ctx */
export function mountAutomations(ctx) {
  /** @type {Parameters<typeof render>[0] | null} */
  let d = null;
  let busy = false;

  async function load() {
    try {
      const [settings, conn, ov, editorRaw] = await Promise.all([
        get('/settings'), get('/connections'), get('/overview').catch(() => null), get('/settings/report-message').catch(() => null),
      ]);
      if (!ctx.live()) return;
      const report = reportPart(ctx);
      const t = ov?.tasks;
      const editor = readMessageEditor(editorRaw);
      // A text being written survives a reload (a phone linked from the dialog loads the screen again).
      const was = d?.message;
      const message = editor ? { editor, draft: was && was.draft !== was.editor.template ? was.draft : editor.template, problem: null } : null;
      d = { settings, spare: conn.spare, report, counts: t ? { open: t.open + t.overdue + t.review, overdue: t.overdue } : null, message };
      ctx.redraw(render(d));
    } catch (e) {
      if (ctx.live() && !d) ctx.redraw(failed(e));
    }
  }

  /** @param {Record<string, unknown>} body */
  async function save(body) {
    if (busy || !d) return false;
    busy = true;
    try {
      d.settings = await post('/settings', body);
      if (ctx.live()) ctx.redraw(render(d));
      return true;
    } catch (e) {
      toast(errorText(e));
      return false;
    } finally {
      busy = false;
    }
  }

  ctx.redraw(loading('Loading the briefing settings…'));
  void load();
  /** A number being typed, a time changed and not saved yet, or the message being written: a redraw would lose it or the cursor. */
  const editing = () => {
    const time = /** @type {HTMLInputElement | null} */ ($('[data-timeform] input', ctx.view));
    const text = $('#mm-text', ctx.view);
    return Boolean($('[data-numform]:not([hidden])', ctx.view)) || (time !== null && (document.activeElement === time || time.value !== d?.settings.sendAt))
      || (text !== null && document.activeElement === text);
  };

  /** After the text changed: the preview, the count, the unknown placeholders, the buttons and the state, without a redraw. */
  const messageChanged = () => {
    const m = d?.message;
    if (!m) return;
    const st = messageStatus(m);
    const preview = $('#mm-preview', ctx.view);
    if (preview) preview.textContent = fillPreview(m.draft, m.editor.placeholders);
    const count = $('#mm-count', ctx.view);
    if (count) {
      count.textContent = `${st.n} / ${m.editor.maxChars}`;
      count.classList.toggle('is-over', st.over);
    }
    const unknown = $('#mm-unknown', ctx.view);
    if (unknown) {
      unknown.textContent = unknownText(st.unknown);
      unknown.hidden = st.unknown.length === 0;
    }
    const save = /** @type {HTMLButtonElement | null} */ ($('[data-mm-save]', ctx.view));
    if (save) save.disabled = !st.canSave || busy;
    const reset = /** @type {HTMLButtonElement | null} */ ($('[data-mm-reset]', ctx.view));
    if (reset) reset.disabled = !st.canReset;
    const state = $('#mm-state', ctx.view);
    if (state) state.textContent = st.state;
  };
  /** Shows (or hides, with '') the reason the message was not saved. @param {string} text */
  const showMessageProblem = (text) => {
    if (d?.message) d.message.problem = text || null;
    const el = $('#mm-err', ctx.view);
    if (!el) return;
    el.textContent = text;
    el.hidden = !text;
  };
  /** Saves the message text (the default text resets it), and draws the screen with what the agent kept. */
  const saveMessage = async () => {
    const m = d?.message;
    if (!m || busy || !messageStatus(m).canSave) return;
    busy = true;
    messageChanged();
    try {
      const v = await post('/settings', { key: 'reportMessage', value: m.draft });
      if (!ctx.live() || !d) return;
      d.settings = v;
      const saved = typeof v?.reportMessage === 'string' ? v.reportMessage : null;
      m.editor = { ...m.editor, template: saved ?? m.editor.defaultTemplate, isDefault: saved === null };
      m.draft = m.editor.template;
      m.problem = null;
      ctx.redraw(render(d));
      toast(saved === null ? 'The morning message is back to the default text.' : 'Morning message saved. The next briefing uses it.');
    } catch (err) {
      showMessageProblem(errorText(err));
    } finally {
      busy = false;
      if (ctx.live()) messageChanged();
    }
  };
  // Redraw only when the briefing's own line changed: a redraw on every status refresh would close an open select. The
  // settings are read again then, so the next report moves on once today's has gone.
  ctx.onStatus(() => {
    if (!d) return;
    const next = reportPart(ctx);
    if (JSON.stringify(next) === JSON.stringify(d.report)) return;
    d.report = next;
    void get('/settings')
      .then((/** @type {Settings} */ s) => {
        if (d) d.settings = s;
      })
      .catch(() => undefined)
      .finally(() => {
        if (d && ctx.live() && !editing()) ctx.redraw(render(d));
      });
  });

  // A phone linked from the dialog (Link phone): load again, so the switch unlocks.
  const onLinked = () => void load();
  addEventListener(CONNECTIONS_CHANGED, onLinked);
  const stopListening = listen(ctx.view, {
    input: (e) => {
      const el = /** @type {HTMLTextAreaElement} */ (e.target);
      if (el.id !== 'mm-text' || !d?.message) return;
      d.message.draft = el.value;
      if (d.message.problem) showMessageProblem('');
      messageChanged();
    },
    click: async (e) => {
      const t = /** @type {Element} */ (e.target);
      if (t.closest('[data-retry]')) return void load();
      if (!d) return;
      const ph = /** @type {HTMLElement | null} */ (t.closest('[data-ph]'));
      const box = /** @type {HTMLTextAreaElement | null} */ ($('#mm-text', ctx.view));
      if (ph && box && d.message) {
        // The placeholder goes in at the cursor (or over the selection), within the limit.
        const add = `{${ph.dataset.ph ?? ''}}`;
        const start = box.selectionStart ?? box.value.length;
        const end = box.selectionEnd ?? start;
        if (charCount(box.value) - charCount(box.value.slice(start, end)) + charCount(add) > d.message.editor.maxChars) {
          toast('The message is at its length limit.', false);
          return;
        }
        box.setRangeText(add, start, end, 'end');
        box.focus();
        d.message.draft = box.value;
        messageChanged();
        return;
      }
      if (t.closest('[data-mm-reset]') && box && d.message) {
        box.value = d.message.editor.defaultTemplate;
        d.message.draft = box.value;
        showMessageProblem('');
        messageChanged();
        box.focus();
        return;
      }
      if (t.closest('[data-mm-save]')) return void saveMessage();
      if (t.closest('[data-brief]')) {
        if (d.settings.reportEnabled) {
          if (await save({ key: 'reportEnabled', value: false })) toast('Morning briefing switched off.');
          return;
        }
        const ok = await confirmDialog({
          eyebrow: 'Morning briefing', title: 'Start sending to the founder?', yes: 'Turn on',
          text: `The spare phone will send one WhatsApp message to ${d.settings.recipientMasked ?? 'the founder'} each briefing day: ${d.message ? "the morning message on this screen, with that day's numbers" : 'the open and overdue count and the tracker link'}.`,
        });
        if (ok && (await save({ key: 'reportEnabled', value: true, confirm: true }))) toast('Morning briefing is on.');
        return;
      }
      const form = /** @type {HTMLFormElement | null} */ ($('[data-numform]', ctx.view));
      if (t.closest('[data-number]') && form) {
        form.hidden = false;
        /** @type {HTMLInputElement} */ (form.elements.namedItem('n1')).focus();
        return;
      }
      if (t.closest('[data-numcancel]') && form) {
        form.reset();
        form.hidden = true;
      }
    },
    change: async (e) => {
      const el = /** @type {HTMLSelectElement} */ (e.target);
      if (!el.matches('[data-days]')) return;
      if (await save({ key: 'reportDays', value: el.value })) toast('Briefing days saved.');
    },
    submit: async (e) => {
      e.preventDefault();
      const form = /** @type {HTMLFormElement} */ (e.target);
      if (form.matches('[data-timeform]')) {
        const value = /** @type {HTMLInputElement} */ (form.elements.namedItem('t')).value;
        if (!/^\d{2}:\d{2}$/.test(value)) return void toast('Pick a time, for example 07:30.');
        if (value === d?.settings.sendAt) return;
        if (await save({ key: 'reportTime', value }) && d) toast(`Briefing time saved. Next report: ${d.settings.nextReport ?? 'none while the briefing is off'}.`);
        return;
      }
      const a = /** @type {HTMLInputElement} */ (form.elements.namedItem('n1')).value;
      const b = /** @type {HTMLInputElement} */ (form.elements.namedItem('n2')).value;
      // The typed number leaves the page's form at once, whatever happens next.
      form.reset();
      if (!numbersMatch(a, b)) {
        if (d) ctx.redraw(render(d, 'The two numbers must be the same Indian mobile number, with 91 in front.'));
        const again = /** @type {HTMLFormElement | null} */ ($('[data-numform]', ctx.view));
        if (again) again.hidden = false;
        return;
      }
      if (await save({ key: 'reportRecipient', value: a, confirm: b })) toast('Number saved.');
    },
  });
  return () => {
    removeEventListener(CONNECTIONS_CHANGED, onLinked);
    stopListening();
  };
}
