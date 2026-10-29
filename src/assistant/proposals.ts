import { randomBytes } from 'node:crypto';
import type { SettingsStore } from '../config/settingsStore.ts';
import { SETTING_KEYS } from '../config/settingsStore.ts';
import { ControlError, type Audit } from '../control/errors.ts';
import { createTaskAction, parseNewTask, parseTaskEdit, runTaskAction } from '../control/taskActions.ts';
import { taskDetail } from '../control/taskQueries.ts';
import { txSync, type Db } from '../store/db.ts';
import type { Clock } from '../util/clock.ts';
import type { SessionEnd } from '../web/sessions.ts';
import { INPUTS } from './tools.ts';

// What the assistant may change, and only on the owner's Confirm (the owner's choice: "Answer, and act only with a
// confirm"). A propose_ tool drafts the change and checks it now; the draft is kept here, in memory, under a random id
// for PENDING_TTL_MS, tied to the browser session that asked. Confirm takes it out (once: a second Confirm, an expired
// id or another session's id is refused) and runs it through the screens' own code: runTaskAction and createTaskAction
// (src/control/taskActions.ts) and SettingsStore.set, with their checks and audit lines, marked "via assistant".
// Nothing a WhatsApp message says can confirm a card: only the owner's POST with the session's CSRF token does.

/** How long a card can be confirmed. */
export const PENDING_TTL_MS = 10 * 60_000;
/** Cards waiting per session, at most (the oldest goes first). */
const PENDING_MAX = 20;

/**
 * The settings the assistant may draft: the dashboard's own, except the founder's number (typed twice on its screen) and
 * Open chat's sending (dashboardSend): putting messages on the founder's WhatsApp is only ever the owner's own click.
 */
export const OWNER_ONLY_SETTINGS: readonly string[] = ['reportRecipient', 'dashboardSend'];
export const ASSISTANT_SETTINGS = SETTING_KEYS.filter((k) => !OWNER_ONLY_SETTINGS.includes(k)) as readonly string[];

export type ProposalAction =
  | { kind: 'task_change'; code: string; status?: 'done' | 'open'; edit?: Record<string, string> }
  | { kind: 'task_create'; input: { client: string; title: string; assignedTo?: string; deadline?: string; priority?: string; category?: string } }
  | { kind: 'setting'; key: string; value: string | boolean };

/** What the browser shows on the card: plain words only, escaped there. */
export interface ProposalCard {
  id: string;
  title: string;
  lines: string[];
  expiresAt: string;
}

interface Pending {
  action: ProposalAction;
  card: ProposalCard;
  /** The session's hash, and its owner's email (sign out everywhere ends all of an email's cards). */
  owner: string;
  email: string;
  expires: number;
}

const show = (v: string | null | undefined) => (v === null || v === undefined || v === '' ? 'none' : v);

/**
 * Checks a propose_ tool's input against the database as the confirm will, and words the card. Throws ControlError
 * (404 no such task or client, 409 nothing would change, 422 a bad value) or a zod error for a malformed input.
 */
export function draftProposal(tool: 'propose_task_change' | 'propose_new_task' | 'propose_setting', raw: unknown, d: { db: Db; clock: Clock; settings: Pick<SettingsStore, 'view'> }): { action: ProposalAction; title: string; lines: string[] } {
  if (tool === 'propose_task_change') {
    const i = INPUTS.propose_task_change.parse(raw);
    const t = taskDetail(d.db, i.code, d.clock.now());
    if (!t) throw new ControlError(404, `No task called ${i.code}`);
    const edit: Record<string, string> = {};
    if (i.assignedTo !== undefined) edit.assignedTo = i.assignedTo;
    if (i.deadline !== undefined) edit.deadline = i.deadline;
    if (i.priority !== undefined) edit.priority = i.priority;
    const hasEdit = Object.keys(edit).length > 0;
    if (hasEdit) parseTaskEdit(edit); // the Tasks screen's own checks
    const lines: string[] = [];
    if (i.status === 'done' && t.status !== 'done') lines.push('Status: mark done');
    if (i.status === 'open' && t.status === 'done') lines.push('Status: reopen');
    if (edit.assignedTo !== undefined && edit.assignedTo !== (t.owner ?? '')) lines.push(`Assigned to: ${show(t.owner)} → ${show(edit.assignedTo)}`);
    if (edit.deadline !== undefined && edit.deadline !== (t.deadline ?? '')) lines.push(`Deadline: ${show(t.deadline)} → ${show(edit.deadline)}`);
    if (edit.priority !== undefined && edit.priority !== t.priority) lines.push(`Priority: ${show(t.priority)} → ${edit.priority}`);
    if (lines.length === 0) throw new ControlError(409, `Task ${t.code} already has those values`);
    const status = i.status === 'done' && t.status !== 'done' ? 'done' : i.status === 'open' && t.status === 'done' ? 'open' : undefined;
    return {
      action: { kind: 'task_change', code: t.code, ...(status ? { status } : {}), ...(hasEdit ? { edit } : {}) },
      title: `Change ${t.code} · ${t.title}`,
      lines,
    };
  }
  if (tool === 'propose_new_task') {
    const i = INPUTS.propose_new_task.parse(raw);
    const { clientCode, fields } = parseNewTask(d.db, i);
    return {
      action: { kind: 'task_create', input: i },
      title: `Add a task for ${clientCode}`,
      lines: [
        `Title: ${fields.title}`, `Assigned to: ${show(fields.assignedTo)}`, `Deadline: ${show(fields.deadline)}`,
        `Priority: ${fields.priority}`, `Category: ${fields.category}`,
      ],
    };
  }
  const i = INPUTS.propose_setting.parse(raw);
  if (!ASSISTANT_SETTINGS.includes(i.key)) throw new ControlError(422, `The assistant can change only: ${ASSISTANT_SETTINGS.join(', ')}`, 'key');
  // The obvious checks now, so a card is never shown for a value the settings would refuse; SettingsStore.set checks
  // everything again on Confirm (switching on also needs the number and the linked spare phone).
  const valid = i.key === 'reportEnabled' ? typeof i.value === 'boolean'
    : i.key === 'reportDays' ? ['weekdays', 'mon-sat', 'daily'].includes(String(i.value))
    : i.key === 'reportTime' ? typeof i.value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(i.value) : true;
  if (!valid) throw new ControlError(422, `That is not a value ${i.key} can take`, 'value');
  const words: Record<string, string> = { reportEnabled: 'Morning briefing', reportDays: 'Briefing days', reportTime: 'Briefing time' };
  const now = (d.settings.view() as unknown as Record<string, unknown>)[i.key === 'reportTime' ? 'sendAt' : i.key];
  const word = (v: unknown) => (v === true ? 'on' : v === false ? 'off' : String(v ?? 'not set'));
  if (now === i.value) throw new ControlError(409, `${words[i.key] ?? i.key} is already ${word(i.value)}`);
  return {
    action: { kind: 'setting', key: i.key, value: i.value },
    title: i.key === 'reportEnabled' && i.value === true ? 'Start sending the morning briefing to the founder' : `Change ${words[i.key] ?? i.key}`,
    lines: [`${words[i.key] ?? i.key}: ${word(now)} → ${word(i.value)}`],
  };
}

/** Drafted changes waiting for the owner's Confirm. Memory only: a restart drops them. */
export class PendingActions {
  readonly #byId = new Map<string, Pending>();
  readonly #clock: Clock;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  /** Keeps a draft for this session and returns its card. */
  add(owner: { key: string; email: string }, draft: { action: ProposalAction; title: string; lines: string[] }): ProposalCard {
    this.#sweep();
    const mine = [...this.#byId].filter(([, p]) => p.owner === owner.key);
    if (mine.length >= PENDING_MAX) this.#byId.delete(mine[0]![0]);
    const id = randomBytes(18).toString('base64url');
    const expires = this.#clock.now().getTime() + PENDING_TTL_MS;
    const card: ProposalCard = { id, title: draft.title, lines: draft.lines, expiresAt: new Date(expires).toISOString() };
    this.#byId.set(id, { action: draft.action, card, owner: owner.key, email: owner.email, expires });
    return card;
  }

  /**
   * Takes a card out for its Confirm, so it can never run twice. Throws ControlError: 404 an unknown id (never made,
   * already used or cancelled, or another session's), 409 expired.
   */
  take(id: unknown, ownerKey: string): Pending {
    const p = typeof id === 'string' && /^[A-Za-z0-9_-]{20,40}$/.test(id) ? this.#byId.get(id) : undefined;
    if (!p || p.owner !== ownerKey) throw new ControlError(404, 'That change is not waiting any more. Ask the assistant again.', 'id');
    this.#byId.delete(id as string);
    if (this.#clock.now().getTime() >= p.expires) throw new ControlError(409, 'That change expired. Ask the assistant again.', 'id');
    return p;
  }

  /** Cancel: the card is gone, whatever its state. */
  drop(id: unknown, ownerKey: string): void {
    if (typeof id !== 'string') return;
    if (this.#byId.get(id)?.owner === ownerKey) this.#byId.delete(id);
  }

  /** A new chat, or a session that ended: its cards go. */
  forget(end: SessionEnd): void {
    for (const [id, p] of this.#byId) if ('idHash' in end ? p.owner === end.idHash : p.email === end.email) this.#byId.delete(id);
  }

  size(): number {
    return this.#byId.size;
  }

  #sweep(): void {
    const now = this.#clock.now().getTime();
    for (const [id, p] of this.#byId) if (now >= p.expires) this.#byId.delete(id);
  }
}

export interface RunDeps {
  db: Db;
  clock: Clock;
  settings: Pick<SettingsStore, 'set'>;
  actor: string;
  /** The route's audit, already bound to the request; every line gets "via assistant". */
  audit: Audit;
}

/** Runs a confirmed card through the screens' own code. Returns what changed in words. Throws ControlError as they do. */
export function runProposal(action: ProposalAction, d: RunDeps): { message: string; task?: string } {
  const audit: Audit = (e) => d.audit({ ...e, detail: `${e.detail} · via assistant` });
  const ctx = { actor: d.actor, now: d.clock.now(), audit };
  switch (action.kind) {
    case 'task_change': {
      // The edit and the status change are one transaction: both happen or neither.
      txSync(d.db, () => {
        if (action.edit) runTaskAction(d.db, { code: action.code, action: 'edit', body: action.edit }, ctx);
        if (action.status) runTaskAction(d.db, { code: action.code, action: action.status === 'done' ? 'done' : 'reopen' }, ctx);
      });
      return { message: `${action.code} updated.`, task: action.code };
    }
    case 'task_create': {
      const t = createTaskAction(d.db, action.input, ctx);
      return { message: `${t.code} added.`, task: t.code };
    }
    case 'setting':
      // Checked again here, not only when the card was drafted: an owner-only setting is never changed through a card.
      if (!ASSISTANT_SETTINGS.includes(action.key)) throw new ControlError(422, 'Only you can change this setting, on its own screen.', 'key');
      d.settings.set(action.key, action.value, d.actor, audit);
      return { message: 'Setting saved.' };
  }
}
