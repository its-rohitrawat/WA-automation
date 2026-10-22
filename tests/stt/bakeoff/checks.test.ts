import { describe, expect, it } from 'vitest';
import { PRIVACY_CHECKLIST, refusals } from '../../../src/stt/bakeoff/checks.ts';
import type { BakeoffEnv } from '../../../src/stt/bakeoff/env.ts';
import type { PlanItem } from '../../../src/stt/bakeoff/plan.ts';
import type { ProviderId } from '../../../src/stt/types.ts';

const KEYS: BakeoffEnv = { SARVAM_API_KEY: 'secret-s', ELEVENLABS_API_KEY: 'secret-e', OPENAI_API_KEY: 'secret-o', INR_PER_USD: 88 };

function item(provider: ProviderId, over: Partial<PlanItem> = {}): PlanItem {
  return {
    sample: { id: 'voice-a', kind: 'voice', path: 'C:\\stt-samples\\voice-notes\\a.ogg' },
    seconds: 60,
    provider,
    model: 'm',
    diarize: false,
    parts: 1,
    state: 'new',
    action: 'send',
    estimateUsd: 1,
    ...over,
  };
}

const ok = { maxUsd: 8, confirmedPrivacy: true };

describe('refusals', () => {
  it('allows a run with keys, the privacy confirmation and an estimate under the cap', () => {
    expect(refusals([item('sarvam'), item('openai')], KEYS, ok)).toEqual([]);
  });

  it('names each missing key by its variable, only for providers with something to send', () => {
    const env: BakeoffEnv = { INR_PER_USD: 88 };
    const out = refusals([item('sarvam'), item('openai', { action: 'skip', estimateUsd: 0 })], env, ok);
    expect(out).toEqual(['SARVAM_API_KEY is not set in .env.']);
  });

  it('refuses an estimate above the cap', () => {
    expect(refusals([item('sarvam', { estimateUsd: 9 })], KEYS, ok)).toEqual(['The estimate ($9.00) is above --max-usd ($8.00).']);
  });

  it('refuses without the privacy confirmation and lists the checklist', () => {
    const out = refusals([item('elevenlabs')], KEYS, { maxUsd: 8, confirmedPrivacy: false });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('--confirm-privacy');
    for (const line of PRIVACY_CHECKLIST) expect(out[0]).toContain(line);
  });

  it('refuses when there is nothing to send', () => {
    expect(refusals([item('sarvam', { action: 'skip', estimateUsd: 0 })], KEYS, ok)[0]).toMatch(/^Nothing to send/);
  });

  it('never repeats a key value', () => {
    const out = refusals([item('sarvam', { estimateUsd: 99 })], KEYS, { maxUsd: 8, confirmedPrivacy: false }).join('\n');
    expect(out).not.toMatch(/secret-/);
  });
});
