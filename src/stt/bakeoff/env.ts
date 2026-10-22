import { z } from 'zod';
import type { ProviderId } from '../types.ts';

const BakeoffEnvSchema = z.object({
  SARVAM_API_KEY: z.string().min(1).optional(),
  ELEVENLABS_API_KEY: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  FFMPEG_PATH: z.string().min(1).optional(),
  STT_SAMPLES_DIR: z.string().min(1).optional(),
  INR_PER_USD: z.coerce.number().positive().default(88),
});

export type BakeoffEnv = z.infer<typeof BakeoffEnvSchema>;

export const KEY_NAMES = {
  sarvam: 'SARVAM_API_KEY',
  elevenlabs: 'ELEVENLABS_API_KEY',
  openai: 'OPENAI_API_KEY',
} as const satisfies Record<ProviderId, keyof BakeoffEnv>;

export function parseBakeoffEnv(source: Record<string, string | undefined>): BakeoffEnv {
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ''));
  const result = BakeoffEnvSchema.safeParse(cleaned);
  if (!result.success) {
    // Variable names only. Never include values: they may be secrets.
    const names = [...new Set(result.error.issues.map((i) => i.path.map(String).join('.')))];
    throw new Error(`Invalid configuration in: ${names.join(', ')}`);
  }
  return result.data;
}

/** The bake-off settings from .env in the current folder (the worktree root), then from the process environment. */
export function loadBakeoffEnv(file = '.env'): BakeoffEnv {
  try {
    process.loadEnvFile(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  return parseBakeoffEnv(process.env);
}
