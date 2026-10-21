import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
    // Some tests build large workbooks or start PowerShell; 5 s is too tight on a busy office PC.
    testTimeout: 20_000,
  },
});
