import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { DomainSchema } from '../../config/domains.ts';
import { parseGroupsFile, type ClientConfig } from '../../config/groups.ts';
import { applyGroupChanges, GroupChangeError, type GroupChangeResult, type GroupChanges } from '../../config/groupsWriter.ts';
import { groupsOverview, type GroupDirectory, type GroupFilter, type GroupRow, type GroupsOverview } from '../../control/groups.ts';
import { listClients } from '../../store/clients.ts';
import type { Db } from '../../store/db.ts';
import type { Clock } from '../../util/clock.ts';
import type { Logger } from '../../util/logger.ts';
import { isMatchablePhrase, MIN_PHRASE_CHARS } from '../../util/text.ts';
import { fail, ok, type ApiError, type ApiResult, type AuditFn, type OwnerContext } from './context.ts';

// The Manage groups API (D2), as plain handlers: D1's owner guard (and, for the apply, its Origin and CSRF checks) runs
// before these, and the router mounts them in stage 2. Group names are untrusted text: they go out as JSON strings only.
// No raw group id leaves here: an old-style id is "<creator phone>-<time>@g.us", so the browser gets an opaque key
// (an HMAC of the id) and the apply maps keys back on the server.

export interface GroupsDeps {
  db: Db;
  directory: GroupDirectory;
  /** config/allowed-groups.json */
  groupsFile: string;
  /** The current parsed allow-list. */
  configs: () => ClientConfig[];
  /** The opaque key the browser gets for a group id (makeGroupKey with a server secret). */
  groupKey: (groupId: string) => string;
  audit: AuditFn;
  log: Logger;
  clock: Clock;
}

/** The URL search parameters as given. */
export interface GroupsQuery {
  q?: string | null;
  filter?: string | null;
  refresh?: string | null;
}

/** A group row as the browser sees it: the key in place of the group id. */
export type KeyedGroupRow = Omit<GroupRow, 'groupId'> & { key: string };
export type GroupsView = Omit<GroupsOverview, 'rows'> & { rows: KeyedGroupRow[] };

export const MAX_CHANGES = 300;
const NAME_MAX = 80;
const Q_MAX = 200;
/** A refresh asked for sooner than this after the last list is ignored, so the button cannot hammer WhatsApp. */
export const REFRESH_MIN_MS = 30_000;
const FILTERS: readonly GroupFilter[] = ['all', 'approved', 'not_approved'];
const KEY = /^[0-9a-f]{24}$/;

/** The first 24 hex characters of HMAC-SHA256 over the group id. */
export function makeGroupKey(secret: Uint8Array): (groupId: string) => string {
  return (groupId) => createHmac('sha256', secret).update(groupId).digest('hex').slice(0, 24);
}

function keyed(deps: GroupsDeps, o: GroupsOverview): GroupsView {
  return { ...o, rows: o.rows.map(({ groupId, ...row }) => ({ key: deps.groupKey(groupId), ...row })) };
}

/** GET /dashboard/api/groups?q=&filter=&refresh=1 */
export async function groupsListHandler(deps: GroupsDeps, _ctx: OwnerContext, search: GroupsQuery): Promise<ApiResult<GroupsView | ApiError>> {
  const filter = search.filter ?? 'all';
  if (!(FILTERS as readonly string[]).includes(filter)) return fail(400, 'invalid', 'The filter must be all, approved or not_approved.');
  const q = search.q ?? '';
  if (q.length > Q_MAX) return fail(400, 'invalid', `The search is too long (at most ${Q_MAX} characters).`);
  let refresh = search.refresh === '1' || search.refresh === 'true';
  if (refresh) {
    const fetchedAt = deps.directory.cachedListing().fetchedAt;
    refresh = fetchedAt === null || deps.clock.now().getTime() - Date.parse(fetchedAt) >= REFRESH_MIN_MS;
  }
  const listing = await deps.directory.list({ refresh });
  return ok(keyed(deps, groupsOverview({ db: deps.db, listing, configs: deps.configs(), q, filter: filter as GroupFilter })));
}

// The rules of ClientSchema (config/groups.ts), plus the matchable-keyword rule parseGroupsFile applies. The code is only
// checked to be a short string here: the writer gives the owner its own message about the format.
const Name = z.string().trim().min(1).max(NAME_MAX);
const Key = z.string().regex(KEY, 'must be a group key from the list');
const Keywords = z
  .array(
    z
      .string()
      .trim()
      .min(3, 'must be at least 3 characters')
      .refine(isMatchablePhrase, `must have at least ${MIN_PHRASE_CHARS} letters once punctuation is removed`),
  )
  .max(20, 'at most 20 per client');
const Domains = z.array(DomainSchema);

const Approve = z.strictObject({ key: Key, name: Name, code: z.string().max(10), emailDomains: Domains.optional(), meetingKeywords: Keywords.optional() });
const Edit = z.strictObject({ key: Key, name: Name.optional(), emailDomains: Domains.optional(), meetingKeywords: Keywords.optional() });

const ApplyBody = z
  .strictObject({
    approve: z.array(Approve).max(MAX_CHANGES).default([]),
    unapprove: z.array(Key).max(MAX_CHANGES).default([]),
    edit: z.array(Edit).max(MAX_CHANGES).default([]),
  })
  .refine((b) => b.approve.length + b.unapprove.length + b.edit.length <= MAX_CHANGES, `at most ${MAX_CHANGES} changes in one save`);

/** The first problem, by field path. Never the value; an unknown field is not named either (it is the sender's text). */
function problem(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'The changes are not valid.';
  const where = issue.path.map(String).join('.');
  const what = issue.code === 'unrecognized_keys' ? 'has a field that is not allowed' : issue.message;
  return `The changes are not valid: ${where === '' ? '' : `${where} `}${what}.`;
}

/**
 * Which group and field the first problem is about, so the dashboard can open that group's form: the key only when the
 * sender's item has a well-formed one, and the field only when it is one of the form's own (never the sender's text).
 */
function problemTarget(error: z.ZodError, body: unknown): { key: string | null; field: string | null } {
  const [list, index, field] = error.issues[0]?.path ?? [];
  if ((list !== 'approve' && list !== 'edit' && list !== 'unapprove') || typeof index !== 'number') return { key: null, field: null };
  const item = (body as Record<string, unknown[]> | null)?.[list]?.[index];
  const key = list === 'unapprove' ? item : (item as { key?: unknown } | null | undefined)?.key;
  const known = typeof field === 'string' && ['name', 'code', 'emailDomains', 'meetingKeywords'].includes(field) ? field : null;
  return { key: typeof key === 'string' && KEY.test(key) ? key : null, field: known };
}

/** Key → group id over the groups the owner can see: the last cached list and the allow-list. */
function keyIndex(deps: GroupsDeps): Map<string, string> {
  const ids = [...(deps.directory.cachedGroups() ?? []).map((g) => g.id), ...deps.configs().map((c) => c.groupId)];
  return new Map(ids.map((id) => [deps.groupKey(id), id]));
}

/** A parser message can name a group by its id; the browser never gets one. */
const withoutIds = (message: string) => message.replace(/\s*\b[0-9-]+@g\.us\b/g, '');

/** POST /dashboard/api/groups/apply with { approve, unapprove, edit }, each group named by its key. */
export async function groupsApplyHandler(deps: GroupsDeps, ctx: OwnerContext, body: unknown): Promise<ApiResult<GroupsView | ApiError>> {
  const parsed = ApplyBody.safeParse(body);
  if (!parsed.success) return fail(400, 'invalid', problem(parsed.error), problemTarget(parsed.error, body));
  const index = keyIndex(deps);
  const unknown = () => fail(400, 'invalid', 'A group in the changes is not in the current list. Refresh the list and try again.');
  const idOf = (key: string) => index.get(key);
  const { approve, unapprove, edit } = parsed.data;
  if (![...approve, ...edit].every((c) => idOf(c.key)) || !unapprove.every((key) => idOf(key))) return unknown();
  const changes: GroupChanges = {
    approve: approve.map(({ key, ...c }) => ({ groupId: idOf(key)!, ...c })),
    unapprove: unapprove.map((key) => idOf(key)!),
    edit: edit.map(({ key, ...c }) => ({ groupId: idOf(key)!, ...c })),
  };

  let result: GroupChangeResult;
  try {
    result = await applyGroupChanges(deps.groupsFile, changes, { db: deps.db });
  } catch (e) {
    if (e instanceof GroupChangeError) {
      return fail(422, 'group_change', withoutIds(e.message), { field: e.field, key: e.groupId === null ? null : deps.groupKey(e.groupId) });
    }
    throw e;
  }

  // The save is done: a failing audit line is logged (by error type only) and the rest carry on.
  const lines: [string, GroupChangeResult['approved']][] = [
    ['Group approved', result.approved],
    ['Group removed', result.removed],
    ['Client edited', result.edited],
  ];
  for (const [what, groups] of lines) {
    for (const g of groups) {
      try {
        deps.audit({ actor: ctx.actor, event: `${what} · ${g.name} (${g.code})`, kind: 'config', requestId: ctx.requestId });
      } catch (e) {
        deps.log.warn({ code: (e as Error | null)?.name ?? 'Error', requestId: ctx.requestId }, 'audit line for a group change could not be written');
      }
    }
  }
  // From the cached list: the answer never waits on WhatsApp.
  return ok(keyed(deps, groupsOverview({ db: deps.db, listing: deps.directory.cachedListing(), configs: result.configs })));
}

/** Upper-case Latin letters of each word, accents removed; anything else (digits, other scripts) is dropped. */
function words(name: string): string[] {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .split(/[^A-Z]+/)
    .filter((w) => w !== '');
}

/**
 * Codes to try for a client name, in order: the first three letters; the initials when the name has 3 or 4 words; the
 * first four letters; then the first two letters plus A to Z. No repeats.
 */
export function codeCandidates(name: string): string[] {
  const w = words(name);
  const letters = w.join('');
  const out: string[] = [];
  const add = (c: string) => {
    if (/^[A-Z]{3,4}$/.test(c) && !out.includes(c)) out.push(c);
  };
  add(letters.slice(0, 3));
  if (w.length >= 3 && w.length <= 4) add(w.map((x) => x[0]).join(''));
  add(letters.slice(0, 4));
  if (letters.length >= 2) for (let i = 0; i < 26; i++) add(letters.slice(0, 2) + String.fromCharCode(65 + i));
  return out;
}

/** The codes in the allow-list file as it is on disk now; a missing or bad file gives none. */
function fileCodes(path: string): string[] {
  try {
    return parseGroupsFile(readFileSync(path, 'utf8').replace(/^﻿/, '')).map((c) => c.code);
  } catch {
    return [];
  }
}

/** GET /dashboard/api/groups/suggest-code?name= : the first code not used in the allow-list file nor by any client row. */
export function suggestCodeHandler(deps: GroupsDeps, _ctx: OwnerContext, name: string): ApiResult<{ code: string | null } | ApiError> {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed.length < 1 || trimmed.length > NAME_MAX) return fail(400, 'invalid', `Enter a client name (1 to ${NAME_MAX} characters).`);
  const used = new Set([...fileCodes(deps.groupsFile), ...listClients(deps.db, false).map((c) => c.code)]);
  return ok({ code: codeCandidates(trimmed).find((c) => !used.has(c)) ?? null });
}
