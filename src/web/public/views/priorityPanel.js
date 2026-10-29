// The Settings screen's "Priority & sentiment" section (29 Oct 2026): four keyword lists edited as chips, saved
// together, and the sentiment switch, saved at once. The owner's keywords go through esc() like every other value.
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
  for (const raw of typed.split(',')) {
    const k = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
    if (!k) continue;
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
    const chips = list.map((k, i) => `<span class="kw-chip">${esc(k)}<button type="button" data-kw-remove="${esc(l)}" data-i="${i}" aria-label="${esc(`Remove ${k}`)}">${icon('close', 12)}</button></span>`).join('');
    return `<div class="kw-level"><div class="kw-head">${pill(priorityPill(l))}<small>${esc(HINTS[l] ?? '')}</small></div>
      <div class="kw-chips">${chips || '<span class="faint kw-none">No keywords</span>'}
        <input class="kw-input" data-kw-input="${esc(l)}" value="${esc(o.typed?.[l] ?? '')}" maxlength="${p.limits.maxChars * 4}" placeholder="Add a keyword" aria-label="${esc(`Add a ${priorityPill(l).label} keyword`)}" autocomplete="off"></div></div>`;
  }).join('');
  const on = p.sentimentEnabled;
  return `<section class="card col-12" data-priority><div class="card-head"><h3>Priority &amp; sentiment</h3>${pill(on ? { cls: 'p-done', label: 'Sentiment on' } : { cls: 'p-muted', label: 'Sentiment off' })}</div>
    <div class="brief-toggle"><div><b>Sentiment analysis</b><small>Shows how each client feels (positive, neutral, negative or frustrated) on tasks, the client panel and the tracker. It adds a little to each AI read.</small></div>
      <button class="switch" type="button" role="switch" data-sentiment aria-checked="${String(on)}" aria-label="Sentiment analysis"></button></div>
    <div class="h4">Priority keywords</div>
    <p class="muted-p">A keyword in a task's messages sets its priority at once, at no cost: whole words, any case, in English, Hinglish or Hindi. The most urgent match wins. With no match the agent decides. A priority you set by hand always stays.${p.source.priorityKeywords === 'default' ? ' These are the starting lists.' : ''}</p>
    <div class="kw-grid">${levels}</div>
    ${o.problem ? `<p class="field-err" role="alert">${esc(o.problem)}</p>` : ''}
    <div class="row-gap row-top"><button class="btn btn-primary btn-sm" type="button" data-kw-save${o.dirty ? '' : ' disabled'}>Save keywords</button>${o.dirty ? '<button class="btn btn-ghost btn-sm" type="button" data-kw-reset>Undo changes</button>' : ''}
      <small class="faint">Press Enter or type a comma to add. Up to ${p.limits.perLevel} per level, ${p.limits.maxChars} characters each. Changes are recorded in Audit logs.</small></div></section>`;
}
