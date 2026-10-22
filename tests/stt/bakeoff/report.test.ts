import { describe, expect, it } from 'vitest';
import type { Outcome } from '../../../src/stt/bakeoff/ledger.ts';
import { buildReport, buildScoreSheet, cell, localTime, type ReportInput } from '../../../src/stt/bakeoff/report.ts';
import { PROVIDER_IDS } from '../../../src/stt/types.ts';

const at = (start: number, speaker: string | null, text: string) => ({ start, end: start + 2, speaker, text });

function outcome(over: Partial<Outcome> & Pick<Outcome, 'sampleId' | 'kind' | 'provider'>): Outcome {
  return {
    model: 'm',
    status: 'done',
    audioSeconds: 60,
    billedSeconds: null,
    costUsd: 0.01,
    processingSeconds: 3,
    parts: 1,
    error: null,
    segments: [],
    finishedAt: '2026-10-22T10:00:00.000Z',
    ...over,
  };
}

function report(over: Partial<ReportInput> = {}): string {
  return buildReport({ generatedAt: '2026-10-22T10:00:00.000Z', inrPerUsd: 88, samples: [], outcomes: [], unknown: [], ...over });
}

describe('cell', () => {
  it('keeps a table cell on one line and escapes pipes and HTML', () => {
    expect(cell('a | b\n<script>&')).toBe('a \\| b &lt;script&gt;&amp;');
  });

  it('turns a lone carriage return, tabs and runs of spaces into single spaces', () => {
    expect(cell(' a\rb\t\tc   d\r\n')).toBe('a b c d');
  });
});

describe('localTime', () => {
  it('writes the local date and time with the UTC offset', () => {
    expect(localTime(new Date('2026-10-22T10:00:00.000Z'), 330)).toBe('2026-10-22 15:30 UTC+05:30');
  });

  it('handles offsets west of UTC and the date line', () => {
    expect(localTime(new Date('2026-10-22T02:05:00.000Z'), -300)).toBe('2026-10-21 21:05 UTC-05:00');
    expect(localTime(new Date('2026-10-22T02:05:00.000Z'), 0)).toBe('2026-10-22 02:05 UTC+00:00');
  });
});

describe('buildScoreSheet', () => {
  it('has a blank row for every provider and the scoring scale', () => {
    const text = buildScoreSheet();
    for (const p of PROVIDER_IDS) expect(text).toContain(`| ${p} |  |  |  |  |  |`);
    expect(text).toContain('5 = names, numbers, dates, amounts and task words all right');
    expect(text).toContain('never overwritten');
  });
});

describe('buildReport', () => {
  it('warns that the report is private', () => {
    expect(report()).toContain('> Private: this file contains client conversations.');
  });

  it('summarises cost per audio hour and processing time per audio minute', () => {
    const text = report({
      samples: [{ id: 'meeting-b', kind: 'meeting', seconds: 1800 }],
      outcomes: [outcome({ sampleId: 'meeting-b', kind: 'meeting', provider: 'elevenlabs', model: 'scribe_v2', audioSeconds: 1800, costUsd: 0.11, processingSeconds: 90 })],
    });
    expect(text).toContain('| elevenlabs | meetings | scribe_v2 | 1 | 0 | 0 | 30:00 | $0.110 | $0.220 | 3.0 s |');
  });

  it('counts slots without an answer in the summary', () => {
    const text = report({
      samples: [{ id: 'voice-a', kind: 'voice', seconds: 60 }],
      unknown: [{ sampleId: 'voice-a', provider: 'sarvam' }],
    });
    expect(text).toContain('| sarvam | voice notes | – | 0 | 0 | 1 | 0:00 | $0.000 | – | – |');
  });

  it('shows every provider for each voice note', () => {
    const text = report({
      samples: [{ id: 'voice-a', kind: 'voice', seconds: 42 }],
      outcomes: [
        outcome({ sampleId: 'voice-a', kind: 'voice', provider: 'sarvam', segments: [at(0, null, 'Kal 4 baje')] }),
        outcome({ sampleId: 'voice-a', kind: 'voice', provider: 'openai', status: 'failed', error: 'http_401 invalid_api_key' }),
      ],
      unknown: [{ sampleId: 'voice-a', provider: 'elevenlabs' }],
    });
    expect(text).toContain('### voice-a (0:42)');
    expect(text).toContain('| sarvam | 3.0 s | $0.010 | Kal 4 baje |');
    expect(text).toContain("| elevenlabs | – | – | no answer: check the provider's dashboard |");
    expect(text).toContain('| openai | – | – | failed (http_401 invalid_api_key) |');
  });

  it('lays meetings out on a timeline with one column per provider that finished', () => {
    const text = report({
      samples: [{ id: 'meeting-b', kind: 'meeting', seconds: 120 }],
      outcomes: [
        outcome({ sampleId: 'meeting-b', kind: 'meeting', provider: 'sarvam', segments: [at(5, 'speaker_0', 'Namaste'), at(70, 'speaker_1', 'Budget final?')] }),
        outcome({ sampleId: 'meeting-b', kind: 'meeting', provider: 'elevenlabs', segments: [at(10, 'speaker_0', 'Namaste ji')] }),
        outcome({ sampleId: 'meeting-b', kind: 'meeting', provider: 'openai', status: 'failed', error: 'job_failed' }),
      ],
    });
    expect(text).toContain('| sarvam | 2 | 2 | 3.0 s | $0.010 |');
    expect(text).toContain('| openai | – | – | – | failed (job_failed) |');
    expect(text).toContain('| Time | sarvam | elevenlabs |');
    expect(text).toContain('| 0:00 | **speaker_0:** Namaste | **speaker_0:** Namaste ji |');
    expect(text).toContain('| 1:00 | **speaker_1:** Budget final? |  |');
  });

  it('points to scores.md instead of holding a score sheet', () => {
    const text = report({
      samples: [{ id: 'voice-a', kind: 'voice', seconds: 42 }],
      outcomes: [outcome({ sampleId: 'voice-a', kind: 'voice', provider: 'openai' })],
    });
    expect(text).toContain('Score in scores.md in this folder. It is never overwritten; report.md is rebuilt on every run.');
    expect(text).not.toContain('## Score sheet');
    expect(text).not.toContain('| openai |  |  |  |  |  |');
  });

  it('calls the summary column Recordings and prints the time it is given', () => {
    const text = report({
      generatedAt: '2026-10-22 15:30 UTC+05:30',
      samples: [{ id: 'voice-a', kind: 'voice', seconds: 42 }],
      outcomes: [outcome({ sampleId: 'voice-a', kind: 'voice', provider: 'openai' })],
    });
    expect(text).toContain('Generated 2026-10-22 15:30 UTC+05:30.');
    expect(text).toContain('| Provider | Recordings | Model |');
  });

  it('says "No results yet." under Summary when nothing has run', () => {
    const text = report({ samples: [{ id: 'voice-a', kind: 'voice', seconds: 42 }, { id: 'meeting-b', kind: 'meeting', seconds: 600 }] });
    expect(text).toContain('## Summary\n\nNo results yet.\n');
    expect(text).not.toContain('| Provider |');
    expect(text).not.toContain('## Voice notes');
    expect(text).not.toContain('## Meetings');
  });

  it('leaves the length out of a heading when it is not known', () => {
    const text = report({ samples: [{ id: 'voice-a', kind: 'voice', seconds: null }], unknown: [{ sampleId: 'voice-a', provider: 'sarvam' }] });
    expect(text).toContain('### voice-a\n');
    expect(text).toContain("| sarvam | – | – | no answer: check the provider's dashboard |");
  });

  it('puts each turn of a minute on its own line within the cell, escaping any markup in the words', () => {
    const text = report({
      samples: [{ id: 'meeting-b', kind: 'meeting', seconds: 60 }],
      outcomes: [outcome({ sampleId: 'meeting-b', kind: 'meeting', provider: 'sarvam', segments: [at(1, 'A', 'Namaste'), at(9, 'B', 'Haan <br> ji')] })],
    });
    expect(text).toContain('| 0:00 | **A:** Namaste<br>**B:** Haan &lt;br&gt; ji |');
  });

  it("notes OpenAI's 5-minute cuts only when OpenAI is on the timeline", () => {
    const note = 'OpenAI meetings are sent in parts of up to 5 minutes; words at a cut can be lost.';
    const meeting = (provider: 'sarvam' | 'openai') =>
      report({ samples: [{ id: 'meeting-b', kind: 'meeting', seconds: 60 }], outcomes: [outcome({ sampleId: 'meeting-b', kind: 'meeting', provider, segments: [at(1, 'A', 'x')] })] });
    expect(meeting('openai')).toContain(note);
    expect(meeting('sarvam')).not.toContain(note);
  });

  it('keeps the timeline to the recording length plus five rows, with stray times in the first or last row', () => {
    const text = report({
      samples: [{ id: 'meeting-b', kind: 'meeting', seconds: 120 }],
      outcomes: [
        outcome({ sampleId: 'meeting-b', kind: 'meeting', provider: 'sarvam', segments: [at(-3, 'A', 'early'), at(30, 'A', 'start'), at(36_000, 'B', 'late')] }),
      ],
    });
    const rows = text.split('\n').filter((l) => /^\| \d+:\d{2} \|/.test(l));
    // 2 minutes of audio: rows 0:00 to 6:00.
    expect(rows).toHaveLength(7);
    expect(rows[0]).toBe('| 0:00 | **A:** early<br>**A:** start |');
    expect(rows[6]).toBe('| 6:00 | **B:** late |');
  });
});
