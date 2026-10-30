import { mkdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { FOUNDER_TENANT_ID, type Env } from '../config/env.ts';
import { sttEnvFor } from './customerRuntime.ts';

// A customer's profile (SaaS Phase B, docs/superpowers/plans/2026-10-30-phase-b.md): the env a customer's runtime is
// built with. DENY BY DEFAULT: only the keys in CUSTOMER_KEYS are copied from the founder's env; every other key (the
// founder's Claude and speech keys, the groups file, the report, the heartbeat, UptimeRobot, the owner list, the Google
// client secrets, the database URLs) is absent. Then the customer's own values go in: its data folder
// (DATA_DIR/tenants/<id>), its id, its Claude key when it has one, and the D2 speech settings. Report, meetings, invites,
// the platform and the assistant are off. Not built with parseEnv: its defaults would bring founder paths back (the
// groups file).

/** What a customer's runtime may read of the founder's env, as is: the machine and the model, nothing of the founder's. */
export const CUSTOMER_KEYS = [
  'DB_ENGINE', 'LOG_LEVEL',
  'AI_MODEL', 'AI_EFFORT', 'AI_PRICE_INPUT_PER_MTOK', 'AI_PRICE_OUTPUT_PER_MTOK', 'AI_PRICE_CACHE_READ_PER_MTOK', 'AI_PRICE_CACHE_WRITE_PER_MTOK', 'INR_PER_USD',
  'QUIET_MINUTES', 'MAX_WAIT_MINUTES', 'MAX_PARALLEL_CLIENTS',
  'DASHBOARD_ENABLED', 'DASHBOARD_PORT', 'DASHBOARD_PUBLIC_URL',
  // The Mac's local speech engine and ffmpeg (paths on this machine, no key), and the voice-note limit.
  'STT_LOCAL_ENGINE', 'STT_LOCAL_BIN', 'STT_LOCAL_MODEL', 'STT_LOCAL_THREADS', 'STT_LOCAL_TIMEOUT_SECONDS', 'STT_LOCAL_LANGUAGE', 'STT_MAX_SECONDS', 'FFMPEG_PATH',
] as const satisfies readonly (keyof Env)[];

/** Set to off for every customer runtime (Phase B): its own settings for these come later. */
const OFF = { REPORT_ENABLED: false, MEETINGS_ENABLED: false, INVITES_GMAIL: false, PLATFORM_ENABLED: false, DASHBOARD_ASSISTANT: false } as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The customer's data folder: DATA_DIR/tenants/<id>, refused unless the id is a customer id and the path stays inside. */
export function customerDataDir(dataDir: string, tenantId: string): string {
  if (!UUID.test(tenantId) || tenantId === FOUNDER_TENANT_ID) throw new Error('A customer data folder needs a customer id (a UUID, not the founder).');
  const root = resolve(dataDir, 'tenants');
  const dir = resolve(root, tenantId);
  const inside = relative(root, dir);
  if (inside === '' || inside.startsWith('..') || inside.includes(sep) || resolve(root, inside) !== dir) {
    throw new Error('A customer data folder must be directly inside DATA_DIR/tenants.');
  }
  return dir;
}

/**
 * The customer's env (deny by default). aiKey: the customer's own Anthropic key (AiKeys.load()), or null: then the env
 * has no ANTHROPIC_API_KEY at all, and the Supervisor keeps that customer in its setup shell.
 */
export function customerProfile(env: Env, o: { tenantId: string; aiKey: string | null; makeDir?: boolean }): Env {
  const dataDir = customerDataDir(env.DATA_DIR, o.tenantId);
  if (o.makeDir !== false) mkdirSync(join(dataDir), { recursive: true, mode: 0o700 });
  const copied: Partial<Record<keyof Env, unknown>> = {};
  for (const k of CUSTOMER_KEYS) if (env[k] !== undefined) copied[k] = env[k];
  // Only the two speech settings are read here: a spread of the founder's env would read every key, its secrets too.
  const speech = sttEnvFor({ ...copied, STT_PROVIDER: env.STT_PROVIDER, VOICE_STT_PROVIDER: env.VOICE_STT_PROVIDER } as Env, false);
  const out: Partial<Record<keyof Env, unknown>> = {
    ...copied,
    ...OFF,
    DATA_DIR: dataDir,
    TENANT_ID: o.tenantId,
    STT_PROVIDER: speech.STT_PROVIDER,
    VOICE_STT_PROVIDER: speech.VOICE_STT_PROVIDER,
    ...(o.aiKey ? { ANTHROPIC_API_KEY: o.aiKey } : {}),
  };
  // Absent, not undefined-valued: `'K' in env` is false for every key not set above.
  return out as Env;
}
