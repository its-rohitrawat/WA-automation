import { describe, expect, it } from 'vitest';
import type { Outcome } from '../../../src/stt/bakeoff/ledger.ts';
import { buildReport, cell, type ReportInput } from '../../../src/stt/bakeoff/report.ts';

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

  it('includes a blank score sheet row per provider', () => {
    const text = report({
      samples: [{ id: 'voice-a', kind: 'voice', seconds: 42 }],
      outcomes: [outcome({ sampleId: 'voice-a', kind: 'voice', provider: 'openai' })],
    });
    expect(text).toContain('## Score sheet');
    expect(text).toContain('| openai |  |  |  |  |  |');
  });
});
