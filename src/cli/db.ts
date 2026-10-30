import type { Env } from '../config/env.ts';
import { openAdminConnection, type AdminConnection } from '../store/engine/pg.ts';
import { bootstrap, migrate, roleOf } from '../store/pg/admin.ts';

// npm run cli -- db-bootstrap and db-migrate (SaaS S2.3, S2.4). Passwords are typed with no echo, or come from the .env
// URLs; none is ever printed, and no URL is either. Every message names a setting or a role, never a value.

export interface DbCommandDeps {
  connect: (url: string) => Promise<AdminConnection>;
  /** Asks for a secret with no echo. */
  prompt: (question: string) => Promise<string>;
  out: (line: string) => void;
  now: () => string;
}

export const defaultDbDeps = (): DbCommandDeps => ({
  connect: openAdminConnection,
  prompt: promptSecret,
  out: (line) => console.log(line),
  now: () => new Date().toISOString(),
});

/** Reads one line from the terminal with nothing shown. Refused when stdin is not a terminal (a pipe or a file). */
export function promptSecret(question: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) return Promise.reject(new Error('this command asks for passwords: run it in a terminal'));
  process.stdout.write(question);
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (err?: Error): void => {
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
      process.stdout.write('\n');
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (buf: Buffer): void => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003') return finish(new Error('Cancelled: nothing was changed'));
        if (ch === '\u007f' || ch === '\b') value = Array.from(value).slice(0, -1).join('');
        else if (ch >= ' ') value += ch;
      }
    };
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

function databaseOf(setting: string, url: string): string {
  const name = decodeURIComponent(new URL(url).pathname.slice(1));
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error(`${setting} must name a database (lower-case letters, digits or _)`);
  return name;
}

/** The superuser's URL: DATABASE_OWNER_URL's host and port (on this machine, as env.ts checks), another role and database. */
function superuserUrl(ownerUrl: string, superuser: string, password: string, database: string): string {
  const u = new URL(ownerUrl);
  u.username = superuser;
  u.password = password;
  u.pathname = `/${database}`;
  u.search = '';
  return u.href;
}

/**
 * Sets up the roles and the database (run once, as the owner, before db-migrate; safe to run again). Checks the .env
 * first, so a wrong setting asks for no password.
 */
export async function dbBootstrapCommand(env: Env, o: { superuser: string }, d: DbCommandDeps): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(o.superuser) || o.superuser.startsWith('wa_')) {
    throw new Error('--superuser must be the Postgres superuser (postgres by default), not one of the agent roles');
  }
  const passwords = {
    wa_owner: roleOf('DATABASE_OWNER_URL', env.DATABASE_OWNER_URL, 'wa_owner'),
    wa_app: roleOf('DATABASE_URL', env.DATABASE_URL, 'wa_app'),
    wa_platform: roleOf('DATABASE_PLATFORM_URL', env.DATABASE_PLATFORM_URL, 'wa_platform'),
  };
  if (new Set(Object.values(passwords)).size !== 3) throw new Error('wa_owner, wa_app and wa_platform each need their own password');
  const ownerUrl = env.DATABASE_OWNER_URL!;
  const dbName = databaseOf('DATABASE_OWNER_URL', ownerUrl);
  for (const [setting, url] of [['DATABASE_URL', env.DATABASE_URL!], ['DATABASE_PLATFORM_URL', env.DATABASE_PLATFORM_URL!]] as const) {
    if (databaseOf(setting, url) !== dbName) throw new Error(`${setting} must name the same database as DATABASE_OWNER_URL`);
  }

  const superPassword = await d.prompt(`Password of the Postgres superuser ${o.superuser}: `);
  const backup = await d.prompt("New password for wa_backup (the nightly dump; it goes only in the backup user's .pgpass, never in .env): ");
  if (backup.length < 16) throw new Error('the wa_backup password must be at least 16 characters: nothing was changed');
  if ((await d.prompt('The wa_backup password again: ')) !== backup) throw new Error('the two wa_backup passwords differ: nothing was changed');
  if (Object.values(passwords).includes(backup)) throw new Error('wa_backup needs its own password: nothing was changed');

  await bootstrap({
    connect: (database) => d.connect(superuserUrl(ownerUrl, o.superuser, superPassword, database)),
    passwords: { ...passwords, wa_backup: backup },
    dbName,
    out: d.out,
  });
  d.out('Next: npm run cli -- db-migrate');
}

/** Applies the Postgres migrations this code has and the database lacks, as wa_owner. */
export async function dbMigrateCommand(env: Env, d: DbCommandDeps): Promise<void> {
  roleOf('DATABASE_OWNER_URL', env.DATABASE_OWNER_URL, 'wa_owner');
  const c = await d.connect(env.DATABASE_OWNER_URL!);
  try {
    await migrate(c, { now: d.now, out: d.out });
  } finally {
    await c.end();
  }
}
