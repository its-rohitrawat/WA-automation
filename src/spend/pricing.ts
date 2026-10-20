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

export function costUsd(u: TokenUsage, p: Prices): number {
  return (
    (u.inputTokens * p.inputPerMTok +
      u.outputTokens * p.outputPerMTok +
      u.cacheCreationInputTokens * p.cacheWritePerMTok +
      u.cacheReadInputTokens * p.cacheReadPerMTok) /
    1_000_000
  );
}

/** Hinglish tokenises densely, so assume 3 characters per token and a generous output allowance. */
export function estimateCostUsd(promptChars: number, p: Prices, expectedOutputTokens = 4_000): number {
  return (Math.ceil(promptChars / 3) * p.inputPerMTok + expectedOutputTokens * p.outputPerMTok) / 1_000_000;
}

export function pricesFromEnv(env: Env): Prices {
  return {
    inputPerMTok: env.AI_PRICE_INPUT_PER_MTOK,
    outputPerMTok: env.AI_PRICE_OUTPUT_PER_MTOK,
    cacheWritePerMTok: env.AI_PRICE_CACHE_WRITE_PER_MTOK,
    cacheReadPerMTok: env.AI_PRICE_CACHE_READ_PER_MTOK,
  };
}
