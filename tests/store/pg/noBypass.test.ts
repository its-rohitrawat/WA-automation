import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// S2.8, the static half: nothing reaches Postgres except through the engine (src/store/engine/pg.ts, to come in
// S2.6), so every query runs inside withTenant, or on the platform pool, and nothing can switch a connection's customer,
// role or row security by itself. Runs today with no Postgres. The run-time half (a pooled connection carries no
// customer after its transaction) comes with S2.7's test server.

const SRC = join(import.meta.dirname, '../../../src');
/** The only file that may hold a pg connection (plan 4.5 and 4.9: PgTenantDb, PgPlatformDb, the admin connection). */
const ENGINE = 'store/engine/pg.ts';

function files(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else if (e.name.endsWith('.ts')) out.push(relative(SRC, p).split(sep).join('/'));
  }
  return out.sort();
}

/** Code lines only: whole-line comments (// …, and the lines of a /** … *\/ block) are left out. */
function codeOf(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
    .join('\n');
}

/** Each rule: what it forbids outside the engine, and why. */
const RULES: { name: string; re: RegExp }[] = [
  // The driver itself, and its add-ons (pg-pool, pg-cursor, pg-copy-streams, …), by import, require or dynamic import.
  { name: "imports 'pg'", re: /\bfrom\s+['"]pg(?:-[\w-]+)?(?:\/[^'"]*)?['"]|\b(?:require|import)\(\s*['"]pg(?:-[\w-]+)?(?:\/[^'"]*)?['"]\s*\)/ },
  // A raw statement on a pg client or pool: only the engine sends SQL.
  { name: 'calls .query(', re: /\.query\(/ },
  // Taking a connection out of a pool or opening a client (pg's connect() takes no arguments). net.connect(path) and
  // the dashboard's google.connect(owner, body) are not caught.
  { name: 'opens a pg connection', re: /\.connect\(\s*\)|\b(?:pool|client|pg)\.connect\(/ },
  // Choosing the customer: only withTenant may set app.tenant_id.
  { name: 'calls set_config', re: /\bset_config\s*\(/i },
  // Changing role: a session as another role skips the grants (UPDATE people SET role = ? is not caught).
  { name: 'runs SET ROLE', re: /\bSET\s+(?:LOCAL\s+|SESSION\s+)?ROLE\b(?!\s*=)/i },
  // Turning row security off for a session.
  { name: 'touches row_security', re: /\brow_security\b/i },
];

function offences(path: string, text: string): string[] {
  if (path === ENGINE) return [];
  const code = codeOf(text);
  return RULES.filter((r) => r.re.test(code)).map((r) => `${path} ${r.name}`);
}

describe('nothing reaches Postgres outside the engine (S2.8, static)', () => {
  it(`only src/${ENGINE} may import pg, send SQL, connect, set the customer, change role or row security`, () => {
    const found = files(SRC).flatMap((f) => offences(f, readFileSync(join(SRC, f), 'utf8')));
    expect(found).toEqual([]);
  });

  it('catches each of them in a planted file, and lets the harmless look-alikes through', () => {
    const bad = [
      "import pg from 'pg';",
      "import { Pool } from 'pg-pool';",
      "const { Client } = require('pg');",
      "const pg = await import('pg');",
      'await client.query("SELECT 1");',
      'const c = await pool.connect();',
      'await c.connect();',
      "await db.run(\"SELECT set_config('app.tenant_id', $1, false)\");",
      'await db.run("SET ROLE wa_owner");',
      'await db.run("SET LOCAL ROLE wa_owner");',
      'await db.run("SET row_security = off");',
    ];
    for (const line of bad) expect(offences('somewhere/else.ts', line), line).not.toEqual([]);
    const fine = [
      "await db.run('UPDATE people SET role = ?, role_set_by = ? WHERE id = ?', []);",
      'const client = net.connect(name);',
      "change('/dashboard/api/google/connect', (_ctx, o, body) => google.connect(o, body));",
      "// a comment may mention set_config, SET ROLE and .query( freely",
      " * row_security in a doc comment is fine too",
      "import { readFile } from 'node:fs/promises';",
      "import { z } from 'zod';",
    ];
    for (const line of fine) expect(offences('somewhere/else.ts', line), line).toEqual([]);
  });

  it('allows them in the engine file only', () => {
    expect(offences(ENGINE, "import pg from 'pg';\nawait client.query('SELECT set_config($1, $2, true)');")).toEqual([]);
    expect(offences('store/engine/sqlite.ts', "import pg from 'pg';")).not.toEqual([]);
    expect(offences('store/pg/migrations.ts', "await client.query('x');")).not.toEqual([]);
  });
});
