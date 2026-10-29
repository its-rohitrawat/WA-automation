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
    const email = str(o.email);
    // The address is the card's title: which Google account it is. The agent's own name for it sits below, small.
    cards.push({
      id: `google:${label}`, kind: 'google', title: email || 'Google account', subtitle: `Account name: ${label}`,
      state: state(o.state), stateLabel: str(o.stateLabel), rows: [['Used for', usedFor.join(', ') || '—']],
      note: email ? '' : 'Email not known yet: press Reconnect to show it.',
      email, meetings: usedFor.some((u) => /meeting/i.test(u)),
    });
  }
  const d = obj(r.drive);
  const folder = str(d.folder) || 'WA Agent';
  const driveUrl = str(d.url);
  cards.push({
    id: 'drive', kind: 'drive', title: 'Google Drive', subtitle: `${folder} folder`, state: state(d.state), stateLabel: str(d.label),
    rows: [['Writes as', str(d.account) || ACCOUNT_UNKNOWN], ['File', str(d.file) || 'Tracker.xlsx'], ['Folder', folder],
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
    history: history(o.history),
    pulse: pulse(o.pulse),
  };
}

/** A card's status inputs: unread messages, when the group was last read, the quiet minutes. @param {unknown} v */
function pulse(v) {
  const o = obj(v);
  return { pending: num(o.pending), lastReadAt: iso(o.lastReadAt), quietMinutes: num(o.quietMinutes) || 4 };
}

const HISTORY_STATES = ['waiting', 'reading', 'done'];
/** Reading a newly approved group's earlier messages: { state, found }, or null. @param {unknown} v */
function history(v) {
  const o = obj(v);
  const state = str(o.state);
  return HISTORY_STATES.includes(state) ? { state, found: num(o.found) } : null;
}

/** GET /dashboard/api/clients ({ clients: ClientCard[] }). @param {unknown} raw */
export function readClients(raw) {
  return arr(obj(raw).clients).map(clientCard).filter((c) => c.code);
}

const PRIORITY_LEVELS = ['critical', 'major', 'medium', 'low'];
const MOODS = ['positive', 'neutral', 'negative', 'frustrated'];
/** One of the known words, else null (shown as "—", or not at all). @param {unknown} v @param {string[]} allowed */
const known = (v, allowed) => (typeof v === 'string' && allowed.includes(v) ? v : null);

/** GET /dashboard/api/clients/:code ({ client: ClientDetail }). @param {unknown} raw */
export function readClientDetail(raw) {
  const o = obj(obj(raw).client);
  const mood = obj(o.sentiment);
  return {
    ...clientCard(o),
    // The client's latest mood: null while sentiment is off, or before a batch judged it.
    sentiment: known(mood.mood, MOODS) ? { mood: /** @type {string} */ (known(mood.mood, MOODS)), at: iso(mood.at) } : null,
    openTasks: arr(o.openTasks).map((t) => {
      const x = obj(t);
      return {
        code: str(x.code), title: str(x.title), assignedTo: str(x.assignedTo) || null, deadline: str(x.deadline) || null, status: str(x.status),
        priority: known(x.priority, PRIORITY_LEVELS), sentiment: known(x.sentiment, MOODS),
      };
    }),
    meetings: arr(o.meetings).map((m) => {
      const x = obj(m);
      return { id: num(x.id), startedAt: iso(x.startedAt), title: str(x.title) || 'Untitled meeting', status: str(x.status) };
    }),
    lastSyncAt: iso(o.lastSyncAt),
    activity: activity(o.activity),
  };
}

const MESSAGE_KINDS = ['text', 'image', 'video', 'document', 'sticker', 'voice', 'audio', 'location', 'contact', 'poll', 'event', 'other'];
/** At most n characters, whole code points (the agent already cut the text to one short line). @param {string} s @param {number} n */
const cut = (s, n) => Array.from(s).slice(0, n).join('');
const BACKFILL_STATES = ['waiting', 'fetching', 'done', 'stopped'];

/**
 * What the agent has seen of the client's group (the drawer's status line, last-7-days numbers and latest messages).
 * Message text and sender names are the group's own words: shown through esc() or textContent only.
 * @param {unknown} v
 */
function activity(v) {
  const o = obj(v);
  const w = obj(o.week);
  const b = o.lastBatch && typeof o.lastBatch === 'object' ? obj(o.lastBatch) : null;
  const h = o.history && typeof o.history === 'object' ? obj(o.history) : null;
  return {
    pending: num(o.pending),
    quietMinutes: num(o.quietMinutes) || 4,
    lastBatch: b && iso(b.at) ? { at: /** @type {string} */ (iso(b.at)), messages: num(b.messages), taskChanges: num(b.taskChanges) } : null,
    taskCount: num(o.taskCount),
    week: { messages: num(w.messages), people: num(w.people), files: num(w.files), voice: num(w.voice) },
    latest: arr(o.latest).slice(0, 3).map((m) => {
      const x = obj(m);
      const kind = MESSAGE_KINDS.includes(str(x.kind)) ? str(x.kind) : 'text';
      return {
        sender: cut(str(x.sender), 80) || 'Someone', kind, text: cut(str(x.text), 400),
        seconds: typeof x.seconds === 'number' && Number.isFinite(x.seconds) ? x.seconds : null, transcribed: x.transcribed === true, at: iso(x.at),
      };
    }),
    approvedAt: iso(o.approvedAt),
    history: h && BACKFILL_STATES.includes(str(h.state)) ? { state: str(h.state), found: num(h.found) } : null,
  };
}

/** @param {unknown} v */
const strings = (v) => arr(v).map(str).filter(Boolean);

/**
 * One row of Manage groups. `key` is the agent's opaque key for the group (never its WhatsApp id).
 * @typedef {{ key: string, name: string, approved: boolean, inWhatsApp: boolean, ignored: boolean,
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
          ignored: o.ignored === true && o.approved !== true,
          client: cl
            ? { name: str(cl.name), code: str(cl.code), active: cl.active === true, hasTasks: cl.hasTasks === true, codeLocked: cl.codeLocked === true, emailDomains: strings(cl.emailDomains), meetingKeywords: strings(cl.meetingKeywords) }
            : null,
        };
      })
      .filter((row) => row.key),
    total: num(r.total),
    counts: { all: num(c.all), approved: num(c.approved), notApproved: num(c.notApproved), ignored: num(c.ignored) },
    stale: r.stale === true,
    reason: reason === 'whatsapp_not_connected' || reason === 'list_failed' ? reason : null,
    fetchedAt: iso(r.fetchedAt),
  };
}

/**
 * The answer to POST /groups/bulk: the new list and one result per group (the reason is the agent's plain sentence).
 * @param {unknown} raw
 */
export function readBulk(raw) {
  return {
    list: readGroups(raw),
    results: arr(obj(raw).results)
      .map((x) => {
        const o = obj(x);
        return { key: str(o.key), ok: o.ok === true, reason: str(o.reason).slice(0, 300) };
      })
      .filter((r) => /^[0-9a-f]{24}$/.test(r.key)),
  };
}

const OUTBOX_STATES = ['claimed', 'sending', 'sent', 'failed', 'unknown'];

/** A quote in a chat bubble, or null. @param {unknown} v */
function quoteOf(v) {
  if (!v || typeof v !== 'object') return null;
  const q = obj(v);
  return { sender: cut(str(q.sender), 80) || 'Someone', text: cut(str(q.text), 200), kind: MESSAGE_KINDS.includes(str(q.kind)) ? str(q.kind) : 'text' };
}

/** One message of the dashboard's own (sent, sending, failed or unknown). @param {unknown} v */
function outboxOf(v) {
  const o = obj(v);
  const state = OUTBOX_STATES.includes(str(o.state)) ? str(o.state) : 'unknown';
  return { uuid: str(o.uuid), at: iso(o.at), text: cut(str(o.text), 4096), state, quote: quoteOf(o.quote) };
}

/**
 * GET /clients/:code/chat: the client, whether sending is on and WhatsApp connected, a page of messages (newest first)
 * and the dashboard's own messages still to show. Every text is untrusted: shown with esc() or textContent only.
 * @param {unknown} raw
 */
export function readChat(raw) {
  const r = obj(raw);
  const c = obj(r.client);
  return {
    client: { code: str(c.code), name: str(c.name), groupName: cut(str(c.groupName), 120) || str(c.name) },
    sendingOn: r.sendingOn === true,
    connected: r.connected === true,
    hasOlder: r.hasOlder === true,
    messages: arr(r.messages)
      .map((m) => {
        const x = obj(m);
        return {
          id: num(x.id), at: iso(x.at), mine: x.mine === true, sender: cut(str(x.sender), 80) || 'Someone', text: cut(str(x.text), 4096),
          kind: MESSAGE_KINDS.includes(str(x.kind)) ? str(x.kind) : 'text',
          seconds: typeof x.seconds === 'number' && Number.isFinite(x.seconds) ? x.seconds : null,
          transcript: typeof x.transcript === 'string' && x.transcript ? cut(x.transcript, 2000) : null,
          quote: quoteOf(x.quote), edited: x.edited === true, deleted: x.deleted === true,
        };
      })
      .filter((m) => m.id > 0 && m.at !== null),
    outbox: arr(r.outbox).map(outboxOf).filter((o) => o.uuid && o.at !== null),
  };
}

/** The answer to POST /clients/:code/chat/send. @param {unknown} raw */
export function readSendResult(raw) {
  const r = obj(raw);
  return { message: outboxOf(r.message), replayed: r.replayed === true };
}
