import { chai } from 'vitest';

/**
 * Fails any check that is handed a promise instead of a value. Since the store became async (S1), a missing `await`
 * makes `expect(f(db)).toEqual(x)` compare a Promise, which can pass without checking anything, and
 * `expect(() => f(db)).toThrow()` never sees the error. `.resolves` and `.rejects` hand the matcher the settled value,
 * so they are not affected.
 */
const THROW_MATCHERS = new Set(['toThrow', 'toThrowError']);

function isThenable(v: unknown): boolean {
  return (typeof v === 'object' || typeof v === 'function') && v !== null && typeof (v as { then?: unknown }).then === 'function';
}

chai.use((c, utils) => {
  const proto = c.Assertion.prototype as unknown as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(proto)) {
    const d = Object.getOwnPropertyDescriptor(proto, name);
    // The jest-style matchers only (`toEqual`, `toThrow`, ...): vitest's own helpers such as `withTest` see the promise
    // before `.resolves` takes it.
    if (d === undefined || typeof d.value !== 'function' || !/^to[A-Z]/.test(name)) continue;
    c.Assertion.overwriteMethod(name, (original: (...a: unknown[]) => unknown) =>
      function (this: object, ...args: unknown[]): unknown {
        if (utils.flag(this, 'promise') !== undefined) return original.apply(this, args);
        const obj: unknown = utils.flag(this, 'object');
        if (isThenable(obj) || args.some(isThenable)) {
          throw new Error(`expect(...).${name}() was given a Promise: await the value first, or use .resolves / .rejects`);
        }
        if (!THROW_MATCHERS.has(name) || typeof obj !== 'function') return original.apply(this, args);
        let returnedPromise = false;
        utils.flag(this, 'object', function (this: unknown, ...a: unknown[]): unknown {
          const r = (obj as (...x: unknown[]) => unknown).apply(this, a);
          if (isThenable(r)) {
            returnedPromise = true;
            (r as Promise<unknown>).then(undefined, () => {});
          }
          return r;
        });
        const misuse = () => new Error(`expect(fn).${name}() got a function that returns a Promise: use await expect(fn()).rejects.${name}()`);
        let result: unknown;
        try {
          result = original.apply(this, args);
        } catch (e) {
          throw returnedPromise ? misuse() : e;
        }
        if (returnedPromise) throw misuse();
        return result;
      },
    );
  }
});
