import { z } from 'zod';

const EnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  AI_MODEL: z.string().default('claude-opus-5-5'),
  AI_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  AI_PRICE_INPUT_PER_MTOK: z.coerce.number().positive().default(4),
  AI_PRICE_OUTPUT_PER_MTOK: z.coerce.number().positive().default(20),
  AI_PRICE_CACHE_WRITE_PER_MTOK: z.coerce.number().positive().default(5),
  AI_PRICE_CACHE_READ_PER_MTOK: z.coerce.number().positive().default(0.2),
  DAILY_SPEND_CAP_USD: z.coerce.number().positive().default(15),
  GOOGLE_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  QUIET_MINUTES: z.coerce.number().positive().default(4),
  MAX_WAIT_MINUTES: z.coerce.number().positive().default(20),
  MAX_PARALLEL_CLIENTS: z.coerce.number().int().positive().default(3),
  DATA_DIR: z.string().default('data'),
  GROUPS_FILE: z.string().default('config/allowed-groups.json'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Env = z.infer<typeof EnvSchema>;

export function parseEnv(source: Record<string, string | undefined>): Env {
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ''));
  const result = EnvSchema.safeParse(cleaned);
  if (!result.success) {
    // Variable names only. Never include values: they may be secrets.
    const names = [...new Set(result.error.issues.map((i) => i.path.map(String).join('.')))];
    throw new Error(`Invalid configuration in: ${names.join(', ')}`);
  }
  return result.data;
}

export function loadEnv(file = '.env'): Env {
  try {
    process.loadEnvFile(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  return parseEnv(process.env);
}

export function requireKey(env: Env, name: 'ANTHROPIC_API_KEY' | 'GOOGLE_OAUTH_CLIENT_ID' | 'GOOGLE_OAUTH_CLIENT_SECRET'): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}
