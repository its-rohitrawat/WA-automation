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

/** "HH:MM", 00:00 to 23:59. */
export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
/** 91, then a 10-digit Indian mobile (starts 6-9). The owner's decision: the report goes only to an Indian number. */
export const INDIAN_MOBILE = /^91[6-9]\d{9}$/;

/**
 * https anywhere, or plain http only on this machine and with an explicit port (http://localhost:8787).
 * Never a user name or password: the value becomes links and redirects, so credentials in it would leak.
 */
/** Customer #1, the founder's business: the fixed id S2's P1 seeds and src/platform/store.ts's FOUNDER_TENANT_ID. */
export const FOUNDER_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A Postgres URL on this machine only (design 10): postgres:// or postgresql:// to 127.0.0.1, localhost or ::1. */
function isLocalPgUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return (u.protocol === 'postgres:' || u.protocol === 'postgresql:') && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
}

function isDashboardUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.username !== '' || u.password !== '') return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1') && u.port !== '';
}

const EnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  AI_MODEL: z.string().default('claude-opus-5-5'),
  AI_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  AI_PRICE_INPUT_PER_MTOK: z.coerce.number().positive().default(4),
  AI_PRICE_OUTPUT_PER_MTOK: z.coerce.number().positive().default(20),
  AI_PRICE_CACHE_WRITE_PER_MTOK: z.coerce.number().positive().default(5),
  AI_PRICE_CACHE_READ_PER_MTOK: z.coerce.number().positive().default(0.2),
  DAILY_SPEND_CAP_USD: z.coerce.number().positive().default(15),
  /**
   * The platform-wide daily ceiling (S4.3, owner decision D3), over spend billed to the founder only: the founder's
   * Claude calls and any later founder-paid service. Customers use their own Anthropic key under their own limit.
   */
  PLATFORM_DAILY_SPEND_CAP_USD: z.coerce.number().positive().default(100),
  /** The founder's name on invite emails and the sign-up page (SaaS S5). */
  PLATFORM_FOUNDER_NAME: z.string().min(1).max(100).default('WA Agent'),
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
  // Speech-to-text, shared by voice notes (Phase 2b) and meetings. local: meetings go through the local engine on this
  // machine (STT_LOCAL_*), with no key and no spend.
  STT_PROVIDER: z.enum(['local', 'sarvam', 'elevenlabs', 'openai', 'none']).default('none'),
  STT_API_KEY: z.string().min(1).optional(),
  // A sane band: a typo such as 8800 would make every Sarvam estimate 100 times too small. Zod 4 numbers refuse Infinity.
  INR_PER_USD: z.coerce.number().min(40).max(200).default(88),
  /** Longest voice note or audio file sent to speech-to-text, in seconds, measured on the converted audio (Phase 2b V5, N3). */
  STT_MAX_SECONDS: z.coerce.number().int().min(30).max(900).default(600),
  // Voice notes only (Phase 2b amendment, local speech-to-text); meetings use STT_PROVIDER. A paid value here must be
  // the same as STT_PROVIDER, since both use the one STT_API_KEY; local needs no key.
  VOICE_STT_PROVIDER: z.enum(['local', 'sarvam', 'elevenlabs', 'openai', 'none']).default('none'),
  /** The open-source model run on this machine: voxtral and qwen3-asr through transcribe.cpp, whisper through whisper.cpp. */
  STT_LOCAL_ENGINE: z.enum(['voxtral', 'qwen3-asr', 'whisper']).default('voxtral'),
  /** Absolute path to transcribe-cli (voxtral, qwen3-asr) or whisper-cli (whisper). Required when STT_PROVIDER or VOICE_STT_PROVIDER is local. */
  STT_LOCAL_BIN: z.string().min(1).optional(),
  /** Absolute path to the model file. Required when STT_PROVIDER or VOICE_STT_PROVIDER is local. */
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
  /** The IST days the report goes out: weekdays (Monday to Friday), mon-sat or daily. */
  REPORT_DAYS: z.enum(['weekdays', 'mon-sat', 'daily']).default('weekdays'),
  /** The founder's number: 91 and the 10-digit mobile, digits only. Personal data: never logged in full. */
  REPORT_RECIPIENT: z.string().regex(INDIAN_MOBILE).optional(),
  /** Uptime heartbeat link (an UptimeRobot heartbeat monitor). Secret: never logged. Off when empty. */
  HEARTBEAT_URL: z
    .string()
    .url()
    .refine((u) => u.startsWith('https://'), { message: 'must be an https:// link' })
    .optional(),
  // Owner dashboard (D1). Off unless DASHBOARD_ENABLED is true. The server listens on 127.0.0.1 only.
  DASHBOARD_ENABLED: Flag.default(false),
  /** The dashboard's AI assistant (owner request, 29 Oct 2026): on with the dashboard unless set to false. Its answers are paid calls under DAILY_SPEND_CAP_USD. */
  DASHBOARD_ASSISTANT: Flag.default(true),
  /**
   * Invites sent from the founder's Gmail (SaaS S5H.3). Off: invites go by Copy link. On, the main Google connect also
   * asks for gmail.send, which Google allows only for the app's test users until it reviews the app.
   */
  INVITES_GMAIL: Flag.default(false),
  DASHBOARD_PORT: z.coerce.number().int().min(1024).max(65535).default(8787),
  /**
   * The address owners open: https, or http on this machine (localhost or 127.0.0.1 with a port). Kept as its origin
   * only (lower-case scheme and host, no path or trailing slash), so it can be compared with a browser's Origin header.
   */
  DASHBOARD_PUBLIC_URL: z
    .string()
    .url()
    .refine(isDashboardUrl, { message: 'must be an https:// link or http://localhost:<port>, with no user name or password' })
    .transform((s) => new URL(s).origin)
    .optional(),
  /** Google accounts that may sign in: trimmed, lower-cased, without repeats. Personal data: never logged. */
  DASHBOARD_OWNER_EMAILS: z
    .string()
    .transform((s) => s.split(',').map((e) => e.trim().toLowerCase()).filter((e) => e !== ''))
    .pipe(z.array(z.email()))
    .transform((es) => [...new Set(es)])
    .default([]),
  /** The dashboard's own Google web OAuth client (not the desktop one). Secret: never logged. */
  DASHBOARD_GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  DASHBOARD_GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  /** UptimeRobot read-only API key, for the uptime history. Secret: never logged. */
  UPTIMEROBOT_READ_KEY: z.string().min(1).optional(),
  // SaaS S2: where the agent's data lives. sqlite (the default): data/tracker.db, as before. postgres: the server on
  // this machine, every customer's rows under row-level security.
  DB_ENGINE: z.enum(['sqlite', 'postgres']).default('sqlite'),
  /** wa_app's URL, the agent's only role for customer data. Secret: never logged. Required, and local only, with postgres. */
  DATABASE_URL: z.string().min(1).optional(),
  /** wa_platform's URL, for the platform tables (decision D1). Secret: never logged. Required with postgres. */
  DATABASE_PLATFORM_URL: z.string().min(1).optional(),
  /** wa_owner's URL, read only by db-migrate. Secret: never logged. */
  DATABASE_OWNER_URL: z.string().min(1).optional(),
  /** The customer this agent runs as on Postgres: customer #1 by default. */
  TENANT_ID: z.string().regex(UUID).default(FOUNDER_TENANT_ID),
}).superRefine((env, ctx) => {
  // The URLs hold passwords: the messages name the setting, never its value.
  for (const name of ['DATABASE_URL', 'DATABASE_PLATFORM_URL', 'DATABASE_OWNER_URL'] as const) {
    const url = env[name];
    if (url !== undefined && !isLocalPgUrl(url)) {
      ctx.addIssue({ code: 'custom', path: [name], message: 'must be a postgres:// URL to 127.0.0.1 or localhost (the database stays on this machine)' });
    }
  }
  if (env.DB_ENGINE === 'postgres') {
    for (const name of ['DATABASE_URL', 'DATABASE_PLATFORM_URL'] as const) {
      if (env[name] === undefined) ctx.addIssue({ code: 'custom', path: [name], message: 'is required when DB_ENGINE is postgres' });
    }
  }
  if (env.MEETINGS_ENABLED && env.TEAM_EMAIL_DOMAINS.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['TEAM_EMAIL_DOMAINS'], message: 'is required when MEETINGS_ENABLED is true' });
  }
  if (env.STT_PROVIDER !== 'none' && env.STT_PROVIDER !== 'local' && !env.STT_API_KEY) {
    ctx.addIssue({ code: 'custom', path: ['STT_API_KEY'], message: 'is required when STT_PROVIDER is not none or local' });
  }
  if (env.VOICE_STT_PROVIDER !== 'local' && env.VOICE_STT_PROVIDER !== 'none' && env.VOICE_STT_PROVIDER !== env.STT_PROVIDER) {
    ctx.addIssue({ code: 'custom', path: ['VOICE_STT_PROVIDER'], message: 'must be local, none or the same as STT_PROVIDER' });
  }
  // Checked only for local (meetings, voice notes or both): a stray path while neither is local must not stop the
  // service. The message names the setting that asks for the engine, never a value.
  const localFor = [env.STT_PROVIDER === 'local' && 'STT_PROVIDER', env.VOICE_STT_PROVIDER === 'local' && 'VOICE_STT_PROVIDER'].filter(
    (n) => n !== false,
  );
  if (localFor.length > 0) {
    const when = `when ${localFor.join(' and ')} ${localFor.length > 1 ? 'are' : 'is'} local`;
    for (const name of ['STT_LOCAL_BIN', 'STT_LOCAL_MODEL'] as const) {
      const path = env[name];
      if (path === undefined) {
        ctx.addIssue({ code: 'custom', path: [name], message: `is required ${when}` });
      } else if (!isAbsolute(path)) {
        ctx.addIssue({ code: 'custom', path: [name], message: `must be an absolute path ${when}` });
      }
    }
  }
  if (env.REPORT_ENABLED && !env.REPORT_RECIPIENT) {
    ctx.addIssue({ code: 'custom', path: ['REPORT_RECIPIENT'], message: 'required when REPORT_ENABLED is true' });
  }
  if (env.REPORT_TIME >= env.REPORT_DEADLINE) {
    ctx.addIssue({ code: 'custom', path: ['REPORT_DEADLINE'], message: 'must be later than REPORT_TIME' });
  }
  if (env.DASHBOARD_ENABLED) {
    if (env.DASHBOARD_OWNER_EMAILS.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['DASHBOARD_OWNER_EMAILS'], message: 'is required when DASHBOARD_ENABLED is true' });
    }
    for (const name of ['DASHBOARD_GOOGLE_CLIENT_ID', 'DASHBOARD_GOOGLE_CLIENT_SECRET'] as const) {
      if (!env[name]) ctx.addIssue({ code: 'custom', path: [name], message: 'is required when DASHBOARD_ENABLED is true' });
    }
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
  return { enabled: env.REPORT_ENABLED, time: env.REPORT_TIME, deadline: env.REPORT_DEADLINE, days: env.REPORT_DAYS };
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
