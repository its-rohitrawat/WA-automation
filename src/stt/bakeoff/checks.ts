import { KEY_NAMES, type BakeoffEnv } from './env.ts';
import { planTotalUsd, type PlanItem } from './plan.ts';

/** What the owner confirms with --confirm-privacy before any recording leaves the PC. */
export const PRIVACY_CHECKLIST = [
  'ElevenLabs: profile > Terms and privacy > Data use: "Improve the models for everyone" is OFF and saved with "Update your choice".',
  'Sarvam: training on your data is opted out, and the workspace data retention is set to 0 days (by the workspace Owner).',
  "Every meeting recording has its participants' consent, and you may share these voice notes with all three providers.",
];

/** Reasons a real run must not start; empty means it may. Keys are only checked for presence, never read out. */
export function refusals(items: readonly PlanItem[], env: BakeoffEnv, opts: { maxUsd: number; confirmedPrivacy: boolean }): string[] {
  const out: string[] = [];
  const sending = items.filter((i) => i.action !== 'skip');
  if (sending.length === 0) {
    out.push('Nothing to send: every slot already has a result (see --retry-failed and --retry-unknown, or use --report-only).');
    return out;
  }
  const total = planTotalUsd(items);
  if (total > opts.maxUsd) out.push(`The estimate ($${total.toFixed(2)}) is above --max-usd ($${opts.maxUsd.toFixed(2)}).`);
  for (const p of new Set(sending.map((i) => i.provider))) {
    if (!env[KEY_NAMES[p]]) out.push(`${KEY_NAMES[p]} is not set in .env.`);
  }
  if (!opts.confirmedPrivacy) {
    out.push(`Add --confirm-privacy once all of these are true:\n${PRIVACY_CHECKLIST.map((l) => `      - ${l}`).join('\n')}`);
  }
  return out;
}
