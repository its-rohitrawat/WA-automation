import { describe, expect, it } from 'vitest';
// Browser modules; their JSDoc types are checked by tsconfig.web.json, so the imports are untyped here.
// @ts-expect-error -- browser module (see above)
import { addTyped, addWords, draftOf, keywordAdder, keywordChips, renderPriority, sameKeywords, splitKeywords } from '../../src/web/public/views/priorityPanel.js';
// @ts-expect-error -- browser module (see above)
import { moodLabel, priorityPill, prioritySourceText } from '../../src/web/public/views/workLib.js';

const LIMITS = { perLevel: 3, maxChars: 10 };
const empty = () => ({ critical: [], major: [], medium: [], low: [] });

describe('priority and mood labels', () => {
  it('names every level with a word and a class, and a task without one as a muted "—"', () => {
    expect(['critical', 'major', 'medium', 'low'].map(priorityPill)).toEqual([
      { cls: 'p-critical', label: 'Critical' }, { cls: 'p-major', label: 'Major' }, { cls: 'p-medium', label: 'Medium' }, { cls: 'p-low', label: 'Low' },
    ]);
    expect(priorityPill(null)).toEqual({ cls: 'p-muted', label: '—' });
    expect(priorityPill('high')).toEqual({ cls: 'p-muted', label: '—' });
  });

  it('shows a mood only for a known one', () => {
    expect(moodLabel('frustrated')).toEqual({ cls: 'mood mood-frustrated', label: 'Frustrated' });
    expect(moodLabel(null)).toBeNull();
    expect(moodLabel('angry')).toBeNull();
  });

  it('says what set a priority', () => {
    expect(prioritySourceText('keyword', 'urgent')).toBe('from the keyword "urgent"');
    expect(prioritySourceText('human', null)).toBe('set by the owner');
    expect(prioritySourceText('ai', null)).toBe('set by the agent');
    expect(prioritySourceText(null, null)).toBe('not set yet');
  });
});

describe('the keyword chips', () => {
  it('adds what is typed, split at commas, trimmed, without repeats in any case', () => {
    const d = empty();
    expect(addTyped(d, 'critical', ' urgent ,  site   down,URGENT, ', LIMITS)).toBeNull();
    expect(d.critical).toEqual(['urgent', 'site down']);
  });

  it('refuses a keyword already in another list, one too long, and one past the limit', () => {
    const d = { ...empty(), critical: ['urgent'] };
    expect(addTyped(d, 'major', 'Urgent', LIMITS)).toBe('That keyword is already in Critical: keep each keyword in one list.');
    expect(addTyped(d, 'major', 'x'.repeat(11), LIMITS)).toBe('A keyword can be at most 10 characters.');
    expect(addTyped(d, 'low', 'a, b, c, d', LIMITS)).toBe('Low can have at most 3 keywords.');
    expect(d.major).toEqual([]);
  });

  it('compares and copies lists without sharing them', () => {
    const k = { ...empty(), low: ['no rush'] };
    const d = draftOf(k);
    expect(sameKeywords(d, k)).toBe(true);
    d.low.push('later');
    expect(sameKeywords(d, k)).toBe(false);
    expect(k.low).toEqual(['no rush']);
  });

  it('draws keywords as text, never as markup, with the switch and the cost note', () => {
    const view = { keywords: { ...empty(), critical: ['<img src=x>'] }, sentimentEnabled: false, source: { priorityKeywords: 'dashboard', sentimentEnabled: 'default' }, limits: LIMITS };
    const html = renderPriority(view, draftOf(view.keywords), { dirty: false, problem: null, typed: { low: '"><b>' } });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x&gt;');
    expect(html).toContain('value="&quot;&gt;&lt;b&gt;"');
    expect(html).toContain('role="switch" data-sentiment aria-checked="false"');
    expect(html).toContain('It adds a little to each AI read.');
    // Text still in a box counts as a change (Save adds it first); with nothing typed and nothing changed, Save waits.
    expect(html).not.toContain('data-kw-save disabled');
    expect(renderPriority(view, draftOf(view.keywords), { dirty: false, problem: null, typed: { low: '  ' } })).toContain('data-kw-save disabled');
  });
});

describe('adding keywords one at a time (November release, change 6)', () => {
  it('splits what is typed or pasted at commas, trimmed and single-spaced', () => {
    expect(splitKeywords(' a ,  b   c,, d ,')).toEqual(['a', 'b c', 'd']);
    expect(splitKeywords('   ')).toEqual([]);
  });

  it('adds "a, b" as two keywords and ignores one already there, in any case', () => {
    const list = ['Iyer'];
    expect(addWords(list, 'dental website, IYER, iyer , Dental Website', { max: 20, full: 'full' })).toBe('');
    expect(list).toEqual(['Iyer', 'dental website']);
  });

  it('stops at the first keyword refused, keeping the ones before it', () => {
    const list: string[] = [];
    const check = (k: string) => (k.length < 3 ? `The keyword "${k}" needs at least 3 letters.` : '');
    expect(addWords(list, 'iyer, ab, dental', { max: 20, full: 'full', check })).toBe('The keyword "ab" needs at least 3 letters.');
    expect(list).toEqual(['iyer']);
    expect(addWords(['one', 'two'], 'three', { max: 2, full: 'At most 2 meeting keywords.' })).toBe('At most 2 meeting keywords.');
  });

  it('draws an input with an Add button, and the chips below it, each with a remove button, as text only', () => {
    const add: string = keywordAdder({ input: 'data-kw-input="low"', button: 'data-kw-add="low"', value: '"><b>', maxlength: 40, label: 'New Low keyword', buttonLabel: 'Add Low keyword', placeholder: 'Add a keyword' });
    expect(add).toContain('value="&quot;&gt;&lt;b&gt;"');
    expect(add).toContain('aria-label="New Low keyword"');
    expect(add).toMatch(/<button class="btn btn-ghost btn-sm" type="button" data-kw-add="low" aria-label="Add Low keyword">Add<\/button>/);
    expect(add.indexOf('<input')).toBeLessThan(add.indexOf('<button'));
    const chips: string = keywordChips(['<img src=x>', 'site down'], (i: number) => `data-kw-remove="low" data-i="${i}"`, { empty: 'No keywords yet', label: 'Low keywords' });
    expect(chips).not.toContain('<img');
    expect(chips).toContain('<span>&lt;img src=x&gt;</span>');
    expect(chips).toContain('data-kw-remove="low" data-i="1" aria-label="Remove site down"');
    expect(chips).toContain('aria-label="Low keywords"');
    expect(keywordChips([], () => '', { empty: 'No keywords yet', label: 'Low keywords' })).toContain('No keywords yet');
  });

  it("puts each level's box and Add button above its chips, and says how to add", () => {
    const view = { keywords: { ...empty(), major: ['asap'] }, sentimentEnabled: true, source: { priorityKeywords: 'dashboard', sentimentEnabled: 'default' }, limits: LIMITS };
    const html: string = renderPriority(view, draftOf(view.keywords), { dirty: false, problem: null });
    for (const level of ['critical', 'major', 'medium', 'low']) {
      expect(html).toContain(`data-kw-input="${level}"`);
      expect(html).toContain(`data-kw-add="${level}"`);
    }
    expect(html.indexOf('data-kw-add="major"')).toBeLessThan(html.indexOf('data-kw-remove="major" data-i="0"'));
    expect(html).toContain('Type a keyword and press Add or Enter. Paste several with commas between them.');
    expect(html).not.toContain('type a comma to add');
  });
});
