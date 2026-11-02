import { describe, expect, it } from 'vitest';
import { fillMessage } from '../../src/report/morningReport.ts';
// Browser module; its JSDoc types are checked by tsconfig.web.json, so the import is untyped here.
// @ts-expect-error -- browser module (see above)
import { charCount, fillPreview, readMessageEditor, unknownPlaceholders } from '../../src/web/public/views/automations.js';

// The morning message editor's browser side (November release, change 5): the live preview fills the text exactly as
// the agent will, and the answer from the agent is read defensively.

const PLACES = [
  { key: 'greeting', hint: 'Good morning', value: 'Good morning' },
  { key: 'open', hint: 'Open tasks', value: '6' },
  { key: 'tracker_link', hint: 'Tracker', value: 'https://drive.google.com/file/d/1FakeTrackerFileId_000/view' },
];
const values = Object.fromEntries(PLACES.map((p) => [p.key, p.value]));

describe('the live preview', () => {
  it('fills the text as the agent does, an unknown placeholder as written', () => {
    for (const t of ['{greeting}! {open} open.\n{tracker_link}', '{name} {Open} { open } {open', '{{open}}', '', '{constructor} {__proto__}', '{a}{open}{b}']) {
      expect(fillPreview(t, PLACES), JSON.stringify(t)).toBe(fillMessage(t, values));
    }
    expect(fillPreview('{greeting}, {name}: {open}', PLACES)).toBe('Good morning, {name}: 6');
  });

  it('names each unknown placeholder once, in order', () => {
    expect(unknownPlaceholders('{name} {open} {Open} {name} { x }', PLACES)).toEqual(['{name}', '{Open}', '{ x }']);
    expect(unknownPlaceholders('{greeting} {open}', PLACES)).toEqual([]);
  });

  it('counts characters as the agent does (an emoji once)', () => {
    expect(charCount('ab😀')).toBe(3);
  });
});

describe('readMessageEditor', () => {
  const good = { template: 'Hi {open}', isDefault: false, defaultTemplate: '{greeting}.', maxChars: 1000, placeholders: PLACES, trackerLinked: true };

  it('reads the agent\'s answer', () => {
    expect(readMessageEditor(good)).toEqual(good);
  });

  it('is null for anything else (an older agent, an error), and drops a placeholder with an odd key', () => {
    for (const bad of [null, 'x', {}, { ...good, template: '' }, { ...good, maxChars: '1000' }, { ...good, placeholders: 'x' }]) {
      expect(readMessageEditor(bad), JSON.stringify(bad)).toBeNull();
    }
    const odd = readMessageEditor({ ...good, placeholders: [...PLACES, { key: '<b>', hint: 'x', value: 'y' }, { key: 'due_today', hint: 5, value: null }] });
    expect(odd.placeholders.map((p: { key: string }) => p.key)).toEqual(['greeting', 'open', 'tracker_link', 'due_today']);
    expect(odd.placeholders[3]).toEqual({ key: 'due_today', hint: '', value: '' });
  });
});
