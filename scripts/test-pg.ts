// npm run test:pg [-- vitest arguments] (SaaS S2.7): a throwaway Postgres 17 in Docker, reachable on 127.0.0.1 only,
// set up by db-bootstrap's and db-migrate's own code, then vitest pointed at it through TEST_ variables
// (tests/helpers/pg.ts). The passwords are made here at run time and travel only in environment variables: never on a
// command line, in a file or in a log. The image is never downloaded here (docker pull postgres:17 is its own step), and
// the container is stopped at the end but never deleted. The next run reuses it (only one with this script's label):
// it is started, and inside it every database and role from the last run is dropped and the superuser gets a new
// password, through psql on stdin with the container's local trust. Nothing is written outside the container, and no
// run ever removes it: that stays the owner's call (docker rm wa-test-pg).
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { openAdminConnection, type AdminConnection } from '../src/store/engine/pg.ts';
import { bootstrap, migrate } from '../src/store/pg/admin.ts';

const NAME = 'wa-test-pg';
const IMAGE = 'postgres:17';
const PORT = Number(process.env.TEST_PG_PORT ?? 55432);
const DB = 'wa_agent';
const VITEST = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));

const secret = () => randomBytes(18).toString('base64url');
const pw = { postgres: secret(), wa_owner: secret(), wa_app: secret(), wa_platform: secret(), wa_backup: secret() };
function url(user: keyof typeof pw, database: string): string {
  const u = new URL(`postgres://127.0.0.1:${PORT}/${database}`);
  u.username = user;
  u.password = pw[user];
  return u.href;
}

/** docker, without a shell; its output is captured, never echoed (none of it holds a password, but none is needed). */
function docker(args: string[], o: SpawnSyncOptions = {}): { ok: boolean; out: string } {
  const r = spawnSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...o });
  return { ok: r.status === 0, out: String(r.stdout ?? '').trim() };
}

function fail(message: string): never {
  process.stderr.write(`test:pg: ${message}\n`);
  process.exit(2);
}

/** SQL run inside the container as its superuser (local trust), sent on stdin: never on a command line or in a file. */
function psql(sql: string): { ok: boolean; out: string } {
  return docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1'], {
    input: sql, stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** The real server answers on TCP (the image first starts a temporary one for its own setup). */
async function waitReady(): Promise<void> {
  for (let i = 0; i < 120; i++) {
    if (docker(['exec', NAME, 'pg_isready', '-q', '-h', '127.0.0.1', '-U', 'postgres']).ok) return;
    await sleep(500);
  }
  throw new Error(`${NAME} did not become ready within a minute`);
}

/** The server's connections: each test file keeps a few (tests/helpers/pg.ts), times the parallel workers; 100 ran out. */
const MAX_CONNECTIONS = 200;

if (!docker(['info', '--format', '{{.ServerVersion}}']).ok) fail('the Docker engine is not running: start Docker Desktop, then run this again');
const existing = docker(['container', 'inspect', NAME, '--format', '{{index .Config.Labels "wa-agent"}} {{.State.Running}} {{(index (index .HostConfig.PortBindings "5432/tcp") 0).HostIp}}:{{(index (index .HostConfig.PortBindings "5432/tcp") 0).HostPort}}']);
let reused = false;
if (existing.ok) {
  const [label, running, binding] = existing.out.split(' ');
  // Only this script's own container is reused: anything else of that name is left alone.
  if (label !== 'test-pg') fail(`a container named ${NAME} is there, but it was not made by this script (no wa-agent=test-pg label). Nothing was changed.`);
  if (binding !== `127.0.0.1:${PORT}`) fail(`${NAME} listens on ${binding ?? 'another address'}, not 127.0.0.1:${PORT}. Nothing was changed.`);
  if (running !== 'true' && !docker(['start', NAME]).ok) fail(`${NAME} is there but did not start. Nothing was changed.`);
  reused = true;
} else {
  if (!docker(['image', 'inspect', IMAGE]).ok) fail(`${IMAGE} is not downloaded. Download it first (about 650 MB on disk): docker pull ${IMAGE}`);
  // -e POSTGRES_PASSWORD with no value: docker reads it from its own environment, so it is not on the command line.
  const started = docker(
    ['run', '-d', '--name', NAME, '--label', 'wa-agent=test-pg', '-p', `127.0.0.1:${PORT}:5432`, '-e', 'POSTGRES_PASSWORD', IMAGE, '-c', `max_connections=${MAX_CONNECTIONS}`],
    { env: { ...process.env, POSTGRES_PASSWORD: pw.postgres } },
  );
  if (!started.ok) fail(`${NAME} did not start (is port ${PORT} free? set TEST_PG_PORT to use another)`);
}

let code = 1;
try {
  await waitReady();
  if (reused) {
    // Back to a fresh server: every database and role from the last run goes, and the superuser gets this run's password.
    // A container made before the 200-connection setting gets it here (it takes effect on a restart).
    const reset = psql(`
SELECT format('DROP DATABASE %I WITH (FORCE)', datname) FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres' \\gexec
SELECT format('DROP ROLE %I', rolname) FROM pg_roles WHERE rolname <> 'postgres' AND rolname NOT LIKE 'pg\\_%' \\gexec
ALTER ROLE postgres PASSWORD '${pw.postgres}';
`);
    if (!reset.ok) throw new Error(`${NAME} could not be reset for this run`);
    const max = Number(psql('SHOW max_connections;').out);
    if (!(max >= MAX_CONNECTIONS)) {
      if (!psql(`ALTER SYSTEM SET max_connections = ${MAX_CONNECTIONS};`).ok || !docker(['restart', NAME]).ok) throw new Error(`${NAME} could not be given ${MAX_CONNECTIONS} connections`);
      await waitReady();
    }
    console.log(`test:pg: reusing ${NAME}, reset for this run`);
  }

  const out = (line: string) => console.log(`test:pg: ${line}`);
  await bootstrap({ connect: (database) => connectRetrying(url('postgres', database)), passwords: pw, dbName: DB, out });
  const owner = await openAdminConnection(url('wa_owner', DB));
  try {
    await migrate(owner, { now: () => new Date().toISOString(), out });
  } finally {
    await owner.end();
  }

  const env = {
    ...process.env,
    TEST_DB_ENGINE: 'postgres',
    TEST_PG_APP_URL: url('wa_app', DB),
    TEST_PG_OWNER_URL: url('wa_owner', DB),
    TEST_PG_PLATFORM_URL: url('wa_platform', DB),
    TEST_PG_BACKUP_URL: url('wa_backup', DB),
    // This throwaway container's superuser, for the copy tests that make a fresh database of their own (c7's copyPg).
    TEST_PG_SERVER_URL: url('postgres', 'postgres'),
  };
  const args = process.argv.slice(2).filter((a) => a !== '--');
  code = spawnSync(process.execPath, [VITEST, 'run', ...args], { stdio: 'inherit', env }).status ?? 1;
} catch (err) {
  process.stderr.write(`test:pg: ${err instanceof Error ? err.message : 'set-up failed'}\n`);
} finally {
  const stopped = docker(['stop', NAME]).ok;
  console.log(stopped
    ? `test:pg: ${NAME} is stopped and kept (not deleted); the next npm run test:pg reuses it. Removing it is the owner's call: docker rm ${NAME}`
    : `test:pg: ${NAME} could not be stopped: check docker ps`);
}
process.exit(code);

/** The first connections can meet the server still finishing its start: a few tries, half a second apart. */
async function connectRetrying(u: string): Promise<AdminConnection> {
  for (let i = 0; ; i++) {
    try {
      return await openAdminConnection(u);
    } catch (err) {
      if (i >= 20) throw err;
      await sleep(500);
    }
  }
}
