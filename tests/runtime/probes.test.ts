import { describe, expect, it } from 'vitest';
import { STEP_IDS } from '../../src/platform/onboarding.ts';
import { runtimeHealth, runtimeProbes, type ProbeSource } from '../../src/runtime/probes.ts';
import type { RuntimeFacts, RuntimeState } from '../../src/runtime/supervisor.ts';

const ALL_DONE: RuntimeFacts = { whatsappLinked: true, spareLinked: true, driveConnected: true, groupsApproved: 3, reportTimeSet: true, aiKey: 'configured' };
const NONE_DONE: RuntimeFacts = { whatsappLinked: false, spareLinked: false, driveConnected: false, groupsApproved: 0, reportTimeSet: false, aiKey: 'missing' };

function source(facts: Record<string, RuntimeFacts>, states: Record<string, RuntimeState>): ProbeSource {
  return { facts: (id) => facts[id] ?? null, states: () => new Map(Object.entries(states)) };
}

describe('the onboarding probes, from the runtimes', () => {
  it('a running runtime answers each step done or to do', async () => {
    const p = runtimeProbes(source({ A: ALL_DONE, B: NONE_DONE }, { A: 'running', B: 'running' }));
    for (const step of STEP_IDS) {
      expect(await p.state('A', step), step).toBe('done');
      expect(await p.state('B', step), step).toBe('todo');
    }
  });

  it('each step reads its own fact', async () => {
    const one = (f: Partial<RuntimeFacts>) => runtimeProbes(source({ A: { ...NONE_DONE, ...f } }, { A: 'running' }));
    expect(await one({ whatsappLinked: true }).state('A', 'whatsapp')).toBe('done');
    expect(await one({ aiKey: 'configured' }).state('A', 'key')).toBe('done');
    expect(await one({ spareLinked: true }).state('A', 'spare')).toBe('done');
    expect(await one({ driveConnected: true }).state('A', 'drive')).toBe('done');
    expect(await one({ groupsApproved: 1 }).state('A', 'groups')).toBe('done');
    expect(await one({ reportTimeSet: true }).state('A', 'report')).toBe('done');
    expect(await one({ whatsappLinked: true }).state('A', 'key')).toBe('todo');
  });

  it('with no runtime for that customer (refused, stopped, restarting), every step is coming', async () => {
    const p = runtimeProbes(source({}, { A: 'refused:postgres' }));
    for (const step of STEP_IDS) expect(await p.state('A', step)).toBe('coming');
    expect(await p.state('nobody', 'whatsapp')).toBe('coming');
  });
});

describe('customer health, from the runtimes', () => {
  it("memory: each running customer's share of what the runtimes added, in whole MB", () => {
    const h = runtimeHealth(source({}, { A: 'running', B: 'running', C: 'backoff' }), { rssMb: () => 700, baselineMb: 400 });
    expect([h.memoryMb('A'), h.memoryMb('B'), h.memoryMb('C'), h.memoryMb('nobody')]).toEqual([150, 150, null, null]);
  });

  it('never below zero, and nothing to share when nothing runs', () => {
    expect(runtimeHealth(source({}, { A: 'running' }), { rssMb: () => 300, baselineMb: 400 }).memoryMb('A')).toBe(0);
    expect(runtimeHealth(source({}, { A: 'stopped' }), { rssMb: () => 900, baselineMb: 400 }).memoryMb('A')).toBeNull();
  });

  it("each customer's runtime state, for the Customers screen", () => {
    const h = runtimeHealth(source({}, { A: 'failing', B: 'running' }), { rssMb: () => 500, baselineMb: 400 });
    expect([h.runtime!('A'), h.runtime!('B'), h.runtime!('nobody')]).toEqual(['failing', 'running', null]);
  });
});
