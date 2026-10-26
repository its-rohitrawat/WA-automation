import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { DomainSchema } from './domains.ts';
import type { ReportSettings } from '../report/types.ts';

const Flag = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

/** YYYY-MM-DD that is a real calendar day (not 2026-02-30). */
function isRealDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
/** 91, then a 10-digit Indian mobile (starts 6-9). The owner's decision: the report goes only to an Indian number. */
export const INDIAN_MOBILE = /^91[6-9]\d{9}$/;

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
  // Meetings (Phase 3). Off means no Google meeting call at all.
  MEETINGS_ENABLED: Flag.default(false),
  // Our own domains, so internal meetings are recognised. Public mail domains would match everyone.
  TEAM_EMAIL_DOMAINS: z
    .string()
    .transform((s) => s.split(',').map((d) => d.trim()).filter((d) => d !== ''))
    .pipe(z.array(DomainSchema).min(1))
    .transform((ds) => [...new Set(ds)])
    .default([]),
  MEETING_POLL_MINUTES: z.coerce.number().int().min(2).max(60).default(5),
  MEETING_MAX_MINUTES: z.coerce.number().int().min(10).max(300).default(180),
  MEETINGS_SINCE: z.string().refine(isRealDate, 'must be a real date written YYYY-MM-DD').optional(),
  FFMPEG_PATH: z.string().min(1).optional(),
  // Speech-to-text, shared by voice notes (Phase 2b) and meetings.
  STT_PROVIDER: z.enum(['sarvam', 'elevenlabs', 'openai', 'none']).default('none'),
  STT_API_KEY: z.string().min(1).optional(),
  // A sane band: a typo such as 8800 would make every Sarvam estimate 100 times too small. Zod 4 numbers refuse Infinity.
  INR_PER_USD: z.coerce.number().min(40).max(200).default(88),
  /** Longest voice note or audio file sent to speech-to-text, in seconds, measured from the file size (Phase 2b V5, N3). */
  STT_MAX_SECONDS: z.coerce.number().int().min(30).max(900).default(600),
  // Voice notes only (Phase 2b amendment, local speech-to-text). Meetings keep STT_PROVIDER. A paid value here must be
  // the same as STT_PROVIDER, since both use the one STT_API_KEY; local needs no key.
  VOICE_STT_PROVIDER: z.enum(['local', 'sarvam', 'elevenlabs', 'openai', 'none']).default('none'),
  /** The open-source model run on this machine: voxtral and qwen3-asr through transcribe.cpp, whisper through whisper.cpp. */
  STT_LOCAL_ENGINE: z.enum(['voxtral', 'qwen3-asr', 'whisper']).default('voxtral'),
  /** Absolute path to transcribe-cli (voxtral, qwen3-asr) or whisper-cli (whisper). Required for local. */
  STT_LOCAL_BIN: z.string().min(1).optional(),
  /** Absolute path to the model file. Required for local. */
  STT_LOCAL_MODEL: z.string().min(1).optional(),
  STT_LOCAL_THREADS: z.coerce.number().int().min(1).max(64).default(8),
  /** Longest one run of the engine may take, in seconds. */
  STT_LOCAL_TIMEOUT_SECONDS: z.coerce.number().int().min(60).max(7200).default(1800),
  /** Passed to voxtral (not for auto) and whisper; qwen3-asr always detects the language itself. */
  STT_LOCAL_LANGUAGE: z.enum(['hi', 'en', 'auto']).default('hi'),
  // Phase 2c morning report. Off unless REPORT_ENABLED is exactly "true".
  REPORT_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  REPORT_TIME: z.string().regex(HHMM).default('06:00'),
  REPORT_DEADLINE: z.string().regex(HHMM).default('12:00'),
  /** The founder's number: 91 and the 10-digit mobile, digits only. Personal data: never logged in full. */
  REPORT_RECIPIENT: z.string().regex(INDIAN_MOBILE).optional(),
}).superRefine((env, ctx) => {
  if (env.MEETINGS_ENABLED && env.TEAM_EMAIL_DOMAINS.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['TEAM_EMAIL_DOMAINS'], message: 'is required when MEETINGS_ENABLED is true' });
  }
  if (env.STT_PROVIDER !== 'none' && !env.STT_API_KEY) {
    ctx.addIssue({ code: 'custom', path: ['STT_API_KEY'], message: 'is required when STT_PROVIDER is not none' });
  }
  if (env.VOICE_STT_PROVIDER !== 'local' && env.VOICE_STT_PROVIDER !== 'none' && env.VOICE_STT_PROVIDER !== env.STT_PROVIDER) {
    ctx.addIssue({ code: 'custom', path: ['VOICE_STT_PROVIDER'], message: 'must be local, none or the same as STT_PROVIDER' });
  }
  // Checked only for local: a stray path while voice notes are off or paid must not stop the service.
  if (env.VOICE_STT_PROVIDER === 'local') {
    for (const name of ['STT_LOCAL_BIN', 'STT_LOCAL_MODEL'] as const) {
      const path = env[name];
      if (path === undefined) {
        ctx.addIssue({ code: 'custom', path: [name], message: 'is required when VOICE_STT_PROVIDER is local' });
      } else if (!isAbsolute(path)) {
        ctx.addIssue({ code: 'custom', path: [name], message: 'must be an absolute path when VOICE_STT_PROVIDER is local' });
      }
    }
  }
  if (env.REPORT_ENABLED && !env.REPORT_RECIPIENT) {
    ctx.addIssue({ code: 'custom', path: ['REPORT_RECIPIENT'], message: 'required when REPORT_ENABLED is true' });
  }
  if (env.REPORT_TIME >= env.REPORT_DEADLINE) {
    ctx.addIssue({ code: 'custom', path: ['REPORT_DEADLINE'], message: 'must be later than REPORT_TIME' });
  }
});

export type Env = z.infer<typeof EnvSchema>;

export function parseEnv(source: Record<string, string | undefined>): Env {
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ''));
  const result = EnvSchema.safeParse(cleaned);
  if (!result.success) {
    // Variable names only. Never include values: they may be secrets.
    const names = [...new Set(result.error.issues.map((i) => String(i.path[0] ?? 'settings')))];
    // Custom issues come only from this file's rules and DomainSchema, whose messages never contain a value.
    const hints = [...new Set(result.error.issues.filter((i) => i.code === 'custom').map((i) => `${String(i.path[0])} ${i.message}`))];
    throw new Error(`Invalid configuration in: ${names.join(', ')}${hints.map((h) => `. ${h}`).join('')}`);
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

export function requireKey(env: Env, name: 'ANTHROPIC_API_KEY' | 'GOOGLE_OAUTH_CLIENT_ID' | 'GOOGLE_OAUTH_CLIENT_SECRET' | 'STT_API_KEY'): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

export function reportSettings(env: Env): ReportSettings {
  return { enabled: env.REPORT_ENABLED, time: env.REPORT_TIME, deadline: env.REPORT_DEADLINE };
}

/** The founder's number (digits only). parseEnv already refuses REPORT_ENABLED=true without it. */
export function reportRecipient(env: Env): string {
  if (!env.REPORT_RECIPIENT) throw new Error('REPORT_RECIPIENT is not configured');
  return env.REPORT_RECIPIENT;
}

/** For logs and screens: only the last 4 digits of a phone number. */
export function maskNumber(digits: string): string {
  return `…${digits.slice(-4)}`;
}
