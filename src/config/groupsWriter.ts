import { closeSync, copyFileSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { getClientByCode, getClientByGroupId } from '../store/clients.ts';
import type { Db, Sql } from '../store/db.ts';
import { parseGroupsFile, type ClientConfig } from './groups.ts';

// Writes config/allowed-groups.json for the dashboard (D2), the safe way: the raw JSON is read so the fields of untouched
// clients (phases, keywords, domains) stay exactly as they are; the result is checked with parseGroupsFile and the
// clients-table code rules before anything is written; then a temporary file, a .bak of the previous version, and a
// rename. The running service's file watcher applies the new list within about 2 seconds, as after a hand edit.

export interface ApproveChange {
  groupId: string;
  name: string;
  code: string;
  emailDomains?: string[];
  meetingKeywords?: string[];
}

export interface EditChange {
  groupId: string;
  name?: string;
  emailDomains?: string[];
  meetingKeywords?: string[];
}

export interface GroupChanges {
  approve?: ApproveChange[];
  unapprove?: string[];
  edit?: EditChange[];
}

/** One changed group, for the audit lines. */
export interface ChangedGroup {
  groupId: string;
  name: string;
  code: string;
}

export interface GroupChangeResult {
  approved: ChangedGroup[];
  removed: ChangedGroup[];
  edited: ChangedGroup[];
  /** The new list, as the watcher will read it. */
  configs: ClientConfig[];
  /**
   * Set by a customer's store (src/config/groupsStore.ts) when the change was saved but the clients could not be
   * reloaded at once: the next runtime start syncs them from the saved list.
   */
  warning?: 'reload_failed';
}

export type GroupChangeField = 'code' | 'name' | 'groupId' | 'emailDomains' | 'meetingKeywords' | 'file';

/** A change the owner can fix: the message is safe to show, and names the group and field when known. */
export class GroupChangeError extends Error {
  readonly field: GroupChangeField;
  readonly groupId: string | null;
  /** `cause` keeps a file-system error for the server log only; its text (which holds paths) is never the message. */
  constructor(message: string, field: GroupChangeField, groupId: string | null = null, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GroupChangeError';
    this.field = field;
    this.groupId = groupId;
  }
}

/** The file operations used to write, so a test can make one fail. */
export interface FileOps {
  rename: (from: string, to: string) => void;
}

const CODE = /^[A-Z]{3,4}$/;
const NAME_MAX = 80;

type RawEntry = Record<string, unknown> & { groupId: string; name: string; code: string };

/** One write at a time per file, in call order. */
const queues = new Map<string, Promise<unknown>>();

export function applyGroupChanges(
  path: string,
  changes: GroupChanges,
  o: { db: Db; ops?: Partial<FileOps> },
): Promise<GroupChangeResult> {
  const previous = queues.get(path) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => apply(path, changes, o));
  const tail = run.catch(() => undefined);
  queues.set(path, tail);
  void tail.then(() => {
    if (queues.get(path) === tail) queues.delete(path);
  });
  return run;
}

async function apply(path: string, changes: GroupChanges, o: { db: Db; ops?: Partial<FileOps> }): Promise<GroupChangeResult> {
  let original: string;
  try {
    original = readFileSync(path, 'utf8');
  } catch (e) {
    throw new GroupChangeError('The groups file could not be read on the Mac. Nothing was changed.', 'file', null, { cause: e });
  }
  const { text, result, differs } = await applyToDocument(original, changes, o);
  if (differs) write(path, text, o.ops);
  return result;
}

/**
 * The changes applied to an allow-list document's text: the same rules for the founder's file and a customer's stored
 * list (src/config/groupsStore.ts). The raw JSON is changed so untouched fields stay as they are; the result is checked
 * with parseGroupsFile and the clients-table code rules (read through `db`, which may be a transaction's handle). Writes
 * nothing. `differs` is false when the new text is the same as the old (for example an edit back to the same name).
 */
export async function applyToDocument(
  original: string,
  changes: GroupChanges,
  o: { db: Sql },
): Promise<{ text: string; result: GroupChangeResult; differs: boolean }> {
  const doc = parseRaw(original);
  const entries = doc.clients;
  const result: GroupChangeResult = { approved: [], removed: [], edited: [], configs: [] };
  const index = (groupId: string) => entries.findIndex((e) => e.groupId === groupId);

  for (const groupId of changes.unapprove ?? []) {
    const i = index(groupId);
    if (i < 0) throw new GroupChangeError('This group is not approved.', 'groupId', groupId);
    const [gone] = entries.splice(i, 1);
    result.removed.push(changed(gone!));
  }

  // One "Client edited" line per group that really changed, with its final values, however many edits the save holds.
  const beforeEdit = new Map(entries.map((x) => [x.groupId, JSON.stringify(x)]));
  const editedIds: string[] = [];
  for (const e of changes.edit ?? []) {
    const entry = entries[index(e.groupId)];
    if (!entry) throw new GroupChangeError('This group is not approved.', 'groupId', e.groupId);
    if (e.name !== undefined) entry.name = checkName(e.name, e.groupId);
    if (e.emailDomains !== undefined) setList(entry, 'emailDomains', e.emailDomains, e.groupId);
    if (e.meetingKeywords !== undefined) setList(entry, 'meetingKeywords', e.meetingKeywords, e.groupId);
    if (!editedIds.includes(entry.groupId)) editedIds.push(entry.groupId);
  }
  for (const id of editedIds) {
    const entry = entries[index(id)]!;
    if (JSON.stringify(entry) !== beforeEdit.get(id)) result.edited.push(changed(entry));
  }

  for (const a of changes.approve ?? []) {
    if (index(a.groupId) >= 0) throw new GroupChangeError('This group is already approved.', 'groupId', a.groupId);
    const code = typeof a.code === 'string' ? a.code.trim() : '';
    if (!CODE.test(code)) throw new GroupChangeError('The code must be 3 or 4 capital letters, for example SHA.', 'code', a.groupId);
    const stored = await getClientByGroupId(o.db, a.groupId);
    if (stored && stored.code !== code) {
      throw new GroupChangeError(`Client codes are permanent because task IDs use them. Keep code ${stored.code} for ${stored.name}.`, 'code', a.groupId);
    }
    const inFile = entries.find((x) => x.code === code);
    if (inFile) throw new GroupChangeError(`Code ${code} is already used by ${inFile.name}. Pick a different code.`, 'code', a.groupId);
    const user = await getClientByCode(o.db, code);
    if (user && user.groupId !== a.groupId) {
      throw new GroupChangeError(`Code ${code} is already used by ${user.name}. Pick a different code.`, 'code', a.groupId);
    }
    const entry: RawEntry = { groupId: a.groupId, name: checkName(a.name, a.groupId), code };
    if (a.emailDomains !== undefined) setList(entry, 'emailDomains', a.emailDomains, a.groupId);
    if (a.meetingKeywords !== undefined) setList(entry, 'meetingKeywords', a.meetingKeywords, a.groupId);
    entries.push(entry);
    result.approved.push(changed(entry));
  }

  const text = `${JSON.stringify(doc, null, 2)}\n`;
  try {
    result.configs = parseGroupsFile(text);
  } catch (e) {
    const message = (e as Error).message;
    // The parser names the entry by its place in the list (clients.N); turn that back into the group it is.
    const n = /clients\.(\d+)\./.exec(message)?.[1];
    const groupId = n === undefined ? null : (entries[Number(n)]?.groupId ?? null);
    throw new GroupChangeError(friendly(message), fieldOf(message), groupId);
  }
  // Nothing to change (for example an edit back to the same name): the file and its .bak stay as they are.
  const differs = text.replace(/\r\n/g, '\n') !== original.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  return { text, result, differs };
}

function parseRaw(text: string): { clients: RawEntry[] } & Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new GroupChangeError('allowed-groups.json is not valid JSON. Fix it on the Mac, or restore allowed-groups.json.bak.', 'file');
  }
  const clients = (raw as { clients?: unknown } | null)?.clients;
  if (typeof raw !== 'object' || raw === null || !Array.isArray(clients)) {
    throw new GroupChangeError('allowed-groups.json has no "clients" list. Fix it on the Mac, or restore allowed-groups.json.bak.', 'file');
  }
  const whole = (c: unknown) =>
    typeof c === 'object' && c !== null && ['groupId', 'name', 'code'].every((k) => typeof (c as Record<string, unknown>)[k] === 'string');
  if (!clients.every(whole)) {
    throw new GroupChangeError('allowed-groups.json has an entry without a group id, name or code. Fix it on the Mac, or restore allowed-groups.json.bak.', 'file');
  }
  return raw as { clients: RawEntry[] };
}

function checkName(name: string, groupId: string): string {
  const n = typeof name === 'string' ? name.trim() : '';
  if (n.length < 1 || n.length > NAME_MAX) throw new GroupChangeError(`Enter a client name (1 to ${NAME_MAX} characters).`, 'name', groupId);
  return n;
}

/** An empty list leaves the field out, as a hand-written file would. */
function setList(entry: RawEntry, key: 'emailDomains' | 'meetingKeywords', values: string[], groupId: string): void {
  if (!Array.isArray(values) || !values.every((v) => typeof v === 'string')) {
    throw new GroupChangeError(key === 'emailDomains' ? 'Email domains must be a list of domains.' : 'Meeting keywords must be a list of words.', key, groupId);
  }
  const list = values.map((v) => v.trim()).filter((v) => v !== '');
  if (list.length === 0) delete entry[key];
  else entry[key] = list;
}

const changed = (e: RawEntry): ChangedGroup => ({ groupId: e.groupId, name: e.name, code: e.code });

/**
 * The parser's message without its file prefix and JSON paths, which mean nothing in the dashboard. The example-group
 * message is replaced: its terminal advice ("set the file to { "clients": [] }") would empty the list.
 */
function friendly(message: string): string {
  if (/example group/.test(message)) return 'This is the example group id, not a real WhatsApp group.';
  return message
    .replace(/^allowed-groups\.json( is invalid)?:?\s*/, '')
    .replace(/clients\.\d+\./g, '')
    .replace(/\bemailDomains\.\d+/g, 'Email domain')
    .replace(/\bemailDomains\b/g, 'Email domains')
    .replace(/\bmeetingKeywords\.\d+/g, 'Meeting keyword')
    .replace(/\bmeetingKeywords\b/g, 'Meeting keywords');
}

function fieldOf(message: string): GroupChangeField {
  if (/meeting keyword|meetingKeywords/.test(message)) return 'meetingKeywords';
  if (/emailDomains/.test(message)) return 'emailDomains';
  if (/\bname\b/.test(message)) return 'name';
  if (/\bcode\b/.test(message)) return 'code';
  if (/group/.test(message)) return 'groupId';
  return 'file';
}

/**
 * Temporary file (flushed to disk), then the previous version to .bak (through its own temporary file, so a crash never
 * leaves a half-written .bak), then the rename. A failure removes the temporary files and leaves the original as it was.
 */
function write(path: string, text: string, ops: Partial<FileOps> | undefined): void {
  const tmp = `${path}.tmp`;
  const bakTmp = `${path}.bak.tmp`;
  const rename = ops?.rename ?? renameSync;
  try {
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Under the write queue nothing else changes the file between the read and here, so the .bak is the version this change started from.
    copyFileSync(path, bakTmp);
    rename(bakTmp, `${path}.bak`);
    rename(tmp, path);
  } catch (e) {
    for (const f of [tmp, bakTmp]) {
      try {
        rmSync(f, { force: true });
      } catch {
        // the original error matters more
      }
    }
    throw new GroupChangeError('Could not save the groups file on the Mac. Nothing was changed.', 'file', null, { cause: e });
  }
}
