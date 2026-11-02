import { afterAll } from 'vitest';

// Under npm run test:pg, each test file's Postgres pools (tests/helpers/pg.ts) end after the file, so a worker never
// carries one file's connections into the next. On SQLite there is nothing to end, and the Postgres helper is not loaded.
afterAll(async () => {
  if (process.env.TEST_DB_ENGINE !== 'postgres') return;
  const { closeTestPools } = await import('../helpers/pg.ts');
  await closeTestPools();
});
