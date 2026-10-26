import { describe, expect, it } from 'vitest';
import { costUsd, modelFor } from '../../src/stt/prices.ts';

describe('modelFor', () => {
  it('uses saaras:v4 with the rupee price for speaker labels on meetings', () => {
    expect(modelFor('sarvam', true)).toMatchObject({ model: 'saaras:v4', perHour: 36, currency: 'INR' });
    expect(modelFor('sarvam', false)).toMatchObject({ model: 'saaras:v4', perHour: 30, currency: 'INR' });
  });

  it('uses scribe_v2 at one price either way', () => {
    expect(modelFor('elevenlabs', true)).toMatchObject({ model: 'scribe_v2', perHour: 0.22, currency: 'USD' });
    expect(modelFor('elevenlabs', false).perHour).toBe(0.22);
  });

  it('switches OpenAI to the diarize model only for meetings', () => {
    expect(modelFor('openai', false)).toMatchObject({ model: 'gpt-transcribe', perHour: 0.27, currency: 'USD' });
    expect(modelFor('openai', true)).toMatchObject({ model: 'gpt-4o-transcribe-diarize', perHour: 0.36, currency: 'USD' });
  });
});

describe('costUsd', () => {
  it('prices dollars per hour of audio', () => {
    expect(costUsd(modelFor('elevenlabs', true), 1800, 88)).toBeCloseTo(0.11, 10);
  });

  it('converts rupee prices at the given rate', () => {
    // One hour with speaker labels: ₹36 at ₹90 to the dollar is $0.40.
    expect(costUsd(modelFor('sarvam', true), 3600, 90)).toBeCloseTo(0.4, 10);
  });
});
