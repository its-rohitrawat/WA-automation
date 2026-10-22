import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Ledger, type SlotState } from '../../../src/stt/bakeoff/ledger.ts';
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
    canResume: () => false,
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

  it('keeps --retry-failed and --retry-unknown apart', () => {
    const states: Record<string, SlotState> = { sarvam: 'done', elevenlabs: 'failed', openai: 'unknown' };
    const only = { samples: [{ sample: voice, seconds: 60 }], stateOf: (_s: string, p: string) => states[p]! };
    expect(buildPlan(input({ ...only, retryFailed: true })).map((i) => i.action)).toEqual(['skip', 'send', 'skip']);
    expect(buildPlan(input({ ...only, retryUnknown: true })).map((i) => i.action)).toEqual(['skip', 'skip', 'send']);
  });

  it('waits on saved jobs for free when they cover every part', () => {
    const asked: [string, string, number][] = [];
    const items = buildPlan(input({
      samples: [{ sample: meeting, seconds: 3600 }],
      stateOf: () => 'unknown',
      canResume: (s, p, parts) => {
        asked.push([s, p, parts]);
        return p === 'sarvam';
      },
      retryUnknown: true,
    }));
    expect(items[0]).toMatchObject({ provider: 'sarvam', action: 'resume', estimateUsd: 0 });
    expect(asked).toEqual([
      ['meeting-b', 'sarvam', 1],
      ['meeting-b', 'elevenlabs', 1],
      ['meeting-b', 'openai', 12],
    ]);
  });

  it('sends again with the full estimate when saved jobs and answers do not cover every part', () => {
    const items = buildPlan(input({ samples: [{ sample: meeting, seconds: 3600 }], stateOf: () => 'unknown', retryUnknown: true }));
    const openai = items.find((i) => i.provider === 'openai')!;
    expect(openai).toMatchObject({ action: 'send', state: 'unknown' });
    expect(openai.estimateUsd).toBeCloseTo(0.36, 10);
  });

  it('plans a new paid send, with the warning, for a Sarvam job the provider no longer has', () => {
    const ledger = new Ledger(mkdtempSync(join(tmpdir(), 'stt-plan-')));
    ledger.begin({
      sampleId: 'meeting-b', provider: 'sarvam', model: 'saaras:v4', startedAt: '2026-10-22T10:00:00.000Z',
      jobIds: { '0': 'job-9' }, sends: ['2026-10-22T10:00:01.000Z'],
    });
    const plan = () =>
      buildPlan(input({
        samples: [{ sample: meeting, seconds: 3600 }],
        providers: [PROVIDERS[0]!],
        stateOf: (s, p) => ledger.state(s, p),
        canResume: (s, p, parts) => ledger.canResume(s, p, parts),
        retryUnknown: true,
      }));
    expect(plan()[0]).toMatchObject({ action: 'resume', estimateUsd: 0 });
    ledger.dropJobId('meeting-b', 'sarvam', 0);
    const lost = plan()[0]!;
    expect(lost).toMatchObject({ state: 'unknown', action: 'send' });
    expect(lost.estimateUsd).toBeCloseTo(0.4, 10);
    expect(formatPlan([lost])).toContain('send again (an earlier attempt may already be billed)');
  });

  it('counts parts from the prepared MP3 when there is one, since that is the file the runner cuts', () => {
    // The prepared MP3 runs a little longer than the original: 1800 s gives 6 parts of 300 s, 1800.07 s gives 7.
    const asked: number[] = [];
    const [resumed] = buildPlan(input({
      samples: [{ sample: meeting, seconds: 1800, preparedSeconds: 1800.07 }],
      providers: [PROVIDERS[2]!],
      stateOf: () => 'unknown',
      canResume: (_s, _p, parts) => (asked.push(parts), true),
      retryUnknown: true,
    }));
    expect(resumed).toMatchObject({ seconds: 1800, parts: 7, action: 'resume' });
    expect(asked).toEqual([7]);
    // The listing and the estimate keep the original's length.
    const [sent] = buildPlan(input({ samples: [{ sample: meeting, seconds: 1800, preparedSeconds: 1800.07 }], providers: [PROVIDERS[2]!] }));
    expect(sent!.estimateUsd).toBeCloseTo(0.18, 10);
    expect(formatPlan([sent!])).toContain(' 30:00  openai     gpt-4o-transcribe-diarize in 7 parts');
    // Before anything is prepared, the original's length is all there is.
    expect(buildPlan(input({ samples: [{ sample: meeting, seconds: 1800 }], providers: [PROVIDERS[2]!] }))[0]!.parts).toBe(6);
  });

  it('never asks about resuming a slot that is not unknown', () => {
    let asked = 0;
    buildPlan(input({ retryFailed: true, retryUnknown: true, canResume: () => (asked++, true) }));
    expect(asked).toBe(0);
  });
});

describe('formatPlan', () => {
  it('lists every slot, the files that would be uploaded and the estimate', () => {
    const text = formatPlan(buildPlan(input()));
    expect(text).toContain('meeting-b');
    expect(text).toContain('gpt-4o-transcribe-diarize in 12 parts');
    expect(text).toContain('Files whose audio would be uploaded (2):');
    expect(text).toContain('C:\\stt-samples\\meetings\\b.mp4');
    // Below $1 the total keeps three decimals, so a small run never shows as $0.00.
    expect(text).toContain('Estimated cost: $0.994 at list prices.');
  });

  it('shows the total with two decimals from $1 up', () => {
    const text = formatPlan(buildPlan(input({ samples: [{ sample: voice, seconds: 60 }, { sample: meeting, seconds: 7200 }] })));
    // 60 s voice ≈ $0.014; 2 h meeting: 0.8 + 0.44 + 0.72.
    expect(text).toContain('Estimated cost: $1.97 at list prices.');
  });

  it('lines the columns up when a sample id is long', () => {
    const long: Sample = { id: `meeting-${'x'.repeat(40)}-0123abcd`, kind: 'meeting', path: 'C:\\stt-samples\\meetings\\x.mp4' };
    const text = formatPlan(buildPlan(input({ samples: [{ sample: voice, seconds: 60 }, { sample: long, seconds: 60 }] })));
    const lines = text.split('\n').filter((l) => l.includes(' sarvam '));
    expect(lines).toHaveLength(2);
    expect(lines[0]!.indexOf(' 1:00 ')).toBe(lines[1]!.indexOf(' 1:00 '));
    expect(lines[1]).toContain(`${long.id} `);
  });

  it('warns when an unanswered slot would be sent again', () => {
    const text = formatPlan(buildPlan(input({ samples: [{ sample: voice, seconds: 60 }], stateOf: () => 'unknown', retryUnknown: true })));
    expect(text).toContain('send again (an earlier attempt may already be billed)');
  });
});
