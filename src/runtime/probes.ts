import type { CustomerHealth } from '../platform/customers.ts';
import type { OnboardingProbes, ProbeState, StepId } from '../platform/onboarding.ts';
import type { RuntimeFacts, RuntimeState } from './supervisor.ts';

// What the platform screens read from the customer runtimes (plan 2026-10-29-saas-s3-s6.md, task S4.9; hookups 5.2 and
// 6.1): each onboarding step from the runtime's own setup facts, each customer's runtime state, and memory as a share.
// One Node process cannot measure one customer's memory (decision D4): a running customer's figure is an even share of
// what the runtimes added on top of the process's memory before any of them started.

/** What the probes need of the Supervisor. */
export interface ProbeSource {
  facts(id: string): RuntimeFacts | null;
  states(): ReadonlyMap<string, RuntimeState>;
}

const DONE: Record<StepId, (f: RuntimeFacts) => boolean> = {
  whatsapp: (f) => f.whatsappLinked,
  key: (f) => f.aiKey === 'configured',
  spare: (f) => f.spareLinked,
  drive: (f) => f.driveConnected,
  groups: (f) => f.groupsApproved > 0,
  report: (f) => f.reportTimeSet,
};

/** Each step: done or to do while that customer's runtime runs; coming when it has none. */
export function runtimeProbes(s: Pick<ProbeSource, 'facts'>): OnboardingProbes {
  return {
    state: async (tenantId, step): Promise<ProbeState> => {
      const f = s.facts(tenantId);
      if (!f) return 'coming';
      return DONE[step](f) ? 'done' : 'todo';
    },
  };
}

/** Memory as each running customer's share, and each customer's runtime state. */
export function runtimeHealth(s: Pick<ProbeSource, 'states'>, o: { rssMb: () => number; baselineMb: number }): CustomerHealth {
  return {
    memoryMb: (tenantId) => {
      const states = s.states();
      if (states.get(tenantId) !== 'running') return null;
      const running = [...states.values()].filter((x) => x === 'running').length;
      return Math.round(Math.max(0, o.rssMb() - o.baselineMb) / running);
    },
    runtime: (tenantId) => s.states().get(tenantId) ?? null,
  };
}
