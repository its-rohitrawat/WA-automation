import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensurePlatformSchema } from '../../src/platform/schema.ts';
import { createTenant, ensureFounderTenant, FOUNDER_TENANT_ID, type TenantStatus } from '../../src/platform/store.ts';
import { guarded } from '../../src/runtime/context.ts';
import { Supervisor, type RuntimeFactory, type RuntimeFacts, type RuntimeHandle, type RuntimeStart, type SupervisorDeps } from '../../src/runtime/supervisor.ts';
import { SqliteDb } from '../../src/store/engine/sqlite.ts';
import { manualClock, type ManualClock } from '../../src/util/clock.ts';
import { silentLogger } from '../../src/util/logger.ts';

/** Runtimes that only record what happened; one can be told to fail its start. */
class FakeFactory implements RuntimeFactory {
  started: [string, boolean][] = [];
  stopped: string[] = [];
  failStart = new Set<string>();
  /** Each started runtime's crash report, as the real runtime gets it. */
  report = new Map<string, (e: unknown) => void>();
  async start(t: RuntimeStart): Promise<RuntimeHandle> {
    this.started.push([t.id, t.setupOnly]);
    if (this.failStart.has(t.id)) throw Object.assign(new Error(`no socket for ${t.id} at kapoor.studio@example.com`), { code: 'E_SOCK' });
    this.report.set(t.id, t.crashed);
    return { stop: async () => void this.stopped.push(t.id), facts: () => ({ ...NO_FACTS, whatsappLinked: t.id !== FOUNDER_TENANT_ID }) };
  }
  startsOf(id: string) {
    return this.started.filter(([x]) => x === id).length;
  }
}

/** Timers the test fires by hand. */
class Timers {
  pending: { fn: () => void; ms: number; cleared: boolean }[] = [];
  set = (fn: () => void, ms: number) => {
    const t = { fn, ms, cleared: false };
    this.pending.push(t);
    return t as unknown as ReturnType<typeof setTimeout>;
  };
  clear = (h: ReturnType<typeof setTimeout>) => void ((h as unknown as { cleared: boolean }).cleared = true);
  /** Runs every live timer once, then waits for the Supervisor's queued work; returns their delays. */
  async fire(s: Supervisor): Promise<number[]> {
    const due = this.pending.filter((t) => !t.cleared);
    this.pending = [];
    for (const t of due) t.fn();
    await s.settled();
    return due.map((t) => t.ms);
  }
}

let db: SqliteDb;
let clock: ManualClock;
let factory: FakeFactory;
let timers: Timers;

beforeEach(async () => {
  db = SqliteDb.open(':memory:');
  await ensurePlatformSchema(db);
  clock = manualClock('2026-10-30T06:00:00.000Z');
  factory = new FakeFactory();
  timers = new Timers();
  await ensureFounderTenant(db, { name: 'Your studio', at: clock.now().toISOString() });
});
afterEach(async () => {
  await db.close();
});

async function tenant(name: string, status: TenantStatus): Promise<string> {
  clock.advance(1_000);
  return (await createTenant(db, { name, status, at: clock.now().toISOString() })).id;
}

function supervisor(o: Partial<SupervisorDeps> = {}): Supervisor {
  return new Supervisor({
    db, clock, log: silentLogger(), factory, engine: 'postgres', maxActive: 20, maxRssMb: 4_096, rssMb: () => 500,
    setTimer: timers.set, clearTimer: timers.clear, stopTimeoutMs: 50, ...o,
  });
}

const F = FOUNDER_TENANT_ID;

describe('the Supervisor on SQLite', () => {
  it("runs only the founder's runtime; every customer waits for the Postgres switch", async () => {
    const a = await tenant('Alpha One', 'active');
    const b = await tenant('Beta Two', 'onboarding');
    const s = supervisor({ engine: 'sqlite' });
    await s.reconcile();
    expect(factory.started).toEqual([[F, false]]);
    expect([s.state(F), s.state(a), s.state(b)]).toEqual(['running', 'refused:postgres', 'refused:postgres']);
  });
});

describe('the Supervisor', () => {
  it('starts the founder first, a full runtime for active customers, a setup runtime for onboarding ones, nothing else', async () => {
    const a = await tenant('Alpha One', 'active');
    const b = await tenant('Beta Two', 'onboarding');
    const c = await tenant('Gamma Three', 'paused');
    const d = await tenant('Delta Four', 'invited');
    const s = supervisor();
    await s.reconcile();
    expect(factory.started).toEqual([[F, false], [a, false], [b, true]]);
    expect([s.state(c), s.state(d)]).toEqual(['stopped', 'stopped']);
    await s.reconcile(); // nothing changed: nothing restarted
    expect(factory.started).toHaveLength(3);
  });

  it('stops a customer that was paused, and turns a setup runtime into a full one on activation', async () => {
    const a = await tenant('Alpha One', 'active');
    const b = await tenant('Beta Two', 'onboarding');
    const s = supervisor();
    await s.reconcile();
    await db.run("UPDATE tenants SET status = 'paused' WHERE id = ?", [a]);
    await db.run("UPDATE tenants SET status = 'active' WHERE id = ?", [b]);
    await s.reconcile();
    expect(factory.stopped.sort()).toEqual([a, b].sort());
    expect(s.state(a)).toBe('stopped');
    expect(factory.started.at(-1)).toEqual([b, false]);
    expect(s.state(b)).toBe('running');
  });

  it("a customer that crashes again and again never stops or restarts the founder's runtime", async () => {
    const a = await tenant('Alpha One', 'active');
    const b = await tenant('Beta Two', 'active');
    const s = supervisor();
    await s.reconcile();
    for (let i = 1; i <= 6; i++) {
      // A throw inside the customer's own guarded event handler, as the runtime's socket events are wrapped (S4.6).
      guarded(a, (_id, e) => factory.report.get(a)!(e))(() => { throw new Error('boom'); })();
      await s.settled();
      expect(['backoff', 'failing']).toContain(s.state(a));
      expect([s.state(F), s.state(b)]).toEqual(['running', 'running']);
      await timers.fire(s); // the backoff ends: A starts again
      expect(s.state(a)).toBe('running');
    }
    expect(factory.startsOf(a)).toBe(7);
    expect(factory.startsOf(F)).toBe(1);
    expect(factory.startsOf(b)).toBe(1);
    expect(factory.stopped.filter((x) => x !== a)).toEqual([]);
  });

  it('waits 1 s, 2 s, 4 s… between restarts, and starts again from 1 s after 10 minutes of running', async () => {
    const a = await tenant('Alpha One', 'active');
    const s = supervisor();
    await s.reconcile();
    const waits: number[] = [];
    for (let i = 0; i < 3; i++) {
      await s.crashed(a, new Error('x'));
      waits.push(...(await timers.fire(s)));
    }
    expect(waits).toEqual([1_000, 2_000, 4_000]);
    clock.advance(600_000);
    await s.crashed(a, new Error('x'));
    expect(await timers.fire(s)).toEqual([1_000]);
  });

  it('a start that throws goes to backoff too; five failures in an hour is failing, still retried every 5 minutes', async () => {
    const a = await tenant('Alpha One', 'active');
    factory.failStart.add(a);
    const s = supervisor();
    await s.reconcile();
    expect(s.state(a)).toBe('backoff');
    const waits: number[] = [];
    for (let i = 0; i < 10; i++) waits.push(...(await timers.fire(s)));
    expect(s.state(a)).toBe('failing');
    expect(waits.slice(0, 4)).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(waits.at(-1)).toBe(300_000);
    expect(s.state(F)).toBe('running');
  });

  it("audits a crash with the error's name and code only, never its message", async () => {
    const a = await tenant('Alpha One', 'active');
    factory.failStart.add(a);
    await supervisor().reconcile();
    const rows = await db.all<{ actor: string; event: string; tenant_id: string; detail: string }>('SELECT actor, event, tenant_id, detail FROM platform_audit');
    expect(rows).toEqual([{ actor: 'supervisor', event: 'runtime.crashed', tenant_id: a, detail: 'Error E_SOCK' }]);
  });

  it('refuses a start beyond the active limit (the founder counts, and is never refused), and tries again when there is room', async () => {
    const a = await tenant('Alpha One', 'active');
    const b = await tenant('Beta Two', 'active');
    const c = await tenant('Gamma Three', 'onboarding');
    const s = supervisor({ maxActive: 2 });
    await s.reconcile();
    expect([s.state(F), s.state(a), s.state(b), s.state(c)]).toEqual(['running', 'running', 'refused:limit', 'running']); // setup runtimes don't count
    await db.run("UPDATE tenants SET status = 'paused' WHERE id = ?", [a]);
    await s.reconcile();
    expect([s.state(a), s.state(b)]).toEqual(['stopped', 'running']);
  });

  it("refuses customers' starts above the memory ceiling, never the founder's", async () => {
    const a = await tenant('Alpha One', 'active');
    let rss = 5_000;
    const s = supervisor({ rssMb: () => rss });
    await s.reconcile();
    expect([s.state(F), s.state(a)]).toEqual(['running', 'refused:memory']);
    rss = 900;
    await s.reconcile();
    expect(s.state(a)).toBe('running');
  });

  it('a customer paused while waiting to restart is not restarted', async () => {
    const a = await tenant('Alpha One', 'active');
    const s = supervisor();
    await s.reconcile();
    await s.crashed(a, new Error('x'));
    await db.run("UPDATE tenants SET status = 'paused' WHERE id = ?", [a]);
    await s.reconcile();
    expect(s.state(a)).toBe('stopped');
    await timers.fire(s);
    expect(factory.startsOf(a)).toBe(1);
  });

  it('a crash reported after a runtime stopped changes nothing', async () => {
    const a = await tenant('Alpha One', 'active');
    const s = supervisor();
    await s.reconcile();
    await db.run("UPDATE tenants SET status = 'paused' WHERE id = ?", [a]);
    await s.reconcile();
    await s.crashed(a, new Error('late'));
    expect(s.state(a)).toBe('stopped');
    expect(timers.pending).toEqual([]);
  });

  it('reconciles one at a time: two calls at once start each runtime once', async () => {
    await tenant('Alpha One', 'active');
    const s = supervisor();
    await Promise.all([s.reconcile(), s.reconcile(), s.reconcile()]);
    expect(factory.started).toHaveLength(2);
  });

  it('a stop that never finishes holds neither a reconcile nor stopAll (each stop has a time limit)', async () => {
    const a = await tenant('Alpha One', 'active');
    const start = factory.start.bind(factory);
    factory.start = async (t) => {
      const h = await start(t);
      return t.id === a ? { stop: () => new Promise<void>(() => undefined) } : h;
    };
    const s = supervisor();
    await s.reconcile();
    await db.run("UPDATE tenants SET status = 'paused' WHERE id = ?", [a]);
    await s.reconcile(); // returns after the 50 ms stop limit
    expect(s.state(a)).toBe('stopped');
    await s.stopAll();
    expect(s.state(F)).toBe('stopped');
    expect(factory.stopped).toEqual([F]);
  });

  it('lists every known runtime state, for the Customers screen', async () => {
    const a = await tenant('Alpha One', 'active');
    const s = supervisor({ maxActive: 1 });
    await s.reconcile();
    expect(Object.fromEntries(s.states())).toEqual({ [F]: 'running', [a]: 'refused:limit' });
  });

  it("gives a runtime's setup facts only while it runs", async () => {
    const a = await tenant('Alpha One', 'active');
    const b = await tenant('Beta Two', 'active');
    const s = supervisor({ maxActive: 2 });
    await s.reconcile();
    expect(s.facts(a)).toMatchObject({ whatsappLinked: true });
    expect(s.facts(b)).toBeNull(); // refused: no runtime
    await s.crashed(a, new Error('x'));
    expect(s.facts(a)).toBeNull(); // restarting
    await timers.fire(s);
    expect(s.facts(a)).toMatchObject({ whatsappLinked: true });
    expect(s.facts('00000000-0000-4000-8000-0000000000ff')).toBeNull();
  });
});

const NO_FACTS: RuntimeFacts = { whatsappLinked: false, spareLinked: false, driveConnected: false, groupsApproved: 0, reportTimeSet: false, aiKey: 'missing' };
