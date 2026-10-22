import { describe, expect, it } from 'vitest';
import { formatClock, mergeParts, segmentsToText, wordsToSegments } from '../../src/stt/segments.ts';

const w = (text: string, start: number, end: number, speaker: string | null = 'speaker_0') => ({ text, start, end, speaker });

describe('wordsToSegments', () => {
  it('joins the words of one speaker into one segment', () => {
    expect(wordsToSegments([w('Kal', 0, 0.4), w('meeting', 0.5, 0.9), w('hai', 1, 1.2)])).toEqual([
      { start: 0, end: 1.2, speaker: 'speaker_0', text: 'Kal meeting hai' },
    ]);
  });

  it('starts a new segment when the speaker changes', () => {
    const segs = wordsToSegments([w('Haan', 0, 0.3, 'speaker_0'), w('Theek', 0.4, 0.7, 'speaker_1')]);
    expect(segs.map((s) => [s.speaker, s.text])).toEqual([
      ['speaker_0', 'Haan'],
      ['speaker_1', 'Theek'],
    ]);
  });

  it('starts a new segment after a pause longer than 1.5 seconds', () => {
    expect(wordsToSegments([w('a', 0, 1), w('b', 2.6, 3)])).toHaveLength(2);
    expect(wordsToSegments([w('a', 0, 1), w('b', 2.4, 3)])).toHaveLength(1);
  });

  it('keeps every segment within 30 seconds', () => {
    const words = Array.from({ length: 40 }, (_, i) => w(`w${i}`, i, i + 0.9));
    const segs = wordsToSegments(words);
    expect(segs).toHaveLength(2);
    expect(segs.every((s) => s.end - s.start <= 30)).toBe(true);
  });

  it('returns nothing for no words', () => {
    expect(wordsToSegments([])).toEqual([]);
  });
});

describe('mergeParts', () => {
  it('keeps a single part as it is', () => {
    const seg = { start: 1, end: 2, speaker: 'A', text: 'x' };
    expect(mergeParts([{ offset: 0, segments: [seg] }])).toEqual([seg]);
  });

  it('shifts times by the part offset and marks speakers with the part number', () => {
    const merged = mergeParts([
      { offset: 0, segments: [{ start: 0, end: 5, speaker: 'A', text: 'one' }] },
      {
        offset: 300,
        segments: [
          { start: 2, end: 4, speaker: 'A', text: 'two' },
          { start: 4, end: 6, speaker: null, text: 'three' },
        ],
      },
    ]);
    expect(merged).toEqual([
      { start: 0, end: 5, speaker: 'p1:A', text: 'one' },
      { start: 302, end: 304, speaker: 'p2:A', text: 'two' },
      { start: 304, end: 306, speaker: null, text: 'three' },
    ]);
  });
});

describe('formatClock', () => {
  it('formats minutes, and hours when needed', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(75.4)).toBe('1:15');
    expect(formatClock(3725)).toBe('1:02:05');
  });
});

describe('segmentsToText', () => {
  it('writes one line per segment', () => {
    const text = segmentsToText([
      { start: 75, end: 80, speaker: 'A', text: 'Kal' },
      { start: 81, end: 82, speaker: null, text: 'ok' },
    ]);
    expect(text).toBe('[1:15] A: Kal\n[1:21] ok\n');
  });

  it('is empty for no segments', () => {
    expect(segmentsToText([])).toBe('');
  });
});
