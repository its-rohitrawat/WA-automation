import { describe, expect, it } from 'vitest';
import type { SlotState } from '../../../src/stt/bakeoff/ledger.ts';
import { buildPlan, formatPlan, planTotalUsd, type PlanInput } from '../../../src/stt/bakeoff/plan.ts';
import type { Sample } from '../../../src/stt/bakeoff/samples.ts';

const voice: Sample = { id: 'voice-a', kind: 'voice', path: 'C:\\stt-samples\\voice-notes\\a.ogg' };
const meeting: Sample = { id: 'meeting-b', kind: 'meeting', path: 'C:\\stt-samples\\meetings\\b.mp4' };
const PROVIDERS = [
  { id: 'sarvam' as const, maxPartSeconds: 7200 },
  { id: 'elevenlabs' as const, maxPartSeconds: 36000 },
  { id: 'openai' as const, maxPartSeconds: 300 },
];

function input(over: Partial<PlanInput> = {}): PlanInput {
  return {
    samples: [
      { sample: voice, seconds: 60 },
      { sample: meeting, seconds: 3600 },
    ],
    providers: PROVIDERS,
    stateOf: () => 'new',
    hasJobId: () => false,
    retryFailed: false,
    retryUnknown: false,
    inrPerUsd: 90,
    ...over,
  };
}

describe('buildPlan', () => {
  it('makes one item per sample and provider, with models, parts and speaker labels for meetings', () => {
    const items = buildPlan(input());
    expect(items.map((i) => [i.sample.id, i.provider, i.model, i.diarize, i.parts, i.action])).toEqual([
      ['voice-a', 'sarvam', 'saaras:v4', false, 1, 'send'],
      ['voice-a', 'elevenlabs', 'scribe_v2', false, 1, 'send'],
      ['voice-a', 'openai', 'gpt-transcribe', false, 1, 'send'],
      ['meeting-b', 'sarvam', 'saaras:v4', true, 1, 'send'],
      ['meeting-b', 'elevenlabs', 'scribe_v2', true, 1, 'send'],
      ['meeting-b', 'openai', 'gpt-4o-transcribe-diarize', true, 12, 'send'],
    ]);
  });

  it('estimates list prices and totals them', () => {
    const items = buildPlan(input());
    const meetingSarvam = items.find((i) => i.sample.id === 'meeting-b' && i.provider === 'sarvam')!;
    expect(meetingSarvam.estimateUsd).toBeCloseTo(0.4, 10); // ₹36 at ₹90/$
    // 60 s voice: sarvam ₹0.5/90 + elevenlabs 0.22/60 + openai 0.27/60; 1 h meeting: 0.4 + 0.22 + 0.36.
    expect(planTotalUsd(items)).toBeCloseTo(0.5 / 90 + 0.22 / 60 + 0.27 / 60 + 0.4 + 0.22 + 0.36, 10);
  });

  it('skips finished slots and sends failed or unanswered ones only when asked', () => {
    const states: Record<string, SlotState> = { sarvam: 'done', elevenlabs: 'failed', openai: 'unknown' };
    const only = { samples: [{ sample: voice, seconds: 60 }], stateOf: (_s: string, p: string) => states[p]! };
    expect(buildPlan(input(only)).map((i) => i.action)).toEqual(['skip', 'skip', 'skip']);
    expect(buildPlan(input({ ...only, retryFailed: true, retryUnknown: true })).map((i) => i.action)).toEqual(['skip', 'send', 'send']);
    expect(buildPlan(input(only)).every((i) => i.estimateUsd === 0)).toBe(true);
  });

  it('waits on a saved job for free instead of sending again', () => {
    const items = buildPlan(input({
      samples: [{ sample: meeting, seconds: 3600 }],
      stateOf: (_s, p) => (p === 'sarvam' ? 'unknown' : 'done'),
      hasJobId: (_s, p) => p === 'sarvam',
      retryUnknown: true,
    }));
    expect(items[0]).toMatchObject({ provider: 'sarvam', action: 'resume', estimateUsd: 0 });
  });
});

describe('formatPlan', () => {
  it('lists every slot, the files that would be uploaded and the estimate', () => {
    const text = formatPlan(buildPlan(input()));
    expect(text).toContain('meeting-b');
    expect(text).toContain('gpt-4o-transcribe-diarize in 12 parts');
    expect(text).toContain('Files whose audio would be uploaded (2):');
    expect(text).toContain('C:\\stt-samples\\meetings\\b.mp4');
    expect(text).toMatch(/Estimated cost: \$\d+\.\d{2} at list prices\./);
  });

  it('warns when an unanswered slot would be sent again', () => {
    const text = formatPlan(buildPlan(input({ samples: [{ sample: voice, seconds: 60 }], stateOf: () => 'unknown', retryUnknown: true })));
    expect(text).toContain('send again (an earlier attempt may already be billed)');
  });
});
