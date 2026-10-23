import { describe, expect, it } from 'vitest';
import {
  MEETING_LIMITS, MEETING_SUMMARY_JSON_SCHEMA, MeetingWireSchema, validateSummary,
} from '../../src/brain/meetingSchema.ts';

function walk(node: unknown, visit: (n: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) node.forEach((x) => walk(x, visit));
  else if (node && typeof node === 'object') {
    visit(node as Record<string, unknown>);
    Object.values(node).forEach((x) => walk(x, visit));
  }
}

const IDS = ['s1', 's2', 's3', 's4'];
const NAMES = ['Asha Verma', 'Mr. Sharma'];
const LABELS = ['A', 'B', 'p2-A'];

const wire = (o: Record<string, unknown> = {}) => ({
  whatHappened: 'The client approved the logo and asked for a new banner.',
  discussion: [{ topic: 'Logo', summary: 'The client liked version 3.' }],
  decisions: [{ text: 'Logo version 3 is final.', segmentIds: ['s2'] }],
  actionItems: [
    { side: 'us', task: 'Make the banner brighter.', owner: 'Asha Verma', deadline: '2026-10-21', segmentIds: ['s3'] },
    { side: 'client', task: 'Send the logo files.', owner: '', deadline: '', segmentIds: ['s4', 's3'] },
  ],
  openQuestions: ['Which font for the menu?'],
  conclusion: 'Banner by Wednesday; logo files from the client.',
  speakers: [{ label: 'A', name: 'Asha Verma' }, { label: 'B', name: '' }],
  ...o,
});
const check = (raw: unknown) => validateSummary(raw, IDS, NAMES, LABELS);

describe('MEETING_SUMMARY_JSON_SCHEMA', () => {
  it('is strict, has no unions and no $schema', () => {
    expect(MEETING_SUMMARY_JSON_SCHEMA).not.toHaveProperty('$schema');
    walk(MEETING_SUMMARY_JSON_SCHEMA, (n) => {
      expect(n).not.toHaveProperty('anyOf');
      expect(n).not.toHaveProperty('oneOf');
      if ('type' in n) expect(Array.isArray(n.type)).toBe(false);
      if (n.type === 'object') expect(n.additionalProperties).toBe(false);
    });
  });

  // Structured output does not accept string lengths or item counts beyond minItems 1; validateSummary caps instead.
  it('carries no length or count limits the API would refuse', () => {
    walk(MEETING_SUMMARY_JSON_SCHEMA, (n) => {
      for (const k of ['maxLength', 'minLength', 'maxItems', 'pattern', 'format']) expect(n).not.toHaveProperty(k);
      if ('minItems' in n) expect(n.minItems).toBe(1);
    });
  });

  it('is flat: every field is a string, an enum, or a list of strings or of flat objects', () => {
    const props = MEETING_SUMMARY_JSON_SCHEMA.properties as Record<string, { type: string; items?: { type: string; properties?: Record<string, { type: string; items?: { type: string } }> } }>;
    expect(Object.keys(props).sort()).toEqual(['actionItems', 'conclusion', 'decisions', 'discussion', 'openQuestions', 'speakers', 'whatHappened']);
    expect(MEETING_SUMMARY_JSON_SCHEMA.required).toHaveLength(7);
    for (const p of Object.values(props)) {
      if (p.type === 'string') continue;
      expect(p.type).toBe('array');
      if (p.items!.type === 'string') continue;
      expect(p.items!.type).toBe('object');
      for (const f of Object.values(p.items!.properties!)) {
        if (f.type === 'array') expect(f.items!.type).toBe('string');
        else expect(f.type).toBe('string');
      }
    }
    const action = props.actionItems!.items as unknown as { properties: { side: { enum: string[] } }; required: string[] };
    expect(action.properties.side.enum).toEqual(['us', 'client']);
    expect(action.required.sort()).toEqual(['deadline', 'owner', 'segmentIds', 'side', 'task']);
  });

  it('round-trips a summary through JSON and validation', () => {
    const w = wire();
    expect(MeetingWireSchema.safeParse(JSON.parse(JSON.stringify(w))).success).toBe(true);
    const { summary, dropped } = check(JSON.parse(JSON.stringify(w)));
    expect(dropped).toBe(0);
    expect(summary).toEqual({
      whatHappened: w.whatHappened,
      discussion: w.discussion,
      decisions: w.decisions,
      actionItems: [
        { side: 'us', task: 'Make the banner brighter.', owner: 'Asha Verma', deadline: '2026-10-21', segmentIds: ['s3'] },
        { side: 'client', task: 'Send the logo files.', owner: null, deadline: null, segmentIds: ['s4', 's3'] },
      ],
      openQuestions: w.openQuestions,
      conclusion: w.conclusion,
      speakers: [{ label: 'A', name: 'Asha Verma' }, { label: 'B', name: null }],
    });
  });
});

describe('validateSummary', () => {
  it('keeps only segment ids that exist and drops items left with none', () => {
    const { summary, dropped } = check(wire({
      decisions: [
        { text: 'Kept', segmentIds: ['s99', 's2', ' s1 ', 's2'] },
        { text: 'Gone', segmentIds: ['s99', '[s2', 's2x', 'S99'] },
      ],
      actionItems: [
        { side: 'us', task: 'Gone too', owner: '', deadline: '', segmentIds: ['s0', 's5'] },
        { side: 'client', task: 'Kept', owner: '', deadline: '', segmentIds: ['s4'] },
      ],
    }));
    expect(summary.decisions).toEqual([{ text: 'Kept', segmentIds: ['s2', 's1'] }]);
    expect(summary.actionItems.map((a) => a.task)).toEqual(['Kept']);
    expect(dropped).toBe(2);
  });

  it('reads "S2", "2" and "s02" as segment s2', () => {
    const { summary, dropped } = check(wire({
      decisions: [{ text: 'Kept', segmentIds: ['S2', '2', ' s02 ', '4', '0', 's'] }],
      actionItems: [{ side: 'us', task: 'Kept', owner: '', deadline: '', segmentIds: ['3'] }],
    }));
    expect(summary.decisions).toEqual([{ text: 'Kept', segmentIds: ['s2', 's4'] }]);
    expect(summary.actionItems[0]!.segmentIds).toEqual(['s3']);
    expect(dropped).toBe(0);
  });

  it('drops invalid items one by one and counts them', () => {
    const { summary, dropped } = check(wire({
      discussion: [{ topic: 'Ok', summary: 'Fine' }, { topic: 'No summary' }, 'text', { topic: ' ', summary: ' ' }],
      decisions: [{ text: 'Ok', segmentIds: ['s1'] }, { text: 'No ids', segmentIds: [] }, { text: '  ', segmentIds: ['s1'] }, null],
      actionItems: [
        { side: 'them', task: 'Bad side', owner: '', deadline: '', segmentIds: ['s1'] },
        { side: 'us', task: '', owner: '', deadline: '', segmentIds: ['s1'] },
        { side: 'us', task: 'Ok', owner: '', deadline: '', segmentIds: ['s1'] },
      ],
      openQuestions: ['Ok?', 7, '   '],
    }));
    expect(summary.discussion).toEqual([{ topic: 'Ok', summary: 'Fine' }]);
    expect(summary.decisions).toEqual([{ text: 'Ok', segmentIds: ['s1'] }]);
    expect(summary.actionItems.map((a) => a.task)).toEqual(['Ok']);
    expect(summary.openQuestions).toEqual(['Ok?']);
    expect(dropped).toBe(3 + 3 + 2 + 2);
  });

  it('turns a wrong or missing part into an empty one and counts it', () => {
    const { summary, dropped } = check({ whatHappened: 42, discussion: 'none', decisions: null, openQuestions: [], conclusion: 'Done.' });
    expect(summary).toEqual({ whatHappened: '', discussion: [], decisions: [], actionItems: [], openQuestions: [], conclusion: 'Done.', speakers: [] });
    expect(dropped).toBe(5);
    expect(check('not an object').summary.conclusion).toBe('');
  });

  it('keeps a deadline only when it is a real ISO date', () => {
    const deadlines = ['2026-10-25', ' 2026-10-26 ', '25 Oct', '2026-02-30', '2026-10-25T10:00:00Z', '', 'kal'];
    const { summary, dropped } = check(wire({
      actionItems: deadlines.map((deadline) => ({ side: 'us', task: 'T', owner: '', deadline, segmentIds: ['s1'] })),
    }));
    expect(summary.actionItems.map((a) => a.deadline)).toEqual(['2026-10-25', '2026-10-26', null, null, null, null, null]);
    expect(dropped).toBe(0);
  });

  it('trims and caps every text and every list', () => {
    const long = (n: number) => 'x'.repeat(n + 50);
    const { summary, dropped } = check(wire({
      whatHappened: `  ${long(MEETING_LIMITS.whatHappened)}  `,
      conclusion: long(MEETING_LIMITS.conclusion),
      discussion: Array.from({ length: 25 }, (_, i) => ({ topic: i === 0 ? long(MEETING_LIMITS.topic) : `T${i}`, summary: long(MEETING_LIMITS.text) })),
      decisions: Array.from({ length: 31 }, () => ({ text: long(MEETING_LIMITS.text), segmentIds: ['s1'] })),
      actionItems: Array.from({ length: 41 }, () => ({ side: 'us', task: ` ${long(MEETING_LIMITS.text)}`, owner: long(MEETING_LIMITS.owner), deadline: '', segmentIds: ['s1'] })),
      openQuestions: Array.from({ length: 16 }, () => long(MEETING_LIMITS.text)),
    }));
    expect(MEETING_LIMITS).toMatchObject({ whatHappened: 1_500, conclusion: 1_500, text: 600, discussion: 20, decisions: 30, actionItems: 40, openQuestions: 15 });
    expect(summary.whatHappened).toHaveLength(1_500);
    expect(summary.conclusion).toHaveLength(1_500);
    expect(summary.discussion).toHaveLength(20);
    expect(summary.discussion[0]!.topic).toHaveLength(MEETING_LIMITS.topic);
    expect(summary.discussion[0]!.summary).toHaveLength(600);
    expect(summary.decisions).toHaveLength(30);
    expect(summary.decisions[0]!.text).toHaveLength(600);
    expect(summary.actionItems).toHaveLength(40);
    expect(summary.actionItems[0]!.task).toHaveLength(600);
    expect(summary.actionItems[0]!.owner).toHaveLength(MEETING_LIMITS.owner);
    expect(summary.openQuestions).toHaveLength(15);
    expect(summary.openQuestions[0]).toHaveLength(600);
    expect(dropped).toBe(5 + 1 + 1 + 1);
  });

  it('caps by code points, never leaving half an emoji', () => {
    const { summary } = check(wire({ conclusion: `${'x'.repeat(1_499)}😀😀` }));
    expect([...summary.conclusion]).toHaveLength(1_500);
    expect(summary.conclusion.endsWith('😀')).toBe(true);
  });

  it('gives a speaker a name only from the allowed list, matched without case', () => {
    const { summary, dropped } = check(wire({
      speakers: [
        { label: 'A', name: '  asha VERMA ' },
        { label: 'B', name: 'Boss' },
        { label: 'p2-A', name: 'Mr. Sharma' },
      ],
    }));
    expect(summary.speakers).toEqual([
      { label: 'A', name: 'Asha Verma' },
      { label: 'B', name: null },
      { label: 'p2-A', name: 'Mr. Sharma' },
    ]);
    expect(dropped).toBe(0);
  });

  // An anonymous participant's self-chosen name (or any name heard in the meeting) is never on the list.
  it('never names a speaker after an anonymous participant or a near match', () => {
    const { summary } = check(wire({
      speakers: [{ label: 'A', name: 'Anonymous Giraffe' }, { label: 'B', name: 'Asha' }, { label: 'p2-A', name: 'Mr Sharma' }],
    }));
    expect(summary.speakers.map((s) => s.name)).toEqual([null, null, null]);
  });

  it('drops a speaker whose label is not in the transcript, and a label given twice', () => {
    const { summary, dropped } = check(wire({
      speakers: [{ label: 'C', name: 'Asha Verma' }, { label: ' A ', name: 'Asha Verma' }, { label: 'A', name: 'Mr. Sharma' }, { label: 'Speaker', name: 'Mr. Sharma' }],
    }));
    expect(summary.speakers).toEqual([{ label: 'A', name: 'Asha Verma' }]);
    expect(dropped).toBe(3);
  });
});
