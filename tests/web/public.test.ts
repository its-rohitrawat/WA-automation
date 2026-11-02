import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { ICONS_FILE, iconsModule } from '../../scripts/build-dashboard-icons.ts';
import { VENDOR_FILES } from '../../src/web/server.ts';
// The front end is plain browser modules; these four need no DOM. Their JSDoc types are checked by tsconfig.web.json,
// which this project's tsconfig does not include, so the imports are untyped here.
// @ts-expect-error -- browser module (see above)
import { problems, readBulk, readChat, readClientDetail, readClients, readConnections, readGroups, readOverview, readSendResult, readStatus } from '../../src/web/public/contract.js';
// @ts-expect-error -- browser module (see above)
import { PUBLIC_MAIL_DOMAINS as BROWSER_PUBLIC, fieldProblem } from '../../src/web/public/views/rules.js';
import { PUBLIC_MAIL_DOMAINS } from '../../src/config/domains.ts';
// @ts-expect-error -- browser module (see above)
import { ago, date, greeting, initials, usd, when } from '../../src/web/public/format.js';
// @ts-expect-error -- browser module (see above)
import { HI } from '../../src/web/public/icons.js';
// @ts-expect-error -- browser module (see above)
import { LOCKED_UNTIL_ACTIVE, NAV, ONBOARDING_NAV, PLATFORM_NAV, SCREENS, navFor, parsePath, pathFor, showScreens } from '../../src/web/public/router.js';

const PUBLIC = fileURLToPath(new URL('../../src/web/public/', import.meta.url));
const publicFiles = (ext: string) =>
  readdirSync(PUBLIC, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith(ext))
    .map((f) => ({ file: f.replaceAll('\\', '/'), text: readFileSync(join(PUBLIC, f), 'utf8') }));

describe('front-end files and the Content-Security-Policy', () => {
  it('index.html has no inline script, import map, style attribute or event handler', () => {
    const html = readFileSync(join(PUBLIC, 'index.html'), 'utf8');
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, attrs, body] of scripts) {
      expect(attrs).toMatch(/\bsrc="\/dashboard\/(static|vendor)\/[\w./-]+"/);
      expect(attrs).not.toMatch(/importmap/i);
      expect(body?.trim()).toBe('');
    }
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/javascript:/i);
  });

  it('no script writes a style attribute, an inline handler, or runs strings as code', () => {
    const files = publicFiles('.js');
    expect(files.map((f) => f.file)).toEqual(expect.arrayContaining(['app.js', 'api.js', 'views/overview.js', 'views/connections.js']));
    for (const { file, text } of files) {
      const where = `src/web/public/${file}`;
      expect(text, where).not.toMatch(/\sstyle\s*=\s*["'`$]/);
      expect(text, where).not.toMatch(/setAttribute\(\s*['"]style['"]/);
      expect(text, where).not.toMatch(/\son[a-z]+\s*=\s*["']/);
      expect(text, where).not.toMatch(/\beval\s*\(|new Function\s*\(|javascript:/);
    }
  });

  it('only the theme choice goes into browser storage, never the CSRF token', () => {
    for (const { file, text } of publicFiles('.js')) {
      expect(text, file).not.toMatch(/sessionStorage|indexedDB/);
      for (const m of text.matchAll(/localStorage\.\w+\(([^)]*)\)/g)) expect(m[1], file).toMatch(/^\s*(THEME_KEY|['"]wa-agent-theme['"])/);
    }
  });

  it('every icon the pages name exists in the generated set', () => {
    const names = new Set<string>();
    for (const { text } of [...publicFiles('.js'), ...publicFiles('.html')]) {
      for (const m of text.matchAll(/\bicon\(\s*'([\w-]+)'/g)) names.add(m[1]!);
      for (const m of text.matchAll(/data-icon="([\w-]+)"/g)) names.add(m[1]!);
      // Icon tables: const ICON = { kind: 'name' }, ACTION rows ['name', 'Label'], and the KPI rows ['Label', 'name', ...].
      for (const m of text.matchAll(/const \w*ICON = \{([^}]*)\}/g)) for (const v of m[1]!.matchAll(/:\s*'([\w-]+)'/g)) names.add(v[1]!);
      for (const m of text.matchAll(/const ACTION = \{([\s\S]*?)\};/g)) for (const v of m[1]!.matchAll(/\[\s*'([\w-]+)'/g)) names.add(v[1]!);
      for (const m of text.matchAll(/^\s*\['[^']+', '([\w-]+)', /gm)) names.add(m[1]!);
    }
    for (const [, items] of NAV) for (const [, , ic] of items) names.add(ic);
    for (const [, , ic] of [...PLATFORM_NAV, ONBOARDING_NAV]) names.add(ic);
    names.add('lock'); // a customer's locked screens (app.js)
    expect(names.size).toBeGreaterThan(10);
    expect([...names].filter((n) => !(n in HI))).toEqual([]);
  });
});

describe('generated icons and vendor files', () => {
  it('icons.js is what the build script makes now (run npm run build:icons after changing the pick)', () => {
    const committed = readFileSync(ICONS_FILE, 'utf8').replaceAll('\r\n', '\n');
    expect(committed).toBe(iconsModule());
  });

  it('every vendor file exists, and Three.js imports only its own core file', () => {
    expect(Object.keys(VENDOR_FILES).sort()).toEqual(['gsap.js', 'three.core.js', 'three.js']);
    for (const path of Object.values(VENDOR_FILES)) expect(existsSync(path), path).toBe(true);
    // Static import/export-from statements and dynamic import('…') calls; strings that merely contain "import" do not count.
    const imports = (path: string) => {
      const text = readFileSync(path, 'utf8');
      return [
        ...[...text.matchAll(/(?:^|[;}])\s*(?:import|export)\s[^;'"`]*?\bfrom\s*['"]([^'"]+)['"]/g)].map((m) => m[1]),
        ...[...text.matchAll(/(?:^|[;}])\s*import\s*['"]([^'"]+)['"]/g)].map((m) => m[1]),
        ...[...text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]),
      ];
    };
    expect(new Set(imports(VENDOR_FILES['three.js']!))).toEqual(new Set(['./three.core.js']));
    expect(imports(VENDOR_FILES['three.core.js']!)).toEqual([]);
  });

  it('the Geist fonts are committed woff2 files with their licence', () => {
    for (const name of ['Geist-Variable.woff2', 'GeistMono-Variable.woff2']) {
      expect(readFileSync(join(PUBLIC, 'fonts', name)).subarray(0, 4).toString('latin1')).toBe('wOF2');
    }
    expect(readFileSync(join(PUBLIC, 'fonts', 'OFL.txt'), 'utf8')).toMatch(/SIL Open Font License/);
  });
});

describe('router', () => {
  it('has the eleven screens', () => {
    expect([...SCREENS.keys()]).toEqual([
      'overview', 'clients', 'tasks', 'meetings', 'activity', 'tracker', 'connections', 'usage', 'automations', 'audit', 'settings',
    ]);
  });

  it('reads an address, falling back to overview', () => {
    expect(parsePath('/dashboard')).toEqual({ screen: 'overview', sub: null });
    expect(parsePath('/dashboard/')).toEqual({ screen: 'overview', sub: null });
    expect(parsePath('/dashboard/connections')).toEqual({ screen: 'connections', sub: null });
    expect(parsePath('/dashboard/clients/groups')).toEqual({ screen: 'clients', sub: 'groups' });
    expect(parsePath('/dashboard/tasks/groups')).toEqual({ screen: 'tasks', sub: null });
    expect(parsePath('/dashboard/nope')).toEqual({ screen: 'overview', sub: null });
    expect(parsePath('/dashboard/__proto__')).toEqual({ screen: 'overview', sub: null });
  });

  it('builds addresses that read back the same', () => {
    expect(pathFor('overview')).toBe('/dashboard');
    expect(pathFor('clients', 'groups')).toBe('/dashboard/clients/groups');
    for (const screen of SCREENS.keys()) expect(parsePath(pathFor(screen))).toEqual({ screen, sub: null });
  });

  type Nav = [string, [string][]][];
  const group = (s: object, g: string) => (navFor(s) as Nav).find(([name]) => name === g)![1].map(([id]) => id);
  const ids = (s: object) => (navFor(s) as Nav).flatMap(([, items]) => items.map(([id]) => id));
  const FOUNDER_ONLY = ['customers', 'invite', 'connections', 'usage'];

  it('the founder: today’s nav, with Customers and Invite only when the platform is on (SaaS S5)', () => {
    const today = (NAV as Nav).flatMap(([, items]) => items.map(([id]) => id));
    // Off (PLATFORM_ENABLED unset), and a server before S4.8 that sends no role: exactly today's nav.
    for (const s of [{ role: 'founder', platform: false }, {}]) expect(ids(s)).toEqual(today);
    expect(group({ role: 'founder', platform: true }, 'System').slice(0, 3)).toEqual(['customers', 'invite', 'connections']);
    expect(ids({ role: 'founder', platform: true }).filter((id) => id !== 'customers' && id !== 'invite')).toEqual(today);
    expect(ids({ role: 'founder', platform: true })).not.toContain('onboarding');
  });

  it('a customer: Getting started first, their workspace, and never the founder’s screens, platform on or off', () => {
    for (const platform of [false, true]) {
      const s = { role: 'owner', platform };
      expect(group(s, 'Workspace')).toEqual(['onboarding', 'overview', 'clients', 'tasks', 'meetings', 'activity', 'tracker']);
      expect(group(s, 'System')).toEqual(['automations', 'audit', 'settings']);
      for (const id of FOUNDER_ONLY) expect(ids(s)).not.toContain(id);
    }
    expect([...LOCKED_UNTIL_ACTIVE]).toEqual(['clients', 'tasks', 'meetings', 'tracker']);
  });

  it('Switch workspace: first in System for a member of 2 or more workspaces only, never the founder’s', () => {
    expect(group({ role: 'owner', workspaces: 2 }, 'System')).toEqual(['workspaces', 'automations', 'audit', 'settings']);
    for (const s of [{ role: 'owner', workspaces: 1 }, { role: 'owner' }, { role: 'founder', platform: true, workspaces: 3 }]) expect(ids(s)).not.toContain('workspaces');
    expect(LOCKED_UNTIL_ACTIVE.has('workspaces')).toBe(false); // a member can switch before its workspace is active
  });

  it('only the session’s own screens have an address: anything else opens the overview', () => {
    try {
      showScreens({ role: 'owner', platform: true });
      expect(parsePath('/dashboard/onboarding')).toEqual({ screen: 'onboarding', sub: null });
      for (const id of FOUNDER_ONLY) expect(parsePath(`/dashboard/${id}`)).toEqual({ screen: 'overview', sub: null });
      showScreens({ role: 'founder', platform: true });
      expect(parsePath('/dashboard/customers')).toEqual({ screen: 'customers', sub: null });
      expect(parsePath('/dashboard/onboarding')).toEqual({ screen: 'overview', sub: null });
    } finally {
      showScreens({ role: 'founder', platform: false });
    }
    expect(parsePath('/dashboard/invite')).toEqual({ screen: 'overview', sub: null });
    expect([...SCREENS.keys()]).toHaveLength(11);
  });
});

describe('format (India time)', () => {
  const now = new Date('2026-10-27T06:30:00Z'); // Tuesday 12:00 IST

  it('says how long ago', () => {
    expect(ago('2026-10-27T06:29:20Z', now)).toBe('40 s ago');
    expect(ago('2026-10-27T06:18:00Z', now)).toBe('12 min ago');
    expect(ago('2026-10-27T03:30:00Z', now)).toBe('3 h ago');
    expect(ago('2026-10-26T13:10:00Z', now)).toBe('Yesterday 18:40');
    expect(ago(null, now)).toBe('—');
    expect(ago('not a date', now)).toBe('—');
    expect(ago('2026-10-27T06:31:00Z', now)).toBe('0 s ago');
  });

  it('names the day in India time, not the machine time', () => {
    expect(when('2026-10-27T05:30:00Z', now)).toBe('Today 11:00');
    expect(when('2026-10-26T19:00:00Z', now)).toBe('Today 00:30');
    expect(date('2026-10-27T19:00:00Z')).toBe('28 Oct 2026'); // India date
    expect(date('nonsense')).toBe('—');
    expect(when('2026-10-26T18:00:00Z', now)).toBe('Yesterday 23:30');
    expect(when('2026-10-23T11:00:00Z', now)).toBe('Fri 16:30');
    expect(when('2026-10-21T03:42:00Z', now)).toBe('Wed 09:12');
    expect(when('2026-10-19T03:42:00Z', now)).toBe('19 Oct 09:12');
  });

  it('greets by the India hour', () => {
    expect(greeting(new Date('2026-10-27T02:00:00Z'))).toBe('Good morning');
    expect(greeting(new Date('2026-10-27T08:00:00Z'))).toBe('Good afternoon');
    expect(greeting(new Date('2026-10-27T14:00:00Z'))).toBe('Good evening');
  });

  it('formats money and initials', () => {
    expect(usd(2.371)).toBe('$2.37');
    expect(usd(Number.NaN)).toBe('—');
    expect(usd(undefined)).toBe('—');
    expect(initials('Rohit Solution Bowl', 'x@example.com')).toBe('RS');
    expect(initials('rohit', 'x@example.com')).toBe('RO');
    expect(initials('', 'owner@example.com')).toBe('OW');
  });
});

describe('contract (the API answers as the screens read them)', () => {
  it('reads the status, mapping name to label and label to detail', () => {
    const s = readStatus({
      at: '2026-10-27T06:30:00Z', up: true, line: { ok: false, text: 'Founder WhatsApp is reconnecting' },
      parts: [
        { key: 'founder', name: 'Founder WhatsApp', state: 'warn', label: 'Reconnecting' },
        { key: 'claude', name: 'Claude spend', state: 'down', label: 'Daily cap reached' },
        { key: 'drive', name: 'Google Drive', state: 'ok', label: 'Connected' },
        { key: 'x', name: 'Odd', state: 'exploded', label: 7 },
      ],
      lastMessageAt: 'nonsense', spentToday: 1.5, capUsd: '3',
    });
    expect(s.isUp).toBe(true);
    expect(s.checkedAt).toBe('2026-10-27T06:30:00Z');
    expect(s.line).toEqual({ ok: false, text: 'Founder WhatsApp is reconnecting' });
    expect(s.parts[0]).toEqual({ key: 'founder', label: 'Founder WhatsApp', state: 'warn', detail: 'Reconnecting' });
    expect(s.parts[3]).toEqual({ key: 'x', label: 'Odd', state: 'off', detail: '7' });
    expect(s.lastMessageAt).toBeNull();
    expect(s.capUsd).toBe(0);
    expect(problems(s).map((p: { key: string }) => p.key)).toEqual(['claude', 'founder']);
  });

  it('reads the overview: open counts open plus overdue; done segments are this week', () => {
    const o = readOverview({
      clients: 2,
      tasks: { open: 5, overdue: 2, review: 1, doneThisWeek: 4 },
      byClient: [{ client: { code: 'SHA', name: 'Sharma' }, segments: [{ key: 'overdue', count: 2 }, { key: 'open', count: 3 }, { key: 'done', count: 4 }] }],
      meetings: [{ title: '', status: 'done', stageLabel: 'Summarised', when: '2026-10-27T05:30:00Z', minutes: 32 }],
      activity: [{ kind: 'task', title: 'New task', detail: 'Send invoice', who: 'Rohit', at: '2026-10-27T06:00:00Z' }],
      tracker: { lastPublishedAt: '2026-10-27T00:30:00Z', health: { ok: true, text: 'Published' } },
    });
    expect(o.totals).toEqual({ open: 7, overdue: 2, review: 1, doneThisWeek: 4 });
    expect(o.segments).toEqual([{ code: 'SHA', name: 'Sharma', overdue: 2, open: 3, review: 0, doneThisWeek: 4 }]);
    expect(o.meetings[0]).toEqual({ title: 'Internal meeting', status: 'done', statusLabel: 'Summarised', at: '2026-10-27T05:30:00Z', minutes: 32 });
    expect(o.tracker).toEqual({ lastPublishedAt: '2026-10-27T00:30:00Z', ok: true, label: 'Published' });
  });

  it('never throws on a missing or broken answer', () => {
    const hostile = { toString: 1, valueOf: 1 };
    const odd = { at: hostile, line: { text: hostile }, parts: [{ key: hostile, name: hostile, state: hostile, label: hostile }], founder: { device: hostile, label: hostile }, google: [{ label: hostile, usedFor: [hostile] }], meetings: [{ title: hostile }], byClient: [{ client: { name: hostile } }] };
    for (const bad of [null, undefined, 7, 'x', [], { tasks: 'x', byClient: {}, meetings: [null], parts: [null] }, odd]) {
      expect(() => readStatus(bad)).not.toThrow();
      expect(() => readOverview(bad)).not.toThrow();
      expect(() => readConnections(bad)).not.toThrow();
    }
    expect(readOverview(null).totals).toEqual({ open: 0, overdue: 0, review: 0, doneThisWeek: 0 });
    expect(readConnections(null).map((c: { id: string }) => c.id)).toEqual(['founder', 'spare', 'drive', 'claude', 'monitoring']);
  });

  it('reads the connections in order, with each Google account, and Claude at its cap as a warning', () => {
    const cards = readConnections({
      founder: { state: 'ok', label: 'Connected', groups: 3 },
      spare: { state: 'not_linked', label: 'Not linked', recipientMasked: '+91 •••• 1234' },
      google: [{ label: 'main', email: 'owner@example.com', state: 'ok', stateLabel: 'Connected', usedFor: ['Mail', 'Drive'] }, { label: 'org2', state: 'down', stateLabel: 'Sign in again' }],
      drive: { state: 'ok', label: 'Connected', account: 'owner@example.com' },
      claude: { callsToday: 12, spentToday: 3, capUsd: 3 },
      monitoring: { on: false },
    });
    expect(cards.map((c: { id: string }) => c.id)).toEqual(['founder', 'spare', 'google:main', 'google:org2', 'drive', 'claude', 'monitoring']);
    expect(cards[1].state).toBe('off');
    expect(cards[1].note).toMatch(/spare phone/);
    expect(cards[2].rows).toEqual([['Used for', 'Mail, Drive']]);
    // Each Google card is titled with its email (or says it is not known yet), its account name below.
    expect(cards[2]).toMatchObject({ title: 'owner@example.com', subtitle: 'Account name: main', email: 'owner@example.com', note: '' });
    expect(cards[3]).toMatchObject({ title: 'Google account', subtitle: 'Account name: org2', email: '', note: 'Email not known yet: press Reconnect to show it.' });
    expect(cards[4].rows[0]).toEqual(['Writes as', 'owner@example.com']);
    expect(cards[5]).toMatchObject({ state: 'warn', stateLabel: 'Daily cap reached' });
    expect(cards[6]).toMatchObject({ state: 'off', stateLabel: 'Off' });
    expect(JSON.stringify(cards)).not.toMatch(/sk-|apiKey|token/i);
  });
});

describe('the Drive card names the tracker file', () => {
  const drive = (d: unknown) => readConnections({ drive: d }).find((c: { id: string }) => c.id === 'drive');

  it('shows the file, the folder, the account and the last upload, and links Open in Drive only to a Drive file address', () => {
    const url = 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp_qr-st/view';
    const c = drive({ state: 'ok', label: 'Connected', lastUploadAt: null, file: 'Tracker.xlsx', folder: 'WA Agent', account: 'owner@example.com', url });
    expect(c.rows).toEqual([['Writes as', 'owner@example.com'], ['File', 'Tracker.xlsx'], ['Folder', 'WA Agent'], ['Last upload', 'Not uploaded yet']]);
    expect(c.link).toBe(url);
    for (const bad of ['https://evil.example/file/d/1AbCdEfGhIjKlMnOp_qr-st/view', 'javascript:alert(1)', 7, null]) {
      expect(drive({ url: bad }).link, String(bad)).toBe('');
    }
  });

  it('the Tracker screen and the Drive card escape the file, folder and account text', async () => {
    // dom.js reads matchMedia when it loads; the views themselves only build strings.
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    try {
      // @ts-expect-error -- browser module (see above)
      const { render } = await import('../../src/web/public/views/tracker.js');
      // @ts-expect-error -- browser module (see above)
      const { renderConnections } = await import('../../src/web/public/views/connections.js');
      const evil = '<img src=x onerror=1>@x';
      const html: string = render({
        uploaded: true, url: 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp_qr-st/view', file: { name: evil, folder: evil, account: evil },
        newFileAt: '2026-10-28T05:00:00.000Z', lastPublishedAt: null, lastFailure: null, failingSince: null, health: null, sheets: [],
      });
      const card: string = renderConnections([drive({ state: 'ok', file: evil, folder: evil, account: evil, url: 'javascript:alert(1)' })]);
      for (const out of [html, card]) {
        expect(out).toContain('&lt;img');
        expect(out).not.toContain('<img');
      }
      expect(html).toContain('data-new-file');
      expect(card).not.toContain('javascript:');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('says plainly when the account is not known yet, and falls back to the fixed names', () => {
    const c = drive({ state: 'ok' });
    expect(c.rows.slice(0, 3)).toEqual([['Writes as', 'Main Google account (email not known yet)'], ['File', 'Tracker.xlsx'], ['Folder', 'WA Agent']]);
  });
});

describe('Clients and Manage groups (D2)', () => {
  it("the drawer's field rules match the agent's", () => {
    expect([...BROWSER_PUBLIC].sort()).toEqual([...PUBLIC_MAIL_DOMAINS].sort());
    const ok = { name: 'Desai Foods', keywords: ['desai', 'dental website'], domains: ['desai.in'] };
    expect(fieldProblem(ok)).toBe('');
    expect(fieldProblem({ ...ok, name: '' })).toMatch(/name/);
    expect(fieldProblem({ ...ok, name: 'x'.repeat(81) })).toMatch(/80/);
    expect(fieldProblem({ ...ok, keywords: ['c++'] })).toMatch(/c\+\+/);
    expect(fieldProblem({ ...ok, keywords: Array.from({ length: 21 }, (_, i) => `keyword ${i}`) })).toMatch(/20/);
    expect(fieldProblem({ ...ok, domains: ['someone@desai.in'] })).toMatch(/not a domain/);
    expect(fieldProblem({ ...ok, domains: ['gmail.com'] })).toMatch(/public mail domain/);
  });

  it('reads the groups answer; a key that is not the agent\'s 24-hex key drops the row', () => {
    const g = readGroups({
      rows: [
        { key: 'a'.repeat(24), name: 'Desai Foods x Studio', approved: true, inWhatsApp: true, client: { name: 'Desai Foods', code: 'DES', active: true, hasTasks: true, codeLocked: true, emailDomains: ['desai.in'], meetingKeywords: [] } },
        { key: '120363000000000001@g.us', name: 'raw id', approved: false, client: null },
        { key: 'b'.repeat(24), name: { toString: 1 }, approved: 'yes', inWhatsApp: false, client: null },
      ],
      total: 3, counts: { all: 250, approved: 1, notApproved: 249 }, stale: true, reason: 'nonsense', fetchedAt: '2026-10-27T06:00:00Z',
    });
    expect(g.rows.map((r: { key: string }) => r.key)).toEqual(['a'.repeat(24), 'b'.repeat(24)]);
    expect(g.rows[0].client).toMatchObject({ code: 'DES', codeLocked: true, emailDomains: ['desai.in'] });
    expect(g.rows[1]).toEqual({ key: 'b'.repeat(24), name: '', approved: false, inWhatsApp: false, ignored: false, client: null });
    expect(g).toMatchObject({ counts: { all: 250, approved: 1, notApproved: 249 }, stale: true, reason: null });
    expect(() => readGroups(null)).not.toThrow();
    // An approved row is never shown as ignored, whatever the answer says.
    expect(readGroups({ rows: [{ key: 'c'.repeat(24), name: 'x', approved: true, ignored: true }] }).rows[0].ignored).toBe(false);
  });

  it('reads a bulk answer: the list, and one result per group with a well-formed key', () => {
    const b = readBulk({
      rows: [{ key: 'a'.repeat(24), name: 'Desai Foods', approved: false, ignored: true }], counts: { all: 3, approved: 1, notApproved: 1, ignored: 1 },
      results: [{ key: 'a'.repeat(24), ok: true, reason: null }, { key: 'b'.repeat(24), ok: 'yes', reason: 'No code could be made from its name.' }, { key: 'raw@g.us', ok: true }],
    });
    expect(b.list.rows[0]).toMatchObject({ ignored: true });
    expect(b.list.counts).toEqual({ all: 3, approved: 1, notApproved: 1, ignored: 1 });
    expect(b.results).toEqual([
      { key: 'a'.repeat(24), ok: true, reason: '' },
      { key: 'b'.repeat(24), ok: false, reason: 'No code could be made from its name.' },
    ]);
    expect(readBulk(null).results).toEqual([]);
  });

  it('reads a chat page: odd kinds and states are made safe, a message without an id or time is dropped', () => {
    const c = readChat({
      client: { code: 'SHA', name: 'Sharma', groupName: 'Sharma x Studio' }, sendingOn: true, connected: 'yes', hasOlder: true,
      messages: [
        { id: 7, at: '2026-10-29T08:00:00Z', mine: false, sender: 'Rahul', text: '<b>hi</b>', kind: 'voice', seconds: 42, transcript: 'call me', quote: { sender: 'Neha', text: 'q', kind: 'weird' } },
        { id: 0, at: '2026-10-29T08:00:00Z' }, { id: 8, at: 'not a time' }, { id: 9, at: '2026-10-29T08:01:00Z', kind: 'script', sender: '' },
      ],
      outbox: [{ uuid: 'u1', at: '2026-10-29T08:02:00Z', text: 'x', state: 'exploded' }, { uuid: '', at: '2026-10-29T08:02:00Z' }],
    });
    expect(c).toMatchObject({ client: { groupName: 'Sharma x Studio' }, sendingOn: true, connected: false, hasOlder: true });
    expect(c.messages.map((m: { id: number }) => m.id)).toEqual([7, 9]);
    expect(c.messages[0]).toMatchObject({ text: '<b>hi</b>', kind: 'voice', seconds: 42, transcript: 'call me', quote: { sender: 'Neha', kind: 'text' } });
    expect(c.messages[1]).toMatchObject({ kind: 'text', sender: 'Someone', quote: null });
    expect(c.outbox).toEqual([{ uuid: 'u1', at: '2026-10-29T08:02:00Z', text: 'x', state: 'unknown', quote: null }]);
    expect(readSendResult({ message: { uuid: 'u1', at: '2026-10-29T08:02:00Z', text: 'x', state: 'sent' }, replayed: true })).toMatchObject({ message: { state: 'sent' }, replayed: true });
    expect(() => readChat(null)).not.toThrow();
  });

  it('reads clients and a client, with the phase position', () => {
    const [c] = readClients({ clients: [{ code: 'DES', name: 'Desai', groupName: '', counts: { open: 2 }, phases: ['A', 'B', 'C'], currentPhase: 'B', lastActivity: null, sheetName: 'Desai' }, { name: 'no code' }] });
    expect(c).toMatchObject({ code: 'DES', groupName: 'Desai', phaseIndex: 1, counts: { open: 2, overdue: 0, review: 0, doneThisWeek: 0 } });
    expect(readClients({ clients: [{ name: 'no code' }] })).toEqual([]);
    // Reading earlier messages: only the three known states, with a count; anything else is no line at all.
    expect(c.history).toBeNull();
    const h = (history: unknown) => readClients({ clients: [{ code: 'DES', name: 'Desai', history }] })[0]!.history;
    expect(h({ state: 'reading', found: 12 })).toEqual({ state: 'reading', found: 12 });
    expect(h({ state: 'done', found: 'x' })).toEqual({ state: 'done', found: 0 });
    expect(h({ state: '<b>', found: 3 })).toBeNull();
    const d = readClientDetail({ client: { code: 'DES', name: 'Desai', meetings: [{ id: 1, startedAt: '2026-10-27T06:00:00Z', title: '', status: 'done' }], openTasks: [{ code: 'DES-001', title: 'Quote', assignedTo: null, deadline: null, status: 'open' }] } });
    expect(d.meetings[0].title).toBe('Untitled meeting');
    expect(d.openTasks[0]).toEqual({ code: 'DES-001', title: 'Quote', assignedTo: null, deadline: null, status: 'open', priority: null, sentiment: null });
    expect(d.sentiment).toBeNull();
    // Priority and mood: only the known words; anything else is none.
    const mood = readClientDetail({ client: { code: 'DES', sentiment: { mood: 'frustrated', at: '2026-10-27T06:00:00Z' }, openTasks: [
      { code: 'DES-002', priority: 'critical', sentiment: 'positive' }, { code: 'DES-003', priority: '<b>', sentiment: 'angry' }] } });
    expect(mood.sentiment).toEqual({ mood: 'frustrated', at: '2026-10-27T06:00:00Z' });
    expect(mood.openTasks.map((t: { priority: unknown; sentiment: unknown }) => [t.priority, t.sentiment])).toEqual([['critical', 'positive'], [null, null]]);
    expect(readClientDetail({ client: { code: 'DES', sentiment: { mood: 'sad' } } }).sentiment).toBeNull();
    expect(() => readClientDetail(undefined)).not.toThrow();
  });
});

describe('owner fixes: Sync tracker now and account emails', () => {
  it('the shared quick-action button names its action and escapes what it is given', async () => {
    // @ts-expect-error -- browser module (see the top of this file)
    const { quickButton } = await import('../../src/web/public/views/connect.js');
    const html = quickButton('upload-tracker', 'refresh', 'Sync tracker now') as string;
    expect(html).toMatch(/^<button class="btn btn-sm btn-ghost" type="button" data-action="upload-tracker">/);
    expect(html).toContain('Sync tracker now');
    expect(quickButton('x"><b>', 'refresh', '<i>hi</i>')).not.toMatch(/<b>|<i>/);
  });

  it('an account email reaches the Connections card escaped, as text', async () => {
    // @ts-expect-error -- browser module (see the top of this file)
    const { renderConnections } = await import('../../src/web/public/views/connections.js');
    const cards = readConnections({ google: [{ label: 'main', email: 'a"<b>&x@evil.example', state: 'ok', usedFor: ['Tracker on Drive'] }], drive: { account: '<i>@x.example' } });
    const html = renderConnections(cards) as string;
    expect(html).toContain('a&quot;&lt;b&gt;&amp;x@evil.example');
    expect(html).toContain('&lt;i&gt;@x.example');
    expect(html).not.toMatch(/<b>&|<i>@/);
  });
});
