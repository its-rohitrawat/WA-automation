// Reads the agent's API answers (D1 tasks 5 and 6: AgentStatus, Overview and Connections in src/control/agentControl.ts
// and src/control/queries.ts) into what the screens draw. Coerced defensively: a missing or unexpected field becomes an
// empty value, so the page shows a dash instead of breaking. Everything stays plain text.
import { ago, usd, when } from './format.js';

/** @typedef {'ok'|'warn'|'down'|'off'} PartState */
const STATES = new Set(['ok', 'warn', 'down', 'off']);

/** Text from a string, number or boolean; anything else (objects, arrays, null) is empty, so nothing odd is ever turned into text. */
const str = (/** @type {unknown} */ v) => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');
const num = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const iso = (/** @type {unknown} */ v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null);
/** @param {unknown} v @returns {unknown[]} */
const arr = (v) => (Array.isArray(v) ? v : []);
/** @param {unknown} v @returns {Record<string, unknown>} */
const obj = (v) => (v && typeof v === 'object' ? /** @type {Record<string, unknown>} */ (v) : {});
/** The only tracker link the screens open: the Drive file address the agent builds. */
export const DRIVE_FILE_URL = /^https:\/\/drive\.google\.com\/file\/d\/[A-Za-z0-9_-]{10,}\/view$/;
/** What the screens say while the main Google account's email is not known. */
export const ACCOUNT_UNKNOWN = 'Main Google account (email not known yet)';

/** @param {unknown} v @returns {PartState} */
const state = (v) => (STATES.has(str(v)) ? /** @type {PartState} */ (str(v)) : 'off');

/**
 * GET /dashboard/api/status (AgentStatus: { at, up, line, parts: { key, name, state, label }[], lastMessageAt, spentToday,
 * capUsd }). A part's `name` is its title ("Claude spend") and its `label` the state in words ("Reconnecting").
 * @param {unknown} raw
 */
export function readStatus(raw) {
  const r = obj(raw);
  const line = obj(r.line);
  return {
    line: { ok: line.ok === true, text: str(line.text) },
    isUp: r.up === true,
    checkedAt: iso(r.at),
    parts: arr(r.parts).map((p) => {
      const o = obj(p);
      return { key: str(o.key), label: str(o.name), state: state(o.state), detail: str(o.label) };
    }),
    lastMessageAt: iso(r.lastMessageAt),
    spentToday: num(r.spentToday),
    capUsd: num(r.capUsd),
  };
}

/**
 * GET /dashboard/api/overview. The agent counts each task once (open excludes overdue and review); the Open tasks
 * count shown is open plus overdue, as in the agreed design.
 * @param {unknown} raw
 */
export function readOverview(raw) {
  const r = obj(raw);
  const t = obj(r.tasks);
  const tracker = obj(r.tracker);
  const health = r.tracker && tracker.health ? obj(tracker.health) : null;
  const lastPublishedAt = iso(tracker.lastPublishedAt);
  return {
    clients: num(r.clients),
    totals: { open: num(t.open) + num(t.overdue), overdue: num(t.overdue), review: num(t.review), doneThisWeek: num(t.doneThisWeek) },
    segments: arr(r.byClient).map((row) => {
      const o = obj(row);
      const client = obj(o.client);
      const count = (/** @type {string} */ key) => num(obj(arr(o.segments).find((s) => obj(s).key === key)).count);
      return { code: str(client.code), name: str(client.name), overdue: count('overdue'), open: count('open'), review: count('review'), doneThisWeek: count('done') };
    }),
    meetings: arr(r.meetings).map((m) => {
      const o = obj(m);
      return { title: str(o.title) || 'Internal meeting', status: str(o.status), statusLabel: str(o.stageLabel), at: iso(o.when), minutes: typeof o.minutes === 'number' ? o.minutes : null };
    }),
    activity: arr(r.activity).map((a) => {
      const o = obj(a);
      return { kind: str(o.kind), title: str(o.title), detail: str(o.detail), who: str(o.who), at: iso(o.at) };
    }),
    tracker: { lastPublishedAt, ok: health ? health.ok === true : lastPublishedAt !== null, label: health ? str(health.text) : '' },
  };
}

/**
 * One card on the Connections screen.
 * @typedef {{ id: string, kind: string, title: string, subtitle: string, state: PartState, stateLabel: string, rows: [string, string][], note: string,
 *   email?: string, meetings?: boolean, link?: string }} Card
 */

/**
 * GET /dashboard/api/connections (fixed keys: founder, spare, google[], drive, claude, monitoring) as cards, in that
 * order.
 * @param {unknown} raw @returns {Card[]}
 */
export function readConnections(raw) {
  const r = obj(raw);
  /** @type {Card[]} */
  const cards = [];
  const f = obj(r.founder);
  cards.push({
    id: 'founder', kind: 'founder', title: 'Founder WhatsApp', subtitle: `Linked device "${str(f.device) || 'WA Agent - Tracker'}"`,
    state: state(f.state), stateLabel: str(f.label),
    rows: [['Mode', 'Read-only'], ['Groups', `${num(f.groups)} approved`], ['Last activity', ago(iso(f.lastActivityAt))]], note: '',
  });
  const s = obj(r.spare);
  const spareState = state(s.state);
  cards.push({
    id: 'spare', kind: 'spare', title: 'Spare WhatsApp', subtitle: `Linked device "${str(s.device) || 'WA Agent - Morning report'}"`,
    state: spareState, stateLabel: str(s.label),
    rows: [['Sends', 'Morning briefing only'], ['Sends to', str(s.recipientMasked) || '—']],
    note: spareState === 'ok' ? '' : "Link it with the spare phone, not the founder's. The agent refuses a link from the founder's own number.",
  });
  for (const g of arr(r.google)) {
    const o = obj(g);
    const label = str(o.label);
    const usedFor = arr(o.usedFor).map(str).filter(Boolean);
    cards.push({
      id: `google:${label}`, kind: 'google', title: label === 'main' ? 'Google account · main' : `Google account · ${label}`,
      subtitle: str(o.email) || (label === 'main' ? 'The mailbox account' : 'Meeting recordings'),
      state: state(o.state), stateLabel: str(o.stateLabel), rows: [['Used for', usedFor.join(', ') || '—']], note: '',
      email: str(o.email), meetings: usedFor.some((u) => /meeting/i.test(u)),
    });
  }
  const d = obj(r.drive);
  const folder = str(d.folder) || 'WA Agent';
  const driveUrl = str(d.url);
  cards.push({
    id: 'drive', kind: 'drive', title: 'Google Drive', subtitle: `${folder} folder`, state: state(d.state), stateLabel: str(d.label),
    rows: [['File', str(d.file) || 'Tracker.xlsx'], ['Folder', folder], ['Account', str(d.account) || ACCOUNT_UNKNOWN],
      ['Last upload', iso(d.lastUploadAt) ? when(iso(d.lastUploadAt)) : 'Not uploaded yet']],
    note: '', link: DRIVE_FILE_URL.test(driveUrl) ? driveUrl : '',
  });
  const c = obj(r.claude);
  const capUsd = num(c.capUsd);
  const atCap = capUsd > 0 && num(c.spentToday) >= capUsd;
  cards.push({
    id: 'claude', kind: 'claude', title: 'Claude AI', subtitle: 'Reads messages and meetings', state: atCap ? 'warn' : 'ok',
    stateLabel: atCap ? 'Daily cap reached' : 'Connected',
    rows: [['Today', `${num(c.callsToday)} calls · ${usd(num(c.spentToday))}`], ['Daily cap', capUsd ? usd(capUsd) : 'Not set']],
    note: 'The API key stays on the Mac. It is never sent to this page.',
  });
  const m = obj(r.monitoring);
  const on = m.on === true;
  cards.push({
    id: 'monitoring', kind: 'monitoring', title: 'Monitoring', subtitle: 'Uptime heartbeat', state: on ? 'ok' : 'off', stateLabel: on ? 'On' : 'Off',
    rows: [['Last beat', on ? ago(iso(m.lastBeatAt)) : 'Heartbeat is off']], note: '',
  });
  return cards;
}

/** The parts that need the owner: down first, then warn. @param {ReturnType<typeof readStatus>} s */
export function problems(s) {
  return [...s.parts.filter((p) => p.state === 'down'), ...s.parts.filter((p) => p.state === 'warn')];
}

/** @param {unknown} v */
const counts = (v) => {
  const o = obj(v);
  return { open: num(o.open), overdue: num(o.overdue), review: num(o.review), doneThisWeek: num(o.doneThisWeek) };
};

/** @param {unknown} v */
function clientCard(v) {
  const o = obj(v);
  const phases = arr(o.phases).map(str).filter(Boolean);
  const currentPhase = str(o.currentPhase) || null;
  return {
    code: str(o.code), name: str(o.name), groupName: str(o.groupName) || str(o.name), counts: counts(o.counts), phases,
    currentPhase, phaseIndex: currentPhase ? phases.indexOf(currentPhase) : -1, lastActivity: iso(o.lastActivity), sheetName: str(o.sheetName),
  };
}

/** GET /dashboard/api/clients ({ clients: ClientCard[] }). @param {unknown} raw */
export function readClients(raw) {
  return arr(obj(raw).clients).map(clientCard).filter((c) => c.code);
}

/** GET /dashboard/api/clients/:code ({ client: ClientDetail }). @param {unknown} raw */
export function readClientDetail(raw) {
  const o = obj(obj(raw).client);
  return {
    ...clientCard(o),
    openTasks: arr(o.openTasks).map((t) => {
      const x = obj(t);
      return { code: str(x.code), title: str(x.title), assignedTo: str(x.assignedTo) || null, deadline: str(x.deadline) || null, status: str(x.status) };
    }),
    meetings: arr(o.meetings).map((m) => {
      const x = obj(m);
      return { id: num(x.id), startedAt: iso(x.startedAt), title: str(x.title) || 'Untitled meeting', status: str(x.status) };
    }),
    lastSyncAt: iso(o.lastSyncAt),
  };
}

/** @param {unknown} v */
const strings = (v) => arr(v).map(str).filter(Boolean);

/**
 * One row of Manage groups. `key` is the agent's opaque key for the group (never its WhatsApp id).
 * @typedef {{ key: string, name: string, approved: boolean, inWhatsApp: boolean,
 *   client: { name: string, code: string, active: boolean, hasTasks: boolean, codeLocked: boolean, emailDomains: string[], meetingKeywords: string[] } | null }} GroupRow
 */

/** GET /dashboard/api/groups (and the answer to /groups/apply). @param {unknown} raw */
export function readGroups(raw) {
  const r = obj(raw);
  const c = obj(r.counts);
  const reason = str(r.reason);
  return {
    /** @type {GroupRow[]} */
    rows: arr(r.rows)
      .map((row) => {
        const o = obj(row);
        const cl = o.client && typeof o.client === 'object' ? obj(o.client) : null;
        return {
          key: /^[0-9a-f]{24}$/.test(str(o.key)) ? str(o.key) : '',
          name: str(o.name),
          approved: o.approved === true,
          inWhatsApp: o.inWhatsApp !== false,
          client: cl
            ? { name: str(cl.name), code: str(cl.code), active: cl.active === true, hasTasks: cl.hasTasks === true, codeLocked: cl.codeLocked === true, emailDomains: strings(cl.emailDomains), meetingKeywords: strings(cl.meetingKeywords) }
            : null,
        };
      })
      .filter((row) => row.key),
    total: num(r.total),
    counts: { all: num(c.all), approved: num(c.approved), notApproved: num(c.notApproved) },
    stale: r.stale === true,
    reason: reason === 'whatsapp_not_connected' || reason === 'list_failed' ? reason : null,
    fetchedAt: iso(r.fetchedAt),
  };
}
