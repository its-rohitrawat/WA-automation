import type { Sql } from '../store/engine/types.ts';
import type { Clock } from '../util/clock.ts';
import { PlatformError } from './errors.ts';
import { COMING_PROBES, STEPS, type OnboardingProbes, type ProbeState } from './onboarding.ts';
import { getTenant, listTenants, platformAudit, setTenantStatus, type TenantStatus } from './store.ts';

// The founder's Customers screen (SaaS design section 4.3): each customer's name, status, onboarding step, last
// activity, memory and AI key state. Setup and health only: this reads the platform tables and the onboarding probes,
// never a customer's messages, tasks, files or keys. Pause and Resume change the status (the Supervisor, S4, stops or
// starts that customer's runtime); the founder's own business is never paused.

/** Active customers this Mac runs at most (design 7: a setting; 20 to start). */
export const MAX_ACTIVE_DEFAULT = 20;

/** What the S4 runtimes will report; null until they exist. */
export interface CustomerHealth {
  memoryMb(tenantId: string): number | null;
  /** The customer's runtime state as the Supervisor reports it ('running', 'backoff', 'refused:limit', …); null: none. */
  runtime?(tenantId: string): string | null;
}
export const NO_HEALTH: CustomerHealth = { memoryMb: () => null };

export interface CustomerRow {
  id: string;
  name: string;
  founder: boolean;
  status: TenantStatus;
  createdAt: string;
  signedUpAt: string | null;
  updatedAt: string;
  lastActivityAt: string | null;
  /** null while invited (not signed up); else steps done, of how many, and the next one's title. */
  onboarding: { done: number; total: number; next: string | null } | null;
  memoryMb: number | null;
  /** From the key step: configured, missing, or null when that part is not built yet. */
  aiKey: 'configured' | 'missing' | null;
  /** The Supervisor's state for this customer's runtime (CustomerHealth.runtime); null: none, or not wired in yet. */
  runtime: string | null;
}

export interface CustomersView {
  customers: CustomerRow[];
  maxActive: number;
  counts: { active: number; onboarding: number; invited: number; paused: number };
  /** Total over active customers, or null when no runtime reports memory yet. */
  memoryMb: number | null;
}

export interface CustomersDeps {
  db: Sql;
  clock: Clock;
  probes?: OnboardingProbes;
  health?: CustomerHealth;
  maxActive?: number;
}

async function stepStates(d: CustomersDeps, tenantId: string): Promise<Map<string, ProbeState>> {
  const probes = d.probes ?? COMING_PROBES;
  const out = new Map<string, ProbeState>();
  for (const s of STEPS) out.set(s.id, await probes.state(tenantId, s.id));
  return out;
}

export async function listCustomers(d: CustomersDeps): Promise<CustomersView> {
  const health = d.health ?? NO_HEALTH;
  const rows: CustomerRow[] = [];
  for (const t of await listTenants(d.db)) {
    const founder = t.kind === 'founder';
    const states = founder || t.status === 'invited' ? null : await stepStates(d, t.id);
    const next = states ? STEPS.find((s) => states.get(s.id) !== 'done') : undefined;
    const key = states?.get('key');
    rows.push({
      id: t.id, name: t.name, founder, status: t.status, createdAt: t.createdAt, signedUpAt: t.signedUpAt, updatedAt: t.updatedAt, lastActivityAt: t.lastActivityAt,
      onboarding: states ? { done: [...states.values()].filter((x) => x === 'done').length, total: STEPS.length, next: next?.title ?? null } : null,
      memoryMb: t.status === 'active' ? health.memoryMb(t.id) : null,
      aiKey: founder ? 'configured' : key === 'done' ? 'configured' : key === 'todo' ? 'missing' : null,
      runtime: health.runtime?.(t.id) ?? null,
    });
  }
  const count = (s: TenantStatus) => rows.filter((r) => r.status === s).length;
  const mem = rows.map((r) => r.memoryMb).filter((m): m is number => typeof m === 'number');
  return {
    customers: rows, maxActive: d.maxActive ?? MAX_ACTIVE_DEFAULT,
    counts: { active: count('active'), onboarding: count('onboarding'), invited: count('invited'), paused: count('paused') },
    memoryMb: mem.length ? mem.reduce((a, b) => a + b, 0) : null,
  };
}

/** Pauses an active or onboarding customer (never the founder's own business). */
export async function pauseCustomer(d: CustomersDeps, actor: string, id: string, requestId?: string): Promise<void> {
  const t = await getTenant(d.db, id);
  if (!t) throw new PlatformError(404, 'not_found', 'There is no such customer.');
  if (t.kind === 'founder') throw new PlatformError(409, 'founder', 'Your own business cannot be paused here.');
  const at = d.clock.now().toISOString();
  await d.db.tx(async (q) => {
    if (!(await setTenantStatus(q, id, ['active', 'onboarding'], 'paused', at))) throw new PlatformError(409, 'not_running', 'Only an active or onboarding customer can be paused.');
    await platformAudit(q, { at, actor, event: 'tenant.paused', tenantId: id, detail: t.name, requestId: requestId ?? null });
  });
}

/**
 * Resumes a paused customer: active when WhatsApp and the key are done, else back to onboarding. Refused when that would
 * pass the limit of active customers.
 */
export async function resumeCustomer(d: CustomersDeps, actor: string, id: string, requestId?: string): Promise<TenantStatus> {
  const t = await getTenant(d.db, id);
  if (!t) throw new PlatformError(404, 'not_found', 'There is no such customer.');
  const states = await stepStates(d, id);
  const to: TenantStatus = states.get('whatsapp') === 'done' && states.get('key') === 'done' ? 'active' : 'onboarding';
  const max = d.maxActive ?? MAX_ACTIVE_DEFAULT;
  const at = d.clock.now().toISOString();
  await d.db.tx(async (q) => {
    if (to === 'active') {
      const n = (await q.get<{ n: number }>("SELECT COUNT(*) AS n FROM tenants WHERE status = 'active'"))!.n;
      if (n >= max) throw new PlatformError(409, 'limit', `${max} customers are already active, the most this Mac runs. Pause another first.`);
    }
    if (!(await setTenantStatus(q, id, ['paused'], to, at))) throw new PlatformError(409, 'not_paused', 'Only a paused customer can be resumed.');
    await platformAudit(q, { at, actor, event: 'tenant.resumed', tenantId: id, detail: `${t.name} · ${to}`, requestId: requestId ?? null });
  });
  return to;
}
