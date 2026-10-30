import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLATFORM_TABLES } from '../../../src/platform/pgSchema.ts';
import { openDb, type Db } from '../../../src/store/db.ts';
import {
  CUSTOMER_TABLES, FOUNDER_TENANT_ID, P1_SQL, P2_SQL, P3_GRANTS_SQL, P3_SQL, PG_LATEST, PG_MIGRATIONS, SCHEMA_VERSION_FN_SQL, WEB_SESSIONS_PG_SQL,
} from '../../../src/store/pg/migrations.ts';

// Until S2's test server exists (S2.7), the Postgres schema is checked against the migrated SQLite schema by reading
// it: the same tables and columns with the right types, NOT NULL and defaults, every unique key and index per customer
// (tenant_id first), every foreign key through (tenant_id, id). The test that runs the SQL on a real Postgres is S2.7's.

interface PgColumn {
  name: string;
  type: string;
  notNull: boolean;
  dflt: string | undefined;
  def: string;
}
interface PgTable {
  columns: PgColumn[];
  constraints: string[];
}

/** Splits at commas outside parentheses and quotes. */
function topLevel(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = false;
  let cur = '';
  for (const ch of body) {
    if (ch === "'") quote = !quote;
    if (!quote && ch === '(') depth++;
    if (!quote && ch === ')') depth--;
    if (!quote && depth === 0 && ch === ',') {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const CONSTRAINT = /^(PRIMARY KEY|UNIQUE|FOREIGN KEY|CHECK|CONSTRAINT)\b/;
const STOP = /\s(NOT NULL|DEFAULT|CHECK|REFERENCES|GENERATED|PRIMARY KEY|UNIQUE)\b/;

function pgTables(sql: string): Map<string, PgTable> {
  const out = new Map<string, PgTable>();
  for (const m of sql.matchAll(/CREATE TABLE (\w+) \(\n([\s\S]*?)\n\);/g)) {
    const t: PgTable = { columns: [], constraints: [] };
    for (const part of topLevel(m[2]!)) {
      if (CONSTRAINT.test(part)) {
        t.constraints.push(part.replace(/\s+/g, ' '));
        continue;
      }
      const name = part.split(/\s+/)[0]!;
      const rest = part.slice(name.length);
      const stop = STOP.exec(rest);
      const type = (stop ? rest.slice(0, stop.index) : rest).trim();
      const dflt = /\bDEFAULT ('(?:[^']|'')*'|[^\s,]+(?:\([^)]*\))?(?:::\w+)?)/.exec(rest)?.[1];
      t.columns.push({ name, type, notNull: /\bNOT NULL\b|\bPRIMARY KEY\b/.test(rest), dflt, def: part });
    }
    out.set(m[1]!, t);
  }
  return out;
}

const pgIndexes = (sql: string) =>
  [...sql.matchAll(/CREATE INDEX (\w+) ON (\w+) \(([^)]*)\);/g)].map((m) => ({ name: m[1]!, table: m[2]!, cols: m[3]!.split(',').map((c) => c.trim()) }));

const P1 = pgTables(P1_SQL);
const WEB = pgTables(WEB_SESSIONS_PG_SQL);

let db: Db;
beforeAll(() => {
  db = openDb(':memory:');
});
afterAll(async () => {
  await db.close();
});

const sqliteTables = async () =>
  (await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_version' ORDER BY name")).map((r) => r.name);
type LiteCol = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number };
const liteColumns = (t: string) => db.all<LiteCol>(`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info('${t}')`);

/** The Postgres types a SQLite column may become. */
function expectedTypes(c: LiteCol): string[] {
  const t = c.type.toUpperCase();
  if (t === 'TEXT') return ['text'];
  if (t === 'REAL') return ['double precision'];
  if (t === 'BLOB') return ['bytea'];
  if (t === 'INTEGER') return c.name === 'id' || c.name.endsWith('_id') || c.name === 'reply_to' ? ['bigint'] : ['smallint', 'integer', 'bigint'];
  throw new Error(`unexpected SQLite type ${c.type} for ${c.name}`);
}

describe('the Postgres schema (P1 to P3) against the SQLite schema', () => {
  it('has every SQLite table: the customer tables in P1, web_sessions on the platform side', async () => {
    const lite = await sqliteTables();
    const customer = lite.filter((t) => t !== 'web_sessions');
    expect([...customer].sort()).toEqual(CUSTOMER_TABLES.filter((t) => t !== 'wa_auth').sort());
    for (const t of CUSTOMER_TABLES) expect(P1.has(t), t).toBe(true);
    expect(P1.has('tenants')).toBe(true);
    expect(P1.has('web_sessions')).toBe(false);
    expect(WEB.has('web_sessions')).toBe(true);
    expect(PLATFORM_TABLES).toContain('web_sessions');
    expect(CUSTOMER_TABLES).not.toContain('web_sessions');
  });

  it('gives every customer table its tenant_id first, defaulting to the transaction’s customer', () => {
    for (const t of CUSTOMER_TABLES) {
      const first = P1.get(t)!.columns[0]!;
      expect(first.def, t).toBe("tenant_id uuid NOT NULL DEFAULT current_setting('app.tenant_id')::uuid REFERENCES tenants (id)");
      expect(P1.get(t)!.columns.filter((c) => c.name === 'tenant_id'), t).toHaveLength(1);
    }
  });

  it('has exactly the SQLite columns, with types, NOT NULL and defaults that match', async () => {
    for (const t of [...CUSTOMER_TABLES.filter((x) => x !== 'wa_auth'), 'web_sessions']) {
      const pg = (t === 'web_sessions' ? WEB : P1).get(t)!;
      const lite = await liteColumns(t);
      expect(pg.columns.map((c) => c.name).filter((n) => n !== 'tenant_id').sort(), t).toEqual(lite.map((c) => c.name).sort());
      for (const c of lite) {
        const p = pg.columns.find((x) => x.name === c.name)!;
        expect(expectedTypes(c), `${t}.${c.name} is ${p.type}`).toContain(p.type);
        expect(p.notNull, `${t}.${c.name} NOT NULL`).toBe(c.notnull === 1 || c.pk === 1);
        expect(p.dflt ?? null, `${t}.${c.name} DEFAULT`).toBe(c.dflt_value);
        if (c.name === 'id' && c.pk === 1 && c.type.toUpperCase() === 'INTEGER') expect(p.def, `${t}.id`).toBe('id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY');
      }
    }
  });

  it('keeps every unique key per customer: UNIQUE or PRIMARY KEY (tenant_id, the same columns)', async () => {
    for (const t of CUSTOMER_TABLES.filter((x) => x !== 'wa_auth')) {
      const keys = await db.all<{ name: string; origin: string }>(`SELECT name, origin FROM pragma_index_list('${t}') WHERE "unique" = 1`);
      const sets: string[][] = [];
      for (const k of keys) sets.push((await db.all<{ name: string }>(`SELECT name FROM pragma_index_info('${k.name}') ORDER BY seqno`)).map((c) => c.name));
      // A text primary key (kv.k, reports.date, settings.k) has no index row of its own here: take it from the columns.
      const textPk = (await liteColumns(t)).filter((c) => c.pk === 1 && c.type.toUpperCase() !== 'INTEGER').map((c) => c.name);
      if (textPk.length > 0) sets.push(textPk);
      const pg = P1.get(t)!.constraints;
      for (const cols of sets) {
        const want = ['tenant_id', ...cols].join(', ');
        expect(pg.some((c) => c === `UNIQUE (${want})` || c === `PRIMARY KEY (${want})`), `${t} (${want})`).toBe(true);
      }
      for (const c of pg.filter((x) => /^(UNIQUE|PRIMARY KEY) \(/.test(x))) expect(c, t).toMatch(/^(UNIQUE|PRIMARY KEY) \(tenant_id\b/);
    }
  });

  it('turns every foreign key into (tenant_id, column) to a parent with UNIQUE (tenant_id, id)', async () => {
    for (const t of CUSTOMER_TABLES.filter((x) => x !== 'wa_auth')) {
      const fks = await db.all<{ table: string; from: string; to: string }>(`SELECT "table", "from", "to" FROM pragma_foreign_key_list('${t}')`);
      const pg = P1.get(t)!;
      for (const fk of fks) {
        expect(pg.constraints, `${t}.${fk.from}`).toContain(`FOREIGN KEY (tenant_id, ${fk.from}) REFERENCES ${fk.table} (tenant_id, ${fk.to})`);
        expect(P1.get(fk.table)!.constraints, `${fk.table} parent of ${t}`).toContain(`UNIQUE (tenant_id, ${fk.to})`);
        expect(pg.columns.find((c) => c.name === fk.from)!.def, `${t}.${fk.from}`).not.toMatch(/REFERENCES/); // never a single-column key
      }
      const declared = pg.constraints.filter((c) => c.startsWith('FOREIGN KEY'));
      expect(declared, t).toHaveLength(fks.length);
      // Parents come before their children (CUSTOMER_TABLES is the creation order).
      for (const fk of fks) expect(CUSTOMER_TABLES.indexOf(fk.table as never), `${fk.table} before ${t}`).toBeLessThan(CUSTOMER_TABLES.indexOf(t));
    }
  });

  it('has every SQLite index, tenant_id first and then the same columns', async () => {
    const pg = pgIndexes(P1_SQL);
    const lite = await db.all<{ name: string; tbl_name: string }>("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL");
    for (const ix of lite) {
      const cols = (await db.all<{ name: string }>(`SELECT name FROM pragma_index_info('${ix.name}') ORDER BY seqno`)).map((c) => c.name);
      expect(pg.find((p) => p.name === ix.name), ix.name).toEqual({ name: ix.name, table: ix.tbl_name, cols: ['tenant_id', ...cols] });
    }
    expect(pg).toHaveLength(lite.length);
  });

  it('wa_auth holds both phones and the backup slot (A2) for the session files’ rows', async () => {
    const pg = P1.get('wa_auth')!;
    expect(pg.columns.map((c) => c.name)).toEqual(['tenant_id', 'phone', 'slot', 'k', 'v']);
    expect(pg.columns.find((c) => c.name === 'slot')!.def).toBe("slot text NOT NULL DEFAULT 'live' CHECK (slot IN ('live', 'backup'))");
    expect(pg.constraints).toContain('PRIMARY KEY (tenant_id, phone, slot, k)');
    expect(pg.columns.find((c) => c.name === 'v')!.type).toBe('bytea');
  });

  it('writes no SQLite-only syntax', () => {
    for (const { sql } of PG_MIGRATIONS) {
      expect(sql).not.toMatch(/\bAUTOINCREMENT\b|INTEGER PRIMARY KEY|\bBLOB\b|\bREAL\b|\bDATETIME\b|INSERT OR |\bsqlite_/i);
    }
  });

  it('seeds customer #1 with the fixed id the copy tool and the platform use', () => {
    expect(FOUNDER_TENANT_ID).toBe('00000000-0000-4000-8000-000000000001');
    expect(P1_SQL).toContain(`VALUES ('${FOUNDER_TENANT_ID}', 'Founder', 'active'`);
    expect(WEB.get('web_sessions')!.columns.find((c) => c.name === 'tenant_id')!.def).toBe(`tenant_id uuid NOT NULL DEFAULT '${FOUNDER_TENANT_ID}' REFERENCES tenants (id)`);
  });

  it('P2 gives the agent roles the schema version through one locked-down function, and PG_LATEST is the last migration', () => {
    expect(P2_SQL.endsWith(SCHEMA_VERSION_FN_SQL)).toBe(true);
    expect(SCHEMA_VERSION_FN_SQL).toMatch(/SECURITY DEFINER SET search_path = pg_catalog, public/);
    expect(SCHEMA_VERSION_FN_SQL).toContain('REVOKE ALL ON FUNCTION wa_schema_version() FROM PUBLIC;');
    expect(SCHEMA_VERSION_FN_SQL).toContain('GRANT EXECUTE ON FUNCTION wa_schema_version() TO wa_app, wa_platform;');
    expect(SCHEMA_VERSION_FN_SQL).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    expect(PG_LATEST).toBe(3);
  });

  it('P2 enables, forces and scopes row-level security on every customer table, and only those', () => {
    for (const t of CUSTOMER_TABLES) {
      expect(P2_SQL, t).toContain(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`);
      expect(P2_SQL, t).toContain(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;`);
      expect(P2_SQL, t).toContain(`CREATE POLICY ${t}_tenant ON ${t}\n  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)\n  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);`);
    }
    expect([...P2_SQL.matchAll(/ENABLE ROW LEVEL SECURITY/g)]).toHaveLength(CUSTOMER_TABLES.length);
    expect(P2_SQL).toContain('REVOKE ALL ON tenants, pg_schema_version FROM wa_app;');
    for (const t of PLATFORM_TABLES) expect(P2_SQL, t).not.toContain(`ALTER TABLE ${t} `);
  });

  it('P3 ends by taking the platform tables back from wa_app and granting wa_platform and wa_backup (A4)', () => {
    expect(P3_SQL.endsWith(P3_GRANTS_SQL)).toBe(true);
    const list = PLATFORM_TABLES.join(', ');
    expect(P3_GRANTS_SQL).toContain(`REVOKE ALL ON ${list} FROM wa_app;`);
    expect(P3_GRANTS_SQL).toContain('REVOKE ALL ON SEQUENCE platform_audit_id_seq FROM wa_app;');
    expect(P3_GRANTS_SQL).toContain(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${list} TO wa_platform;`);
    expect(P3_GRANTS_SQL).not.toMatch(/GRANT [^;]*(INSERT|UPDATE|DELETE|TRUNCATE)[^;]* TO wa_backup/);
    expect(P3_GRANTS_SQL).toMatch(/GRANT SELECT ON ALL TABLES IN SCHEMA public TO wa_backup;/);
    expect(PG_MIGRATIONS.map((m) => m.version)).toEqual([1, 2, 3]);
  });
});
