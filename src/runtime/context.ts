import { AsyncLocalStorage } from 'node:async_hooks';

// Which customer's runtime is running this code (plan 2026-10-29-saas-s3-s6.md, task S4.5). The Supervisor starts each
// runtime inside tenantContext.run(id, …), so its timers, promises and socket events carry the customer's id. Two ways a
// crash stays with its customer:
// - guarded() wraps a runtime's entry points (socket events, timers, ticks) and reports a throw to the Supervisor;
// - the process's uncaughtException and unhandledRejection handlers read crashOwner(), since Node runs them in the
//   context of the code that threw (proved in tests/runtime/context.test.ts, in a child process).

export const tenantContext = new AsyncLocalStorage<string>();

/** The customer whose runtime is running the current code, if any. */
export function crashOwner(): string | undefined {
  return tenantContext.getStore();
}

export type CrashReport = (tenantId: string, e: unknown) => void;

/**
 * Wraps a runtime's entry point, so a throw there (sync or async) restarts that customer's runtime instead of reaching
 * the process. The wrapped function returns undefined (or a promise of it) when it threw.
 */
export function guarded(tenantId: string, report: CrashReport) {
  return <A extends unknown[], R>(fn: (...a: A) => R) => (...a: A): R | undefined => {
    try {
      const r = fn(...a);
      if (r instanceof Promise) return r.catch((e: unknown) => void report(tenantId, e)) as R;
      return r;
    } catch (e) {
      report(tenantId, e);
      return undefined;
    }
  };
}
