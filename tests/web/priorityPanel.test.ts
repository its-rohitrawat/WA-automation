import { describe, expect, it } from 'vitest';
// Browser modules; their JSDoc types are checked by tsconfig.web.json, so the imports are untyped here.
// @ts-expect-error -- browser module (see above)
import { addTyped, draftOf, renderPriority, sameKeywords } from '../../src/web/public/views/priorityPanel.js';
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
    expect(html).toContain('data-kw-save disabled');
  });
});
