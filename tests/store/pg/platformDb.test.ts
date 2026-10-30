import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// S2.8, decision D1 (A4 step 5): the platform tables' Db (openPlatformStore: wa_platform's pool on Postgres, the tracker
// itself on SQLite) reaches only the platform code (src/platform/**, src/web/routes/platform.ts, through the founder's
// platform and sign-up deps) and SessionStore (with the sign-in's audited write). A static scan cannot follow data
// flow, so it pins the code: openPlatformStore is imported by main.ts only, and every code line in src that names the
// Db (platformDb, or main.ts's platformStore) is one of the uses listed below. A new use fails here, to be reviewed and
// added on purpose.

const SRC = join(import.meta.dirname, '../../../src');

function files(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else if (e.name.endsWith('.ts')) out.push(relative(SRC, p).split(sep).join('/'));
  }
  return out.sort();
}

/** Code lines only, trimmed: whole-line comments (// …, and the lines of a /** … *\/ block) are left out. */
function codeLines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '' && !/^(\/\/|\/\*|\*)/.test(l));
}

/** The only file that may import openPlatformStore (src/store/open.ts defines it). */
const OPENERS = ['main.ts', 'store/open.ts'];
const NAMES = /\b(platformDb|platformStore)\b/;

/** Every allowed line naming the platform Db, by file: where it is opened, passed on, used and closed. */
const ALLOWED: Record<string, RegExp[]> = {
  'main.ts': [
    /^let platformDb: Db \| undefined;$/,
    /^platformDb = openPlatformStore\(env, db, \{ onPoolError \}\);$/,
    // The platform tables and customer #1, made at start (S5H.1).
    /^if \(platformDb\.engine === 'sqlite'\) await ensurePlatformSchema\(platformDb\);$/,
    /^await ensureFounderTenant\(platformDb, \{/,
    // Handed to the founder's runtime (its platform and sign-up deps) and to the dashboard (SessionStore).
    /^tenantId: env\.TENANT_ID, env, log, db, platformDb, key, configs, lock, globalSpend,/,
    /^env, db, platformDb, log, control, platform: rt\.platform, customerSessions:/,
    // The Supervisor (S4.5): it reads the tenants table.
    /^env, log, clock: systemClock, platformDb, master: key, customerDb: customerDbsOf\(db\), localEngine,$/,
    // Closed at shutdown and on a failed start, when it is its own pool.
    /^const platformStore = platformDb !== db \? platformDb : undefined;$/,
    /^Promise\.all\(\[trackerDb\.close\(\), platformStore\?\.close\(\)\]/,
    /^if \(platformDb !== db\) await platformDb\?\.close\(\)/,
  ],
  'runtime/customerRuntime.ts': [
    /^platformDb\?: Db;$/,
    /^const platformDb = t\.founder && env\.PLATFORM_ENABLED \? d\.platformDb : undefined;$/,
    // Whether the founder's runtime hosts the platform (the Gmail reads and the flag), not a use of the Db.
    /^if \(platformDb\) void readGmail\(\)/,
    /^if \(platformDb\) await readGmail\(\);$/,
    /^\.\.\.\(platformDb \? \{$/,
    /^platform: platformDb !== undefined && agentRoutes !== undefined,$/,
    // The platform routes' and the sign-up's deps (src/web/routes/platform.ts).
    /^platform: \{ db: platformDb, /,
    /^db: platformDb, clock: systemClock, log, publicUrl: sitePublicUrl, founderName:/,
    // startFounderRuntime's failed start closes it.
    /^if \(d\.platformDb && d\.platformDb !== d\.db\) \{$/,
    /^await d\.platformDb\.close\(\)/,
  ],
  'runtime/platformSupervisor.ts': [
    /^platformDb: Db;$/,
    // The customers' data keys (tenant_keys), the Supervisor (tenants, platform_audit) and AiKeys' audit (platform_audit).
    /^const tenantKeys = new TenantKeys\(\{ db: o\.platformDb, master: o\.master, clock: o\.clock \}\);$/,
    /^db: o\.platformDb, clock: o\.clock, log: o\.log, engine: o\.env\.DB_ENGINE,$/,
    /^tenantId: t\.id, db, platform: o\.platformDb, dataKey:/,
    // The key check behind wantsFull: a customer's AiKeys (its key is in its own kv; AiKeys audits into platform_audit).
    /^\? new AiKeys\(\{ db: o\.customerDb\(tenantId\), platform: o\.platformDb, tenantId, dataKey:/,
  ],
  'web/start.ts': [
    /^platformDb\?: Db;$/,
    /^const platformDb = o\.platformDb \?\? o\.db;$/,
    /^const sessions = new SessionStore\(platformDb, clock\);$/,
    // The sign-in's audited write: the audit row on the customer's Db, then the session on this one (SessionStore).
    /^audited: auditedWrite\(o\.db, platformDb\),$/,
    // The member guard's membership lookup (S4.8): a customer's memberships, from the platform tables.
    /^\(await membershipsFor\(platformDb, email\)\)\.filter/,
  ],
};

function offences(path: string, text: string): string[] {
  const out: string[] = [];
  for (const line of codeLines(text)) {
    if (/\bopenPlatformStore\b/.test(line) && !OPENERS.includes(path)) out.push(`${path} uses openPlatformStore: ${line}`);
    if (!NAMES.test(line)) continue;
    const allowed = ALLOWED[path] ?? [];
    if (!allowed.some((re) => re.test(line))) out.push(`${path} names the platform Db: ${line}`);
  }
  return out;
}

describe('the platform Db reaches the platform code and SessionStore only (S2.8, D1)', () => {
  it('in the real source tree, every use is a listed one', () => {
    const found = files(SRC).flatMap((f) => offences(f, readFileSync(join(SRC, f), 'utf8')));
    expect(found).toEqual([]);
  });

  it('every listed use is still there (a stale list would hide nothing, but would no longer describe the code)', () => {
    for (const [path, rules] of Object.entries(ALLOWED)) {
      const lines = codeLines(readFileSync(join(SRC, path), 'utf8'));
      for (const re of rules) expect(lines.some((l) => re.test(l)), `${path}: ${re}`).toBe(true);
    }
    expect(readFileSync(join(SRC, 'main.ts'), 'utf8')).toMatch(/import \{[^}]*\bopenPlatformStore\b[^}]*\} from '\.\/store\/open\.ts';/);
  });

  it('catches a new opener, a new consumer, an alias and a use in another file, and lets comments through', () => {
    expect(offences('web/routes/clients.ts', "import { openPlatformStore } from '../../store/open.ts';")).not.toEqual([]);
    expect(offences('runtime/customerRuntime.ts', 'const audit = new AuditLog(platformDb, systemClock);')).not.toEqual([]);
    expect(offences('main.ts', 'const p = platformDb;')).not.toEqual([]);
    expect(offences('main.ts', 'await syncClients(platformDb, configs);')).not.toEqual([]);
    expect(offences('web/start.ts', 'const audit = o.audit ?? new AuditLog(platformDb, clock);')).not.toEqual([]);
    expect(offences('app.ts', 'db: d.platformDb,')).not.toEqual([]);
    expect(offences('main.ts', '// platformDb goes nowhere else; openPlatformStore stays here')).toEqual([]);
    expect(offences('web/start.ts', 'const sessions = new SessionStore(platformDb, clock);')).toEqual([]);
  });
});
