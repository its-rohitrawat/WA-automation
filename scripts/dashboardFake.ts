// The real dashboard web server with made-up API answers, for the smoke test and the local preview. Nothing here touches
// the agent, WhatsApp, Google, a database or any data folder: the owner session is a flag and the answers are fixed fake
// data in the agent's shapes (D1 tasks 5 and 6).
import { readJson, sendError, sendJson } from '../src/web/http.ts';
import { createWebServer } from '../src/web/server.ts';
import type { WebServer } from '../src/web/server.ts';
import { systemClock } from '../src/util/clock.ts';
import { silentLogger } from '../src/util/logger.ts';
import type { Logger } from '../src/util/logger.ts';
import type { ServerResponse } from 'node:http';

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

/** The fake session's CSRF token (it guards nothing real). */
export const FAKE_CSRF = 'fake-csrf';

/** Made-up answers. `empty` is a new install: no clients, tasks or meetings yet. */
export const fixtures = (empty: boolean) => ({
  status: {
    at: at(0), up: true, line: { ok: false, text: 'Spare WhatsApp is not linked' },
    parts: [
      { key: 'founder', name: 'Founder WhatsApp', state: 'ok', label: 'Connected' },
      { key: 'spare', name: 'Spare WhatsApp', state: 'warn', label: 'Not linked' },
      { key: 'google', name: 'Google', state: 'ok', label: 'Connected' },
      { key: 'claude', name: 'Claude spend', state: 'ok', label: '$0.84 of $3.00' },
    ],
    lastMessageAt: at(3), spentToday: 0.84, capUsd: 3,
  },
  overview: empty
    ? { clients: 0, tasks: { open: 0, overdue: 0, review: 0, doneThisWeek: 0 }, byClient: [], meetings: [], activity: [], tracker: null }
    : {
        clients: 3,
        tasks: { open: 9, overdue: 2, review: 1, doneThisWeek: 6 },
        byClient: [
          { client: { code: 'ACM', name: 'Acme Traders' }, segments: [{ key: 'overdue', count: 2 }, { key: 'open', count: 4 }, { key: 'done', count: 3 }] },
          { client: { code: 'BLU', name: 'Blue Harbour Logistics With A Very Long Name' }, segments: [{ key: 'open', count: 5 }, { key: 'review', count: 1 }] },
          { client: { code: 'CED', name: 'Cedar' }, segments: [{ key: 'done', count: 3 }] },
        ],
        meetings: [
          { title: 'Weekly review', status: 'done', stageLabel: 'Summarised', when: at(90), minutes: 42 },
          { title: '', status: 'processing', stageLabel: 'Transcribing', when: at(20), minutes: null },
        ],
        activity: [
          { kind: 'task', title: 'New task', detail: 'Send the revised quote', who: 'Acme Traders', at: at(12) },
          { kind: 'msg', title: 'Message read', detail: '<b>not bold</b>', who: 'Blue Harbour', at: at(30) },
          { kind: 'issue', title: 'Spare WhatsApp not linked', detail: '', who: '', at: at(60) },
        ],
        tracker: { lastPublishedAt: at(300), health: { ok: true, text: 'Published to Drive' } },
      },
  connections: {
    founder: { state: 'ok', label: 'Connected', groups: 3, lastActivityAt: at(3) },
    spare: { state: 'not_linked', label: 'Not linked', recipientMasked: '•••• 0000' },
    google: [
      { label: 'main', email: 'owner@example.com', state: 'ok', stateLabel: 'Connected', usedFor: ['Mail', 'Drive', 'Meetings'] },
      { label: 'org2', email: 'meetings@example.org', state: 'down', stateLabel: 'Sign in again', usedFor: ['Meetings'] },
    ],
    drive: { state: 'ok', label: 'Connected', lastUploadAt: at(300) },
    claude: { callsToday: 41, spentToday: 0.84, capUsd: 3 },
    monitoring: { on: true, lastBeatAt: at(1) },
  },
});

/** What the fake answers depend on; the caller may change it at any time. */
export interface FakeState {
  signedIn: boolean;
  empty: boolean;
  /** Manage groups shows the "WhatsApp isn't connected" banner. */
  whatsappDown?: boolean;
}

interface FakeClient {
  name: string;
  code: string;
  active: boolean;
  hasTasks: boolean;
  emailDomains: string[];
  meetingKeywords: string[];
}
interface FakeGroup {
  key: string;
  name: string;
  approved: boolean;
  client: FakeClient | null;
}

const WORDS = ['Desai', 'Iyer', 'Kapoor', 'Mehta', 'Rao', 'Shah', 'Verma', 'Nair', 'Joshi', 'Patel', 'Gupta', 'Reddy', 'Bose', 'Malhotra', 'Sethi'];
const KINDS = ['Foods', 'Dental', 'Builders', 'Textiles', 'Studio', 'Exports', 'Clinic', 'Realty', 'Motors', 'Logistics', 'Pharma', 'Cafe', 'Family', 'Society', 'Alumni'];

/** 250 made-up groups: three tracked (the Overview's clients), a former client, an odd name, the rest untracked. */
function makeGroups(): FakeGroup[] {
  const key = (i: number) => i.toString(16).padStart(24, '0');
  const client = (name: string, code: string): FakeClient => ({ name, code, active: true, hasTasks: true, emailDomains: [], meetingKeywords: [] });
  const groups: FakeGroup[] = [
    { key: key(1), name: 'Acme Traders x Studio', approved: true, client: client('Acme Traders', 'ACM') },
    { key: key(2), name: 'Blue Harbour Logistics With A Very Long Name – project room', approved: true, client: client('Blue Harbour Logistics With A Very Long Name', 'BLU') },
    { key: key(3), name: 'Cedar', approved: true, client: { ...client('Cedar', 'CED'), meetingKeywords: ['cedar'], emailDomains: ['cedar.example'] } },
    // A group removed earlier: the agent sends its former client so the code stays (src/control/groups.ts).
    { key: key(4), name: 'Old Client (left)', approved: false, client: { ...client('Old Client', 'OLD'), active: false } },
    { key: key(5), name: '<b>Not bold</b> & "quoted" group', approved: false, client: null },
  ];
  for (let i = 0; groups.length < 250; i++) {
    const a = WORDS[i % WORDS.length]!;
    const b = KINDS[Math.floor(i / WORDS.length) % KINDS.length]!;
    groups.push({ key: key(groups.length + 1), name: `${a} ${b}${i % 7 === 0 ? ' x Studio' : ''}`, approved: false, client: null });
  }
  return groups;
}

const fold = (s: string) => s.toLowerCase();

type ApplyBody = {
  approve?: { key: string; name: string; code: string; emailDomains?: string[]; meetingKeywords?: string[] }[];
  unapprove?: string[];
  edit?: { key: string; name?: string; emailDomains?: string[]; meetingKeywords?: string[] }[];
};

/** The fake directory and clients: what Manage groups and Clients read and change. */
function fakeGroupsApi(state: FakeState) {
  const groups = makeGroups();
  let fetchedAt = at(2);
  const used = () => new Set(groups.flatMap((g) => (g.client ? [g.client.code] : [])));
  const overview = (q: string) => {
    const rows = groups
      .filter((g) => !q || fold(g.name).includes(fold(q)) || (g.client !== null && (fold(g.client.name).includes(fold(q)) || fold(g.client.code).includes(fold(q)))))
      // As the agent: a client row exists for every client here, so its code is locked; unapproved ones send no keywords.
      .map((g) => ({ key: g.key, name: g.name, approved: g.approved, inWhatsApp: true, client: g.client && { ...g.client, codeLocked: true, ...(g.approved ? {} : { emailDomains: [], meetingKeywords: [] }) } }));
    const approved = groups.filter((g) => g.approved).length;
    return {
      rows, total: rows.length, counts: { all: groups.length, approved, notApproved: groups.length - approved },
      stale: Boolean(state.whatsappDown), reason: state.whatsappDown ? 'whatsapp_not_connected' : null, fetchedAt,
    };
  };
  const suggest = (name: string) => {
    const words = name.toUpperCase().replace(/[^A-Z ]/g, ' ').split(/\s+/).filter(Boolean);
    const taken = used();
    const tries = [words[0]?.slice(0, 3), words.map((w) => w[0]).join('').slice(0, 4), words[0]?.slice(0, 4)];
    return tries.find((c) => c !== undefined && c.length >= 3 && !taken.has(c)) ?? null;
  };
  /** Applies a save; a code already in use refuses the whole save, as the real writer does. */
  const apply = (b: ApplyBody): { message: string; key: string; field: string } | null => {
    const taken = used();
    for (const a of b.approve ?? []) {
      const g = groups.find((x) => x.key === a.key);
      if (g && !g.client && taken.has(a.code)) return { message: `The code ${a.code} is already used by another client. Choose another.`, key: a.key, field: 'code' };
      // The browser cannot know every code (a client whose group left WhatsApp is not listed): ZZZ stands for one.
      if (a.code === 'ZZZ') return { message: 'The code ZZZ is already used by a client whose group is no longer in WhatsApp. Choose another.', key: a.key, field: 'code' };
    }
    for (const a of b.approve ?? []) {
      const g = groups.find((x) => x.key === a.key);
      if (!g) continue;
      g.approved = true;
      g.client = g.client
        ? { ...g.client, name: a.name, active: true }
        : { name: a.name, code: a.code, active: false, hasTasks: false, emailDomains: a.emailDomains ?? [], meetingKeywords: a.meetingKeywords ?? [] };
    }
    for (const k of b.unapprove ?? []) {
      const g = groups.find((x) => x.key === k);
      if (g) {
        g.approved = false;
        if (g.client) g.client.active = false;
      }
    }
    for (const e of b.edit ?? []) {
      const c = groups.find((x) => x.key === e.key)?.client;
      if (c) Object.assign(c, { name: e.name ?? c.name, emailDomains: e.emailDomains ?? c.emailDomains, meetingKeywords: e.meetingKeywords ?? c.meetingKeywords });
    }
    return null;
  };
  const COUNTS = [{ open: 6, overdue: 2, review: 0, doneThisWeek: 3 }, { open: 6, overdue: 0, review: 1, doneThisWeek: 0 }, { open: 0, overdue: 0, review: 0, doneThisWeek: 3 }];
  const clientCards = () =>
    state.empty
      ? []
      : groups
          .filter((g) => g.approved && g.client)
          .map((g, i) => ({
            code: g.client!.code, name: g.client!.name, groupName: g.name,
            counts: COUNTS[i] ?? { open: 0, overdue: 0, review: 0, doneThisWeek: 0 },
            phases: ['Discovery', 'Design', 'Build', 'Launch'], currentPhase: ['Design', 'Build', 'Launch'][i] ?? null,
            lastActivity: i < 3 ? at(12 * (i + 1)) : null, sheetName: g.client!.name.slice(0, 31),
          }));
  const detail = (code: string) => {
    const c = clientCards().find((x) => x.code === code);
    if (!c) return null;
    return {
      ...c,
      openTasks: c.counts.open
        ? [
            { code: `${code}-004`, title: 'Send the revised quote', assignedTo: 'Rohit', deadline: at(60 * 24 * 2).slice(0, 10), status: 'open' },
            { code: `${code}-007`, title: 'Share moodboard v2', assignedTo: null, deadline: at(-60 * 24 * 3).slice(0, 10), status: 'open' },
            { code: `${code}-009`, title: 'Confirm the launch date', assignedTo: 'Arjun', deadline: null, status: 'maybe_done' },
          ]
        : [],
      meetings: code === 'ACM' ? [{ id: 1, startedAt: at(90), title: 'Weekly review', status: 'done' }, { id: 2, startedAt: at(20), title: '', status: 'queued' }] : [],
      lastSyncAt: at(3),
    };
  };
  return { overview, suggest, apply, clientCards, detail, refresh: () => (fetchedAt = at(0)) };
}

/**
 * The web server (not started) with the fake API and sign-in. "Continue with Google" signs straight in and returns to
 * the screen asked for (a /dashboard path only); sign-out needs the fake CSRF token, like the real one.
 */
export function fakeDashboard(o: { port: number; state: FakeState; log?: Logger }): WebServer {
  const { state } = o;
  const web = createWebServer({ control: {}, env: { DASHBOARD_PORT: o.port }, log: o.log ?? silentLogger(), clock: systemClock });
  const guarded = (body: () => unknown) => (ctx: { res: ServerResponse }) => {
    if (!state.signedIn) return sendError(ctx.res, 401, 'unauthenticated', 'Sign in first.');
    sendJson(ctx.res, 200, body());
  };
  web.router.get('/dashboard/api/me', guarded(() => ({ email: 'owner@example.com', name: 'Test Owner', signedInAt: at(5), expiresAt: at(-600), csrf: FAKE_CSRF })));
  web.router.get('/dashboard/api/status', guarded(() => fixtures(state.empty).status));
  web.router.get('/dashboard/api/overview', guarded(() => fixtures(state.empty).overview));
  web.router.get('/dashboard/api/connections', guarded(() => fixtures(state.empty).connections));
  const g = fakeGroupsApi(state);
  web.router.get('/dashboard/api/clients', guarded(() => ({ clients: g.clientCards() })));
  web.router.get('/dashboard/api/clients/:code', ({ res, params }) => {
    if (!state.signedIn) return sendError(res, 401, 'unauthenticated', 'Sign in first.');
    const client = g.detail(params.code ?? '');
    if (!client) return sendError(res, 404, 'not_found', 'There is no active client with this code.');
    sendJson(res, 200, { client });
  });
  web.router.get('/dashboard/api/groups', ({ res, url }) => {
    if (!state.signedIn) return sendError(res, 401, 'unauthenticated', 'Sign in first.');
    if (url.searchParams.get('refresh') === '1' && !state.whatsappDown) g.refresh();
    sendJson(res, 200, g.overview(url.searchParams.get('q') ?? ''));
  });
  web.router.get('/dashboard/api/groups/suggest-code', ({ res, url }) => {
    if (!state.signedIn) return sendError(res, 401, 'unauthenticated', 'Sign in first.');
    sendJson(res, 200, { code: g.suggest(url.searchParams.get('name') ?? '') });
  });
  web.router.post('/dashboard/api/groups/apply', async ({ req, res }) => {
    if (!state.signedIn) return sendError(res, 401, 'unauthenticated', 'Sign in first.');
    if (req.headers['x-csrf-token'] !== FAKE_CSRF) return sendError(res, 403, 'csrf', 'Refused.');
    const refused = g.apply((await readJson(req)) as Parameters<typeof g.apply>[0]);
    if (refused) return sendJson(res, 422, { error: { code: 'group_change', ...refused } });
    sendJson(res, 200, g.overview(''));
  });
  web.router.get('/dashboard/auth/login', ({ res, url }) => {
    const back = url.searchParams.get('return') ?? '';
    state.signedIn = true;
    res.writeHead(303, { Location: /^\/dashboard(\/[a-z][a-z0-9-]{0,39}){0,2}$/.test(back) ? back : '/dashboard' }).end();
  });
  web.router.post('/dashboard/auth/logout', ({ req, res }) => {
    if (req.headers['x-csrf-token'] !== FAKE_CSRF) return sendError(res, 403, 'csrf', 'Refused.');
    state.signedIn = false;
    res.writeHead(204).end();
  });
  return web;
}
