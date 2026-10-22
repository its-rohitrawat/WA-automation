import type { ProviderId } from './types.ts';

/** The day the prices below were read from the providers' pricing pages. Re-check before a large run. */
export const PRICES_CHECKED = '2026-10-22';

export interface ModelPrice {
  model: string;
  perHour: number;
  currency: 'USD' | 'INR';
  source: string;
}

/**
 * The model each provider is tested with, and its list price per hour of audio. Sarvam bills in rupees only.
 * OpenAI's only model with speaker labels, gpt-4o-transcribe-diarize, shuts down on 2027-02-26.
 */
export function modelFor(provider: ProviderId, diarize: boolean): ModelPrice {
  switch (provider) {
    case 'sarvam':
      return { model: 'saaras:v4', perHour: diarize ? 36 : 30, currency: 'INR', source: 'https://docs.sarvam.ai/api/getting-started/pricing' };
    case 'elevenlabs':
      return { model: 'scribe_v2', perHour: 0.22, currency: 'USD', source: 'https://elevenlabs.io/pricing/api' };
    case 'openai':
      return diarize
        ? { model: 'gpt-4o-transcribe-diarize', perHour: 0.36, currency: 'USD', source: 'https://developers.openai.com/api/docs/pricing' }
        : { model: 'gpt-transcribe', perHour: 0.27, currency: 'USD', source: 'https://developers.openai.com/api/docs/pricing' };
  }
}

/** List-price cost in US dollars. Rupee prices are converted at inrPerUsd rupees to the dollar. */
export function costUsd(price: ModelPrice, seconds: number, inrPerUsd: number): number {
  const local = (price.perHour * seconds) / 3600;
  return price.currency === 'INR' ? local / inrPerUsd : local;
}
