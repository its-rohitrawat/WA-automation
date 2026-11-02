import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // A check handed a Promise fails (S1 made the store async; a missing await must not pass silently).
    // Under test:pg, each test file's Postgres pools end after the file (pgPools.ts); nothing on SQLite.
    setupFiles: ['tests/setup/expectGuard.ts', 'tests/setup/pgPools.ts'],
    environment: 'node',
    restoreMocks: true,
    // Some tests build large workbooks or start PowerShell; 5 s is too tight on a busy office PC.
    testTimeout: 20_000,
  },
});
