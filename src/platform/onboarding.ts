import type { Sql } from '../store/engine/types.ts';
import type { Clock } from '../util/clock.ts';
import { getTenant, platformAudit, setTenantStatus, type TenantStatus } from './store.ts';

// The customer's first dashboard: the onboarding checklist (SaaS design section 6). Six steps; WhatsApp and the
// Anthropic key are needed, the spare number is optional, and the rest unlock once those two are done. A customer moves
// from onboarding to active when both needed steps are done (once, audited).
// Each step's state comes from a probe. The per-customer runtimes that make the steps real (S4) do not exist yet, so the
// default probe says every step is coming; S4 plugs real probes in (hookups doc).

export const STEP_IDS = ['whatsapp', 'key', 'spare', 'drive', 'groups', 'report'] as const;
export type StepId = (typeof STEP_IDS)[number];

/** What a probe knows about a step: done, still to do, or not built yet. */
export type ProbeState = 'done' | 'todo' | 'coming';
/** As the checklist shows it: a probe's state, or locked (waiting for WhatsApp and the key). */
export type StepState = ProbeState | 'locked';

export interface StepInfo {
  id: StepId;
  title: string;
  text: string;
  /** Needed for the workspace to start (WhatsApp, the key). */
  need: boolean;
  optional: boolean;
  /** What the step will do, said while it is still coming. */
  coming: string;
}

export const STEPS: readonly StepInfo[] = Object.freeze([
  { id: 'whatsapp', title: 'Connect WhatsApp', text: 'Link the WhatsApp number that is in your client groups. WA Agent only reads.', need: true, optional: false,
    coming: 'A QR code to scan from WhatsApp, Linked devices, on the phone that is in your client groups.' },
  { id: 'key', title: 'Add your Anthropic API key', text: 'Your own key pays for the AI that reads your messages. AI work starts after this.', need: true, optional: false,
    coming: 'Paste your key from console.anthropic.com. It is tested with one tiny call, stored encrypted for your workspace, and never shown again.' },
  { id: 'spare', title: 'Add the spare number', text: 'A second phone that sends you the morning report.', need: false, optional: true,
    coming: 'A QR code for a second phone, which sends you the morning report on WhatsApp.' },
  { id: 'drive', title: 'Connect Google Drive', text: 'Your own Google account keeps your tracker, Tracker.xlsx.', need: false, optional: false,
    coming: 'Connect your own Google account. WA Agent can only create and update its own files there.' },
  { id: 'groups', title: 'Approve groups', text: 'Choose which WhatsApp groups are client groups.', need: false, optional: false,
    coming: 'Tick your client groups (several at once) and approve them; their last 7 days are read.' },
  { id: 'report', title: 'Set the morning report time', text: 'When the daily summary reaches you.', need: false, optional: false,
    coming: 'Pick the time and days the morning report reaches you.' },
]);

/** Tells a step's state for a customer. */
export interface OnboardingProbes {
  state(tenantId: string, step: StepId): Promise<ProbeState>;
}

/** Until the customer workspace (S4): every step is coming. */
export const COMING_PROBES: OnboardingProbes = { state: async () => 'coming' };

export interface OnboardingView {
  tenantId: string;
  business: string;
  status: TenantStatus;
  steps: (StepInfo & { state: StepState })[];
  done: number;
  total: number;
  /** WhatsApp and the key are both done: the workspace is reading. */
  live: boolean;
  /** This call moved the customer from onboarding to active (the caller pokes the Supervisor). */
  activated: boolean;
  /** What works now (the "What works now" list). */
  works: { saving: boolean; ai: boolean; screens: boolean; tracker: boolean; report: boolean };
}

/**
 * The checklist for a customer, or null when there is no such customer. When WhatsApp and the key are both done and
 * the customer is still onboarding, it becomes active (once: a second look changes nothing), with an audit line.
 */
export async function onboardingFor(d: { db: Sql; clock: Clock }, tenantId: string, probes: OnboardingProbes = COMING_PROBES): Promise<OnboardingView | null> {
  const tenant = await getTenant(d.db, tenantId);
  if (!tenant) return null;
  const raw = new Map<StepId, ProbeState>();
  for (const s of STEPS) raw.set(s.id, await probes.state(tenantId, s.id));
  const live = raw.get('whatsapp') === 'done' && raw.get('key') === 'done';
  let status = tenant.status;
  let activated = false;
  if (live && status === 'onboarding') {
    const at = d.clock.now().toISOString();
    const moved = await d.db.tx(async (q) => {
      const ok = await setTenantStatus(q, tenantId, ['onboarding'], 'active', at);
      if (ok) await platformAudit(q, { at, actor: 'platform', event: 'tenant.active', tenantId, detail: tenant.name });
      return ok;
    });
    if (moved) {
      status = 'active';
      activated = true;
    }
  }
  const steps = STEPS.map((s) => ({ ...s, state: (!s.need && !live ? 'locked' : raw.get(s.id)!) as StepState }));
  const done = [...raw.values()].filter((x) => x === 'done').length;
  const isDone = (id: StepId) => raw.get(id) === 'done';
  return {
    tenantId, business: tenant.name, status, steps, done, total: STEPS.length, live, activated,
    works: {
      saving: isDone('whatsapp'), ai: live, screens: live, tracker: live && isDone('drive'), report: live && isDone('spare') && isDone('report'),
    },
  };
}
