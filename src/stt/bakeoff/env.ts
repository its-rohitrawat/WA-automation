import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { z } from 'zod';
import type { ProviderId } from '../types.ts';

const BakeoffEnvSchema = z.object({
  SARVAM_API_KEY: z.string().min(1).optional(),
  ELEVENLABS_API_KEY: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  FFMPEG_PATH: z.string().min(1).optional(),
  STT_SAMPLES_DIR: z.string().min(1).optional(),
  // A sane band: a typo such as 8800 would make every Sarvam estimate 100 times too small.
  INR_PER_USD: z.coerce.number().finite().min(40).max(200).default(88),
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

/**
 * The bake-off settings: .env first, then the shell for anything the file does not set. The file wins, even with an
 * empty value, so a stray key in the shell (another project's account) is never used. The file is parsed here rather
 * than loaded into process.env, so its keys never reach the environment that ffmpeg inherits.
 */
export function loadBakeoffEnv(file = '.env', source: Record<string, string | undefined> = process.env): BakeoffEnv {
  let fromFile: Record<string, string | undefined> = {};
  try {
    const text = readFileSync(file, 'utf8');
    // Notepad can save a byte-order mark (U+FEFF), which would otherwise become part of the first name.
    fromFile = parseEnv(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  return parseBakeoffEnv({ ...source, ...fromFile });
}
