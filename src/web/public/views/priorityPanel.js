// The Settings screen's "Priority & sentiment" section (29 Oct 2026): four keyword lists edited as chips, saved
// together, and the sentiment switch, saved at once. The owner's keywords go through esc() like every other value.
// The keyword box (November release, change 6) is shared with the Groups drawer's meeting keywords: an input with an
// Add button (Enter adds too), the keywords as chips below it, each with a remove button. Pasting "a, b" adds both.
import { esc, icon } from '../dom.js';
import { pill } from './ui.js';
import { priorityPill, TASK_PRIORITIES } from './workLib.js';

/**
 * @typedef {{ critical: string[], major: string[], medium: string[], low: string[] }} Keywords
 * @typedef {{ keywords: Keywords, sentimentEnabled: boolean, source: { priorityKeywords: string, sentimentEnabled: string },
 *   limits: { perLevel: number, maxChars: number } }} PriorityView
 */

/** @type {Record<string, string>} */
const HINTS = {
  critical: 'Something is broken or blocked, or the client says it is urgent.',
  major: 'Important or needed soon.',
  medium: 'Normal work. Usually left empty: the agent decides.',
  low: 'Nice to have, no rush.',
};

/** "a, b" → ['a', 'b']: split at commas, spaces collapsed, trimmed, empty parts dropped. @param {string} text */
export const splitKeywords = (text) => text.split(',').map((raw) => raw.normalize('NFC').replace(/\s+/g, ' ').trim()).filter(Boolean);

/**
 * Adds each keyword typed (split at commas) to a list, skipping one already in it in any case. Stops at the first one
 * refused and returns why ('' when every one went in or was already there); the ones before it stay added.
 * full: what to say when the list already has max keywords. check: a keyword's problem, or ''.
 * @param {string[]} list @param {string} typed @param {{ max: number, full: string, check?: (k: string) => string }} o
 */
export function addWords(list, typed, o) {
  for (const k of splitKeywords(typed)) {
    const key = k.toLocaleLowerCase('en');
    if (list.some((x) => x.toLocaleLowerCase('en') === key)) continue;
    const bad = o.check?.(k) ?? '';
    if (bad) return bad;
    if (list.length >= o.max) return o.full;
    list.push(k);
  }
  return '';
}

/**
 * The box a keyword is typed in, with its Add button. input and button: their attributes (fixed markup from the screen,
 * never the owner's text). label: the input's accessible name, left out when a <label for> names it.
 * @param {{ input: string, button: string, value: string, maxlength: number, label?: string, buttonLabel: string, placeholder: string }} o
 */
export function keywordAdder(o) {
  return `<div class="kw-add"><input class="kw-input" type="text" ${o.input} value="${esc(o.value)}" maxlength="${Number(o.maxlength) || 200}" placeholder="${esc(o.placeholder)}"${o.label ? ` aria-label="${esc(o.label)}"` : ''} autocomplete="off" enterkeyhint="done">`
    + `<button class="btn btn-ghost btn-sm" type="button" ${o.button} aria-label="${esc(o.buttonLabel)}">Add</button></div>`;
}

/**
 * The keywords as chips, each with its remove button (removeAttrs(i): that button's attributes, fixed markup).
 * @param {string[]} list @param {(i: number) => string} removeAttrs @param {{ empty: string, label: string }} o
 */
export function keywordChips(list, removeAttrs, o) {
  const chips = list.map((k, i) => `<li class="kw-chip"><span>${esc(k)}</span><button type="button" ${removeAttrs(i)} aria-label="${esc(`Remove ${k}`)}">${icon('close', 12)}</button></li>`).join('');
  return `<ul class="kw-chips" aria-label="${esc(o.label)}">${chips || `<li class="kw-none faint">${esc(o.empty)}</li>`}</ul>`;
}

/** A copy of the lists to edit. @param {Keywords} k @returns {Keywords} */
export const draftOf = (k) => ({ critical: [...k.critical], major: [...k.major], medium: [...k.medium], low: [...k.low] });

/** The same lists, chip for chip. @param {Keywords} a @param {Keywords} b */
export const sameKeywords = (a, b) => TASK_PRIORITIES.every((l) => JSON.stringify(a[/** @type {keyof Keywords} */ (l)]) === JSON.stringify(b[/** @type {keyof Keywords} */ (l)]));

/**
 * Adds what was typed to a level's draft: split at commas, trimmed, single-spaced, without repeats (any case). Returns
 * a problem to show, or null. The agent checks again on save.
 * @param {Keywords} draft @param {string} level @param {string} typed @param {{ perLevel: number, maxChars: number }} limits
 */
export function addTyped(draft, level, typed, limits) {
  const list = draft[/** @type {keyof Keywords} */ (level)];
  for (const k of splitKeywords(typed)) {
    if (Array.from(k).length > limits.maxChars) return `A keyword can be at most ${limits.maxChars} characters.`;
    const key = k.toLocaleLowerCase('en');
    const other = TASK_PRIORITIES.find((l) => draft[/** @type {keyof Keywords} */ (l)].some((x) => x.toLocaleLowerCase('en') === key));
    if (other === level) continue;
    if (other) return `That keyword is already in ${priorityPill(other).label}: keep each keyword in one list.`;
    if (list.length >= limits.perLevel) return `${priorityPill(level).label} can have at most ${limits.perLevel} keywords.`;
    list.push(k);
  }
  return null;
}

/**
 * The section. dirty: the lists differ from what is saved. problem: a refusal to show under the lists.
 * typed: what is still in each level's box.
 * @param {PriorityView} p @param {Keywords} draft @param {{ dirty: boolean, problem: string | null, typed?: Record<string, string> }} o
 */
export function renderPriority(p, draft, o) {
  const levels = TASK_PRIORITIES.map((l) => {
    const list = draft[/** @type {keyof Keywords} */ (l)];
    const name = priorityPill(l).label;
    const adder = keywordAdder({
      input: `data-kw-input="${esc(l)}"`, button: `data-kw-add="${esc(l)}"`, value: o.typed?.[l] ?? '', maxlength: p.limits.maxChars * 4,
      label: `New ${name} keyword`, buttonLabel: `Add ${name} keyword`, placeholder: 'Add a keyword',
    });
    const chips = keywordChips(list, (i) => `data-kw-remove="${esc(l)}" data-i="${i}"`, { empty: 'No keywords yet', label: `${name} keywords` });
    return `<div class="kw-level"><div class="kw-head">${pill(priorityPill(l))}<small>${esc(HINTS[l] ?? '')}</small></div>${adder}${chips}</div>`;
  }).join('');
  const on = p.sentimentEnabled;
  // Text still in a box counts as a change: Save adds it first, so nothing typed is lost.
  const typedAny = Object.values(o.typed ?? {}).some((v) => v.trim() !== '');
  return `<section class="card col-12" data-priority><div class="card-head"><h3>Priority &amp; sentiment</h3>${pill(on ? { cls: 'p-done', label: 'Sentiment on' } : { cls: 'p-muted', label: 'Sentiment off' })}</div>
    <div class="brief-toggle"><div><b>Sentiment analysis</b><small>Shows how each client feels (positive, neutral, negative or frustrated) on tasks, the client panel and the tracker. It adds a little to each AI read.</small></div>
      <button class="switch" type="button" role="switch" data-sentiment aria-checked="${String(on)}" aria-label="Sentiment analysis"></button></div>
    <div class="h4">Priority keywords</div>
    <p class="muted-p">A keyword in a task's messages sets its priority at once, at no cost: whole words, any case, in English, Hinglish or Hindi. The most urgent match wins. With no match the agent decides. A priority you set by hand always stays.${p.source.priorityKeywords === 'default' ? ' These are the starting lists.' : ''}</p>
    <div class="kw-grid">${levels}</div>
    ${o.problem ? `<p class="field-err" role="alert">${esc(o.problem)}</p>` : ''}
    <div class="row-gap row-top"><button class="btn btn-primary btn-sm" type="button" data-kw-save${o.dirty || typedAny ? '' : ' disabled'}>Save keywords</button>${o.dirty ? '<button class="btn btn-ghost btn-sm" type="button" data-kw-reset>Undo changes</button>' : ''}
      <small class="faint">Type a keyword and press Add or Enter. Paste several with commas between them. Up to ${p.limits.perLevel} per level, ${p.limits.maxChars} characters each. Changes are recorded in Audit logs.</small></div></section>`;
}
