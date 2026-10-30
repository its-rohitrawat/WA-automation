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
import { randomBytes } from 'node:crypto';
import { renderQrSvg } from '../src/web/qrSvg.ts';
import { mountFakeScreens } from './dashboardScreensFake.ts';

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

/** The fake session's CSRF token (it guards nothing real). */
export const FAKE_CSRF = 'fake-csrf';

/** The status parts (the agent's keys: whatsapp, tracker, meetings, voice, report, spend), from the fake's flags. */
function statusParts(st: FakeState) {
  return [
    st.setup ? { key: 'whatsapp', name: 'WhatsApp', state: 'down', label: 'Not linked' } : { key: 'whatsapp', name: 'WhatsApp', state: 'ok', label: 'Connected' },
    { key: 'tracker', name: 'Tracker', state: 'ok', label: 'Updated' },
    st.org2Ok ? { key: 'meetings', name: 'Meetings', state: 'ok', label: 'Working' } : { key: 'meetings', name: 'Meetings', state: 'warn', label: 'Google sign-in lost for org2' },
    { key: 'voice', name: 'Voice notes', state: 'off', label: 'Switched off' },
    st.spareLinked ? { key: 'report', name: 'Morning report', state: 'ok', label: 'On' } : { key: 'report', name: 'Morning report', state: 'warn', label: 'The spare phone is not linked' },
    { key: 'spend', name: 'AI spend', state: 'ok', label: 'Within the daily limit' },
  ];
}

/** Made-up answers. `empty` is a new install: no clients, tasks or meetings yet. */
export const fixtures = (st: FakeState) => {
  const empty = st.empty;
  const parts = statusParts(st);
  const worst = parts.find((x) => x.state === 'down') ?? parts.find((x) => x.state === 'warn');
  return {
  status: {
    at: at(0), up: true, line: worst ? { ok: false, text: `${worst.name}: ${worst.label}` } : { ok: true, text: 'All systems normal' },
    parts,
    lastMessageAt: st.setup ? null : at(3), spentToday: 0.84, capUsd: 3,
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
    founder: st.setup ? { state: 'down', label: 'Not linked', groups: 0, lastActivityAt: null } : { state: 'ok', label: 'Connected', groups: 3, lastActivityAt: at(3) },
    spare: st.spareLinked ? { state: 'ok', label: 'Connected', recipientMasked: '•••• 0000' } : { state: 'warn', label: 'Not linked', recipientMasked: '•••• 0000' },
    google: [
      { label: 'main', email: 'owner@example.com', state: 'ok', stateLabel: 'Connected', usedFor: ['Mail', 'Drive', 'Meetings'] },
      st.org2Ok
        ? { label: 'org2', email: 'meetings@example.org', state: 'ok', stateLabel: 'Connected', usedFor: ['Meetings'] }
        : { label: 'org2', email: 'meetings@example.org', state: 'down', stateLabel: 'Sign in again', usedFor: ['Meetings'] },
    ],
    drive: {
      state: 'ok', label: 'Connected', lastUploadAt: at(300), file: 'Tracker.xlsx', folder: 'WA Agent', account: 'owner@example.com',
      url: 'https://drive.google.com/file/d/1FakeTrackerFileId_000/view',
    },
    claude: { callsToday: 41, spentToday: 0.84, capUsd: 3 },
    monitoring: { on: true, lastBeatAt: at(1) },
  },
  };
};

/** What the fake answers depend on; the caller may change it at any time. */
export interface FakeState {
  signedIn: boolean;
  empty: boolean;
  /** Manage groups shows the "WhatsApp isn't connected" banner. */
  whatsappDown?: boolean;
  /** Setup mode: the founder's phone was never linked. A fake link clears it. */
  setup?: boolean;
  /** The spare phone is linked (a fake link sets it). */
  spareLinked?: boolean;
  /** The org2 Google account is signed in (a fake reconnect sets it). */
  org2Ok?: boolean;
  /** Quick actions answer 429, as the agent does past 5 tries a minute. */
  rateLimited?: boolean;
}

/** A fake phone link: two codes, a scan, then linked (and the fake flags updated). */
function fakeLinks(state: FakeState) {
  const links = new Map<string, { target: 'founder' | 'spare'; cancelled: boolean }>();
  const stream = (id: string, res: ServerResponse) => {
    const link = links.get(id);
    if (!link) return sendError(res, 404, 'not_found', 'Unknown link.');
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const steps: [number, () => void][] = [
      [300, () => send('state', { state: 'waiting_qr', label: 'Getting a code from WhatsApp…' })],
      [700, () => send('qr', { svg: renderQrSvg(`fake-link-${id}-1`) })],
      [2600, () => send('qr', { svg: renderQrSvg(`fake-link-${id}-2`) })],
      [4200, () => send('state', { state: 'opening', label: 'Scanned. Linking…' })],
      [5600, () => {
        if (link.target === 'founder') state.setup = false;
        else state.spareLinked = true;
        send('done', { device: link.target === 'founder' ? 'WA Agent - Tracker' : 'WA Agent - Morning report' });
        res.end();
      }],
    ];
    const timers = steps.map(([ms, fn]) => setTimeout(() => {
      if (!link.cancelled && !res.writableEnded) fn();
    }, ms));
    res.on('close', () => timers.forEach(clearTimeout));
  };
  return { links, stream };
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
  ignored?: boolean;
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
    // No Latin letters: a bulk approve cannot make a code for it, as the agent cannot (routes/groups.ts codeCandidates).
    { key: key(6), name: 'शर्मा परिवार', approved: false, client: null },
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

/** The client drawer's "what the agent has seen" block (the agent's ClientActivity shape), made up per client. */
function activityFor(c: { code: string; lastActivity: string | null; history: { state: string; found: number } | null; pulse: { pending: number; lastReadAt: string | null; quietMinutes: number } }) {
  if (!c.lastActivity) {
    return { pending: 0, quietMinutes: 4, lastBatch: null, taskCount: 0, week: { messages: 0, people: 0, files: 0, voice: 0 }, latest: [], approvedAt: at(5), history: { state: 'waiting', found: 0 } };
  }
  return {
    pending: c.pulse.pending,
    quietMinutes: c.pulse.quietMinutes,
    lastBatch: c.pulse.lastReadAt ? { at: c.pulse.lastReadAt, messages: 6, taskChanges: c.code === 'ACM' ? 2 : 0 } : null,
    taskCount: c.code === 'CED' ? 0 : 3, // Cedar: no task was ever found
    week: { messages: 42, people: 5, files: 3, voice: 2 },
    latest: [
      { sender: 'Rahul Kapoor', kind: 'image', text: 'Site photos from today', seconds: null, transcribed: false, at: at(12) },
      { sender: 'Neha', kind: 'text', text: 'Thanks! Will check with the client tomorrow morning <b>not bold</b> and a long tail '.repeat(2), seconds: null, transcribed: false, at: at(14) },
      { sender: 'Ajay Jain', kind: 'voice', text: '', seconds: 42, transcribed: true, at: at(19) },
    ],
    approvedAt: at(60 * 24 * 3),
    history: c.history ? { state: c.history.state === 'reading' ? 'fetching' : c.history.state, found: c.history.found } : { state: 'done', found: 42 },
  };
}

/** The fake directory and clients: what Manage groups and Clients read and change. */
function fakeGroupsApi(state: FakeState) {
  const groups = makeGroups();
  let fetchedAt = at(2);
  const used = () => new Set(groups.flatMap((g) => (g.client ? [g.client.code] : [])));
  const overview = (q: string) => {
    const rows = groups
      .filter((g) => !q || fold(g.name).includes(fold(q)) || (g.client !== null && (fold(g.client.name).includes(fold(q)) || fold(g.client.code).includes(fold(q)))))
      // As the agent: a client row exists for every client here, so its code is locked; unapproved ones send no keywords.
      .map((g) => ({
        key: g.key, name: g.name, approved: g.approved, inWhatsApp: true, ignored: !g.approved && Boolean(g.ignored),
        client: g.client && { ...g.client, codeLocked: true, ...(g.approved ? {} : { emailDomains: [], meetingKeywords: [] }) },
      }));
    const approved = groups.filter((g) => g.approved).length;
    const ignored = groups.filter((g) => !g.approved && g.ignored).length;
    return {
      rows, total: rows.length, counts: { all: groups.length, approved, notApproved: groups.length - approved - ignored, ignored },
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
  /** A bulk approve or ignore, group by group, as the agent's /groups/bulk: one failing does not stop the others. */
  const bulk = (action: string, keys: string[]) =>
    keys.map((key) => {
      const g = groups.find((x) => x.key === key);
      if (!g) return { key, ok: false, reason: 'Not in the list.' };
      if (action !== 'approve') {
        if (g.approved) return { key, ok: false, reason: 'It is tracked. Remove it from the agent first.' };
        g.ignored = action === 'ignore';
        return { key, ok: true, reason: null };
      }
      if (g.approved) return { key, ok: false, reason: 'It is tracked already.' };
      const name = g.client?.name ?? (g.name.split(/\s+[x×–-]\s+/i)[0]?.trim() || g.name.trim()).slice(0, 80);
      const code = g.client?.code ?? suggest(name);
      if (!code) return { key, ok: false, reason: 'No code could be made from its name. Approve it on its own to choose one.' };
      g.approved = true;
      g.ignored = false;
      g.client = g.client ? { ...g.client, active: true } : { name, code, active: false, hasTasks: false, emailDomains: [], meetingKeywords: [] };
      return { key, ok: true, reason: null };
    });
  const COUNTS =[{ open: 6, overdue: 2, review: 0, doneThisWeek: 3 }, { open: 6, overdue: 0, review: 1, doneThisWeek: 0 }, { open: 0, overdue: 0, review: 0, doneThisWeek: 3 }];
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
            // Acme: new messages waiting (busy); Blue Harbour: reading its last 7 days (busy); Cedar (no tasks): up to date.
            history: i === 1 ? { state: 'reading', found: 18 } : null,
            pulse: { pending: i === 0 ? 3 : 0, lastReadAt: i < 3 ? at([20, 30, 3][i]!) : null, quietMinutes: 4 },
          }));
  const detail = async (code: string) => {
    const c = (await clientCards()).find((x) => x.code === code);
    if (!c) return null;
    return {
      ...c,
      // Sentiment is on in the fake: Acme's latest batch read as frustrated.
      sentiment: code === 'ACM' ? { mood: 'frustrated', at: at(3) } : null,
      openTasks: c.counts.open
        ? [
            { code: `${code}-004`, title: 'Send the revised quote', assignedTo: 'Rohit', deadline: at(60 * 24 * 2).slice(0, 10), status: 'open', priority: 'critical', sentiment: 'frustrated' },
            { code: `${code}-007`, title: 'Share moodboard v2', assignedTo: null, deadline: at(-60 * 24 * 3).slice(0, 10), status: 'open', priority: 'medium', sentiment: 'neutral' },
            { code: `${code}-009`, title: 'Confirm the launch date', assignedTo: 'Arjun', deadline: null, status: 'maybe_done', priority: null, sentiment: null },
          ]
        : [],
      meetings: code === 'ACM' ? [{ id: 1, startedAt: at(90), title: 'Weekly review', status: 'done' }, { id: 2, startedAt: at(20), title: '', status: 'queued' }] : [],
      lastSyncAt: at(3),
      activity: activityFor(c),
    };
  };
  return { overview, suggest, apply, bulk, clientCards, detail, refresh: () => (fetchedAt = at(0)) };
}

/**
 * The web server (not started) with the fake API and sign-in. "Continue with Google" signs straight in and returns to
 * the screen asked for (a /dashboard path only); sign-out needs the fake CSRF token, like the real one.
 */
export async function fakeDashboard(o: { port: number; state: FakeState; log?: Logger }): Promise<WebServer> {
  const { state } = o;
  const web = createWebServer({ control: {}, env: { DASHBOARD_PORT: o.port }, log: o.log ?? silentLogger(), clock: systemClock });
  // Tasks, Meetings, Activity, Tracker, AI usage, Automations, Audit logs and Settings: the real routes on an in-memory db.
  await mountFakeScreens(web, { signedIn: () => state.signedIn, csrf: FAKE_CSRF });
  const guarded = (body: () => unknown) => (ctx: { res: ServerResponse }) => {
    if (!state.signedIn) return sendError(ctx.res, 401, 'unauthenticated', 'Sign in first.');
    sendJson(ctx.res, 200, body());
  };
  web.router.get('/dashboard/api/me', guarded(() => ({ email: 'owner@example.com', name: 'Test Owner', signedInAt: at(5), expiresAt: at(-600), csrf: FAKE_CSRF })));
  web.router.get('/dashboard/api/status', guarded(() => fixtures(state).status));
  web.router.get('/dashboard/api/overview', guarded(() => fixtures(state).overview));
  web.router.get('/dashboard/api/connections', guarded(() => fixtures(state).connections));
  const owner = (req: { headers: Record<string, unknown> }, res: ServerResponse, csrf = true) => {
    if (!state.signedIn) return sendError(res, 401, 'unauthenticated', 'Sign in first.'), false;
    if (csrf && req.headers['x-csrf-token'] !== FAKE_CSRF) return sendError(res, 403, 'csrf', 'Refused.'), false;
    return true;
  };
  const wa = fakeLinks(state);
  web.router.post('/dashboard/api/whatsapp/link/start', async ({ req, res }) => {
    if (!owner(req, res)) return;
    const b = (await readJson(req)) as { target?: unknown; confirm?: unknown };
    if ((b.target !== 'founder' && b.target !== 'spare') || b.confirm !== true) return sendError(res, 400, 'invalid', 'Choose the founder or the spare phone, and confirm.');
    const linkId = randomBytes(16).toString('hex');
    wa.links.set(linkId, { target: b.target, cancelled: false });
    sendJson(res, 200, { linkId });
  });
  web.router.get('/dashboard/api/whatsapp/link/stream', ({ req, res, url }) => {
    if (owner(req, res, false)) wa.stream(url.searchParams.get('id') ?? '', res);
  });
  web.router.post('/dashboard/api/whatsapp/link/cancel', async ({ req, res }) => {
    if (!owner(req, res)) return;
    const link = wa.links.get(String(((await readJson(req)) as { linkId?: unknown }).linkId ?? ''));
    if (link) link.cancelled = true;
    sendJson(res, 200, { cancelled: Boolean(link) });
  });
  web.router.post('/dashboard/api/google/connect', async ({ req, res }) => {
    if (!owner(req, res)) return;
    const b = (await readJson(req)) as { account?: unknown };
    const label = typeof b.account === 'string' ? b.account : (b.account as { add?: unknown } | undefined)?.add;
    if (typeof label !== 'string' || !/^[a-z0-9-]{1,20}$/.test(label)) return sendError(res, 400, 'invalid', 'Choose the account to connect.');
    if (label === 'org2') state.org2Ok = true; // the fake has no Google: the reconnect counts as done
    // Google's sign-in page; the smoke test answers it with a redirect back, as Google would after consent.
    sendJson(res, 200, { url: `https://accounts.google.com/o/oauth2/v2/auth?fake=1&account=${encodeURIComponent(label)}` });
  });
  const ACTIONS: Record<string, unknown> = {
    'upload-tracker': { ok: true, at: at(0) },
    'test-claude': { ok: true, ms: 812 },
    'test-heartbeat': { ok: true, status: 200 },
  };
  web.router.post('/dashboard/api/actions/:name', ({ req, res, params }) => {
    if (!owner(req, res)) return;
    const r = ACTIONS[params.name ?? ''];
    if (!r) return sendError(res, 404, 'not_found', 'There is no such action.');
    if (state.rateLimited) return sendJson(res, 429, { error: { code: 'rate_limited', message: 'Too many tries. Wait a minute and try again.', retryAfterSec: 60 } });
    setTimeout(() => sendJson(res, 200, r), 600);
  });
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
  web.router.post('/dashboard/api/groups/bulk', async ({ req, res }) => {
    if (!owner(req, res)) return;
    const b = (await readJson(req)) as { action?: unknown; keys?: unknown };
    const keys = Array.isArray(b.keys) ? b.keys.filter((k): k is string => typeof k === 'string') : [];
    if (!['approve', 'ignore', 'unignore'].includes(String(b.action)) || keys.length === 0 || keys.length > 50) {
      return sendError(res, 400, 'invalid', 'The changes are not valid.');
    }
    const results = g.bulk(String(b.action), keys);
    setTimeout(() => sendJson(res, 200, { ...g.overview(''), results }), 400);
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
