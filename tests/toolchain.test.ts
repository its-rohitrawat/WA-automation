import { describe, expect, it } from 'vitest';

describe('toolchain', () => {
  it('runs on Node 24 or newer (needed to run .ts files directly)', () => {
    const major = Number(process.versions.node.split('.')[0]);
    expect(major).toBeGreaterThanOrEqual(24);
  });
});
