import type { Env } from '../config/env.ts';

export interface Prices {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheWritePerMTok: number;
  cacheReadPerMTok: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

/** Server-side fallback from Opus 5.5 lands on Opus 5 or Opus 4.8, both priced like this (Anthropic pricing page, checked 2026-10-20). */
export const FALLBACK_PRICES: Prices = { inputPerMTok: 5, outputPerMTok: 25, cacheWritePerMTok: 6.25, cacheReadPerMTok: 0.5 };

export function costUsd(u: TokenUsage, p: Prices): number {
  return (
    (u.inputTokens * p.inputPerMTok +
      u.outputTokens * p.outputPerMTok +
      u.cacheCreationInputTokens * p.cacheWritePerMTok +
      u.cacheReadInputTokens * p.cacheReadPerMTok) /
    1_000_000
  );
}

/** Ceiling estimate: 2 characters per token covers Hinglish and Devanagari, and the output allowance equals the Claude client's max_tokens (thinking counts as output). */
export function estimateCostUsd(promptChars: number, p: Prices, expectedOutputTokens = 16_000): number {
  return (Math.ceil(promptChars / 2) * p.inputPerMTok + expectedOutputTokens * p.outputPerMTok) / 1_000_000;
}

export function pricesFromEnv(env: Env): Prices {
  return {
    inputPerMTok: env.AI_PRICE_INPUT_PER_MTOK,
    outputPerMTok: env.AI_PRICE_OUTPUT_PER_MTOK,
    cacheWritePerMTok: env.AI_PRICE_CACHE_WRITE_PER_MTOK,
    cacheReadPerMTok: env.AI_PRICE_CACHE_READ_PER_MTOK,
  };
}
