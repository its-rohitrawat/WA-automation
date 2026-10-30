import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { DomainSchema } from '../../config/domains.ts';
import { parseGroupsFile, type ClientConfig } from '../../config/groups.ts';
import { applyGroupChanges, GroupChangeError, type GroupChangeResult, type GroupChanges } from '../../config/groupsWriter.ts';
import { groupsOverview, type GroupDirectory, type GroupFilter, type GroupRow, type GroupsOverview } from '../../control/groups.ts';
import { getClientByGroupId, listClients } from '../../store/clients.ts';
import type { Db } from '../../store/db.ts';
import { deleteKv, setKv } from '../../store/kv.ts';
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
/** At most this many groups in one bulk approve or ignore. */
export const MAX_BULK = 50;
const NAME_MAX = 80;
const Q_MAX = 200;
/** A refresh asked for sooner than this after the last list is ignored, so the button cannot hammer WhatsApp. */
export const REFRESH_MIN_MS = 30_000;
const FILTERS: readonly GroupFilter[] = ['all', 'approved', 'not_approved', 'ignored'];
const KEY = /^[0-9a-f]{24}$/;
/**
 * kv key for an ignored group, by its group key (not its id: an old-style id holds the creator's phone number, and an
 * untracked group's name never reaches disk).
 */
const IGNORED = 'group_ignored:';

/** The first 24 hex characters of HMAC-SHA256 over the group id. */
export function makeGroupKey(secret: Uint8Array): (groupId: string) => string {
  return (groupId) => createHmac('sha256', secret).update(groupId).digest('hex').slice(0, 24);
}

function keyed(deps: GroupsDeps, o: GroupsOverview): GroupsView {
  return { ...o, rows: o.rows.map(({ groupId, ...row }) => ({ key: deps.groupKey(groupId), ...row })) };
}

/** Which groups the owner ignored: one read of the kv rows, then a check by key. */
function ignoredCheck(deps: GroupsDeps): (groupId: string) => boolean {
  const keys = new Set(
    (deps.db.raw.prepare('SELECT k FROM kv WHERE k GLOB ?').all(`${IGNORED}*`) as { k: string }[]).map((r) => r.k.slice(IGNORED.length)),
  );
  return (groupId) => keys.size > 0 && keys.has(deps.groupKey(groupId));
}

/** The list from the cached listing (never waiting on WhatsApp) with these configs. */
async function cachedView(deps: GroupsDeps, configs: ClientConfig[]): Promise<GroupsView> {
  return keyed(deps, await groupsOverview({ db: deps.db, listing: deps.directory.cachedListing(), configs, ignored: ignoredCheck(deps) }));
}

/** One audit line; a failing write is logged (by error type only) and the caller carries on. */
function auditLine(deps: GroupsDeps, ctx: OwnerContext, event: string): void {
  try {
    deps.audit({ actor: ctx.actor, event, kind: 'config', requestId: ctx.requestId });
  } catch (e) {
    deps.log.warn({ code: (e as Error | null)?.name ?? 'Error', requestId: ctx.requestId }, 'audit line for a group change could not be written');
  }
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
  return ok(keyed(deps, await groupsOverview({ db: deps.db, listing, configs: deps.configs(), q, filter: filter as GroupFilter, ignored: ignoredCheck(deps) })));
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
    for (const g of groups) auditLine(deps, ctx, `${what} · ${g.name} (${g.code})`);
  }
  // A group approved is no longer set aside.
  for (const g of result.approved) await deleteKv(deps.db, IGNORED + deps.groupKey(g.groupId));
  // From the cached list: the answer never waits on WhatsApp.
  return ok(await cachedView(deps, result.configs));
}

const BulkBody = z.strictObject({
  action: z.enum(['approve', 'ignore', 'unignore']),
  keys: z
    .array(Key)
    .min(1, 'must name at least one group')
    .max(MAX_BULK, `at most ${MAX_BULK} groups at once`)
    .refine((k) => new Set(k).size === k.length, 'must not name a group twice'),
});

/** One group's outcome in a bulk change: reason is a plain sentence for the owner when it did not work. */
export interface BulkResult {
  key: string;
  ok: boolean;
  reason: string | null;
}
export type BulkView = GroupsView & { results: BulkResult[] };

/** "Desai Foods x Studio" → "Desai Foods": the client's side of a shared group's name (as the approve form fills it). */
export function clientPart(name: string): string {
  return (name.split(/\s+[x×–-]\s+/i)[0]?.trim() || name.trim()).slice(0, NAME_MAX).trim();
}

/** The first code for this name not used in the allow-list file nor by any client row, or null. */
async function freeCode(deps: GroupsDeps, name: string): Promise<string | null> {
  const used = new Set([...fileCodes(deps.groupsFile), ...(await listClients(deps.db, false)).map((c) => c.code)]);
  return codeCandidates(name).find((c) => !used.has(c)) ?? null;
}

/**
 * POST /dashboard/api/groups/bulk with { action: 'approve' | 'ignore' | 'unignore', keys }: up to 50 groups, each on its
 * own. An approve is the single approve's own write (applyGroupChanges, one group at a time, in order), with the name and
 * code the approve form would suggest (a former client keeps its name and code); one group failing does not stop the
 * others, and each result says why. Ignore sets an untracked group aside; unignore brings it back.
 */
export async function groupsBulkHandler(deps: GroupsDeps, ctx: OwnerContext, body: unknown): Promise<ApiResult<BulkView | ApiError>> {
  const parsed = BulkBody.safeParse(body);
  if (!parsed.success) return fail(400, 'invalid', problem(parsed.error));
  const index = keyIndex(deps);
  const { action, keys } = parsed.data;
  if (!keys.every((key) => index.has(key))) return fail(400, 'invalid', 'A group in the changes is not in the current list. Refresh the list and try again.');
  let configs = deps.configs();
  const results: BulkResult[] = [];
  const done = (key: string) => results.push({ key, ok: true, reason: null });
  const failed = (key: string, reason: string) => results.push({ key, ok: false, reason });

  if (action !== 'approve') {
    const tracked = new Set(configs.map((c) => c.groupId));
    const at = deps.clock.now().toISOString();
    await deps.db.tx(async (q) => {
      for (const key of keys) {
        if (tracked.has(index.get(key)!)) failed(key, 'It is tracked. Remove it from the agent first.');
        else {
          if (action === 'ignore') await setKv(q, IGNORED + key, at);
          else await deleteKv(q, IGNORED + key);
          done(key);
        }
      }
    });
    // No name: an untracked group's name never reaches disk.
    for (const r of results) if (r.ok) auditLine(deps, ctx, action === 'ignore' ? 'Group ignored' : 'Group shown again');
    return ok({ ...await cachedView(deps, configs), results });
  }

  const subjects = new Map((deps.directory.cachedGroups() ?? []).map((g) => [g.id, g.subject]));
  for (const key of keys) {
    const groupId = index.get(key)!;
    if (configs.some((c) => c.groupId === groupId)) {
      failed(key, 'It is tracked already.');
      continue;
    }
    // A group removed earlier keeps its client row: it comes back with that name and code, as in the approve form.
    const former = await getClientByGroupId(deps.db, groupId);
    const name = former ? former.name.slice(0, NAME_MAX).trim() : clientPart(subjects.get(groupId) ?? '');
    if (!name) {
      failed(key, 'The group has no name. Approve it on its own to give the client one.');
      continue;
    }
    const code = former?.code ?? (await freeCode(deps, name));
    if (!code) {
      failed(key, 'No code could be made from its name. Approve it on its own to choose one.');
      continue;
    }
    try {
      const result = await applyGroupChanges(deps.groupsFile, { approve: [{ groupId, name, code }] }, { db: deps.db });
      configs = result.configs;
      await deleteKv(deps.db, IGNORED + key);
      for (const g of result.approved) auditLine(deps, ctx, `Group approved · ${g.name} (${g.code})`);
      done(key);
    } catch (e) {
      if (e instanceof GroupChangeError) failed(key, withoutIds(e.message));
      else {
        deps.log.warn({ code: (e as Error | null)?.name ?? 'Error', requestId: ctx.requestId }, 'a group in a bulk approve could not be saved');
        failed(key, 'Saving did not work. Try again.');
      }
    }
  }
  return ok({ ...await cachedView(deps, configs), results });
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
export async function suggestCodeHandler(deps: GroupsDeps, _ctx: OwnerContext, name: string): Promise<ApiResult<{ code: string | null } | ApiError>> {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed.length < 1 || trimmed.length > NAME_MAX) return fail(400, 'invalid', `Enter a client name (1 to ${NAME_MAX} characters).`);
  return ok({ code: await freeCode(deps, trimmed) });
}
