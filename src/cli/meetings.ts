import { MAX_OUTPUT_TOKENS } from '../brain/claudeClient.ts';
import { MEETING_MAX_TOKENS } from '../brain/meetingClient.ts';
import { MEETING_SYSTEM_PROMPT, MEETING_TRANSCRIPT_MAX_CHARS } from '../brain/meetingPrompt.ts';
import { MEETING_TRACKER_PROMPT } from '../brain/meetingTracker.ts';
import { requireKey, type Env } from '../config/env.ts';
import { loadGroupsFile, type ClientConfig } from '../config/groups.ts';
import { trackerDbPath } from '../config/paths.ts';
import type { KeyProvider } from '../crypto/keyProvider.ts';
import type { MeetingsGoogleApi } from '../meetings/googleApi.ts';
import { combineMeetingAccounts, MultiAccountMeetingsApi, storedMeetingAccounts } from '../meetings/multiAccount.ts';
import { MeetingWatcher, type FoundMeeting } from '../meetings/watcher.ts';
import { createOAuthClient, MAIN_ACCOUNT, meetingsReady, TokenStore } from '../output/googleAuth.ts';
import { estimateCostUsd, pricesFromEnv, type Prices } from '../spend/pricing.ts';
import { getClientByCode, getClientByGroupId, listClients, syncClients } from '../store/clients.ts';
import { openDb, type Db, type Sql } from '../store/db.ts';
import {
  assignMeeting, getMeetingState, listMeetingsByStatus, retryMeeting, skipMeeting, type MeetingStatus, type MeetingState,
} from '../store/meetings.ts';
import { costUsd, modelFor } from '../stt/prices.ts';
import type { Clock } from '../util/clock.ts';
import { acquireLock } from '../util/lock.ts';
import { silentLogger } from '../util/logger.ts';
import { fromIstDate, isIsoDate, istDate, istShortDate, istTime } from '../util/time.ts';
import { CorrectionError, humanEvent, requestRebuild } from './corrections.ts';

// Meeting commands (Task 12). Titles appear only in `meeting list`, on the operator's own console; every other output
// carries ids, dates, client codes, statuses and counts. Nothing here downloads a recording or makes a paid call.

const LABELS: Record<MeetingStatus, string> = {
  unassigned: 'unassigned', internal: 'internal', queued: 'queued', done: 'done', skipped: 'skipped', too_long: 'too long',
  no_access: 'no access', failed: 'failed',
};

/** What `meeting list` shows without --all. */
export const LIST_DEFAULT: readonly MeetingStatus[] = ['unassigned', 'queued', 'failed', 'no_access'];
/** --all: every status. */
export const LIST_ALL: readonly MeetingStatus[] = ['unassigned', 'internal', 'queued', 'done', 'skipped', 'too_long', 'no_access', 'failed'];

const NOT_ENABLED = 'Meetings are switched off. Set MEETINGS_ENABLED=true in .env (with TEAM_EMAIL_DOMAINS), then run: npm run cli -- google-auth';
const NO_SCOPES = 'Google sign-in needs meeting access. Run: npm run cli -- google-auth';

const stamp = (iso: string): string => `${istDate(new Date(iso))} ${istTime(new Date(iso))}`;

function parseId(raw: string): number {
  const s = raw.trim();
  if (!/^[1-9]\d{0,14}$/.test(s)) throw new CorrectionError('A meeting id is a number, as shown by: npm run cli -- meeting list');
  return Number(s);
}

async function findMeeting(db: Db, raw: string): Promise<MeetingState> {
  const id = parseId(raw);
  const m = await getMeetingState(db, id);
  if (!m) throw new CorrectionError(`No meeting ${id}`);
  return m;
}

/** The lines of `meeting list`: id, IST date, client code (or unassigned / internal), status and the title. */
export async function meetingListLines(db: Db, all: boolean): Promise<string[]> {
  const rows = await listMeetingsByStatus(db, all ? LIST_ALL : LIST_DEFAULT);
  if (rows.length === 0) return [all ? 'No meetings yet.' : 'No meetings need you. (npm run cli -- meeting list --all shows every meeting.)'];
  const codes = new Map(listClients(db, false).map((c) => [c.id, c.code]));
  return rows.map((r) => {
    // A no_access meeting matched as internal keeps no title either, and is labelled internal.
    const internal = r.status === 'internal' || (r.clientId === null && r.foundInternal);
    const who = internal ? 'internal' : r.clientId === null ? 'unassigned' : (codes.get(r.clientId) ?? 'unassigned');
    const status = `${LABELS[r.status]}${(r.status === 'failed' || r.status === 'no_access') && r.errorCode ? ` (${r.errorCode})` : ''}`;
    return `${String(r.id).padStart(5)}  ${stamp(r.startedAt)}  ${who.padEnd(11)}${status.padEnd(26)}${internal ? '' : r.title}`.trimEnd();
  });
}

/**
 * Runs inside the command's own transaction, after its change: the dashboard writes its audit line there, so the change
 * and the line are kept or lost together.
 */
export type InTx<R> = (q: Sql, r: R) => void | Promise<void>;

/**
 * `meeting assign`: an unassigned or internal meeting goes to a client and is queued (match kind human). So does a
 * no-access meeting without a client (found as unassigned or internal): its download is tried again for that client.
 */
export async function assignMeetingToClient(
  db: Db,
  rawId: string,
  clientCode: string,
  now: Date,
  inTx?: InTx<{ id: number; code: string }>,
): Promise<{ id: number; code: string }> {
  const m = await findMeeting(db, rawId);
  const c = getClientByCode(db, clientCode.trim().toUpperCase());
  if (!c) throw new CorrectionError(`No client with code ${clientCode}`);
  if (!c.active) throw new CorrectionError(`Client ${c.code} is not in the allow-list`);
  const clientlessNoAccess = m.status === 'no_access' && m.clientId === null;
  if (m.status !== 'unassigned' && m.status !== 'internal' && !clientlessNoAccess) {
    throw new CorrectionError(
      `Meeting ${m.id} is ${LABELS[m.status]}; only unassigned or internal meetings can be assigned (and no-access ones without a client)`,
    );
  }
  const r = { id: m.id, code: c.code };
  // requestRebuild writes kv, on raw until S1.12, which is allowed inside this transaction.
  await db.tx(async (q) => {
    if (!(await assignMeeting(q, m.id, c.id, now.toISOString()))) throw new CorrectionError(`Meeting ${m.id} changed meanwhile; run meeting list again`);
    await humanEvent(q, null, c.id, 'assign_meeting', { meetingId: m.id }, now);
    requestRebuild(db, now);
    await inTx?.(q, r);
  });
  return r;
}

/** `meeting skip`: an unassigned meeting is not processed. */
export async function skipMeetingById(db: Db, rawId: string, now: Date, inTx?: InTx<number>): Promise<number> {
  const m = await findMeeting(db, rawId);
  if (m.status !== 'unassigned') throw new CorrectionError(`Meeting ${m.id} is ${LABELS[m.status]}; only unassigned meetings can be skipped`);
  await db.tx(async (q) => {
    if (!(await skipMeeting(q, m.id, now.toISOString()))) throw new CorrectionError(`Meeting ${m.id} changed meanwhile; run meeting list again`);
    requestRebuild(db, now); // the workbook lists unassigned meetings
    await inTx?.(q, m.id);
  });
  return m.id;
}

/**
 * `meeting retry`: a failed or no-access meeting is queued again. No rebuild is requested for that: the workbook lists
 * only unassigned and done meetings, and a retry changes neither (the meeting's own finish requests one later).
 * One without a client (found as unassigned or internal) cannot be processed: it goes back to unassigned, which the
 * workbook lists (a rebuild is requested), and the person assigns it with `meeting assign`.
 */
export async function retryMeetingById(
  db: Db,
  rawId: string,
  now: Date,
  inTx?: InTx<{ id: number; status: 'queued' | 'unassigned' }>,
): Promise<{ id: number; status: 'queued' | 'unassigned' }> {
  const m = await findMeeting(db, rawId);
  if (m.status !== 'failed' && m.status !== 'no_access') {
    throw new CorrectionError(`Meeting ${m.id} is ${LABELS[m.status]}; only failed or no-access meetings can be retried`);
  }
  return db.tx(async (q) => {
    const status = await retryMeeting(q, m.id, now.toISOString());
    if (status === null) throw new CorrectionError(`Meeting ${m.id} changed meanwhile; run meeting list again`);
    if (status === 'unassigned') requestRebuild(db, now);
    const r = { id: m.id, status };
    await inTx?.(q, r);
    return r;
  });
}

/** What `meeting retry` prints. */
export function retryLine(r: { id: number; status: 'queued' | 'unassigned' }): string {
  return r.status === 'queued'
    ? `Meeting ${r.id} queued again.`
    : `Meeting ${r.id} has no client, so it cannot be processed; it is unassigned again. Assign it to a client with: npm run cli -- meeting assign ${r.id} <CODE>`;
}

// ---- Commands that need Google ----

export interface MeetingCliDeps {
  env: Env;
  keyProvider: KeyProvider;
  out: (line: string) => void;
  clock: Clock;
  /** Builds the Meet, Calendar and Drive client; tests pass a FakeMeetingsApi. */
  googleApi: (db: Db, key: Buffer) => MeetingsGoogleApi;
  /**
   * The speech list price of one meeting of this length; null when STT_PROVIDER is none. Not given: built from the
   * env's prices by backfill only (speechCeilingFromEnv), so no command needs STT_API_KEY.
   */
  speechCeilingUsd?: ((seconds: number) => number) | null;
  signal?: AbortSignal;
}

/** The real Google client, signed in with the stored token. */
export function defaultMeetingDeps(env: Env, keyProvider: KeyProvider, clock: Clock): MeetingCliDeps {
  return { env, keyProvider, out: (l) => console.log(l), clock, googleApi: storedGoogleApi(env) };
}

/**
 * The list price, with speaker labels, of STT_PROVIDER for a meeting of this length; null when none, $0 for the local
 * engine on this machine. Prices only: no provider, no key.
 */
export function speechCeilingFromEnv(env: Pick<Env, 'STT_PROVIDER' | 'INR_PER_USD'>): ((seconds: number) => number) | null {
  const provider = env.STT_PROVIDER;
  if (provider === 'none') return null;
  if (provider === 'local') return () => 0;
  const price = modelFor(provider, true);
  return (seconds) => costUsd(price, seconds, env.INR_PER_USD);
}

/** The main sign-in and every extra meetings account, as the service builds them (one account: unchanged). */
export function storedGoogleApi(env: Env): (db: Db, key: Buffer) => MeetingsGoogleApi {
  return (db, key) => {
    const token = new TokenStore(db, key).load();
    if (!token) throw new CorrectionError('Google is not connected. Run: npm run cli -- google-auth');
    const newClient = () => createOAuthClient(requireKey(env, 'GOOGLE_OAUTH_CLIENT_ID'), requireKey(env, 'GOOGLE_OAUTH_CLIENT_SECRET'));
    const main = newClient();
    main.setCredentials({ refresh_token: token });
    const log = silentLogger();
    return combineMeetingAccounts(storedMeetingAccounts({ db, key, main, newClient, log }), log).api;
  };
}

/** Characters of transcript per minute of speech counted in the summary ceiling (fast Hinglish is under this). */
export const TRANSCRIPT_CHARS_PER_MINUTE = 1_200;
/** Input characters allowed for the tracker update that follows each summary (the summary and the client's open tasks). */
export const TRACKER_INPUT_CHARS = 40_000;

/**
 * The AI ceiling for one meeting of `seconds`, in US dollars: the summary call plus the tracker update.
 * - Summary: the system prompt and min(minutes x 1,200, MEETING_TRANSCRIPT_MAX_CHARS) transcript characters, all counted
 *   at one token per character (the Devanagari worst case, so estimateCostUsd is given twice the characters), plus a full
 *   MEETING_MAX_TOKENS answer.
 * - Tracker update: the tracker prompt and 40,000 characters at 2 per token, plus a full MAX_OUTPUT_TOKENS answer.
 * At the default prices (input $4, output $20 per million tokens) one hour comes to about $1.
 */
export function meetingAiCeilingUsd(seconds: number, prices: Prices): number {
  const transcript = Math.min(Math.ceil(seconds / 60) * TRANSCRIPT_CHARS_PER_MINUTE, MEETING_TRANSCRIPT_MAX_CHARS);
  const summary = estimateCostUsd(2 * (MEETING_SYSTEM_PROMPT.length + transcript), prices, MEETING_MAX_TOKENS);
  const tracker = estimateCostUsd(MEETING_TRACKER_PROMPT.length + TRACKER_INPUT_CHARS, prices, MAX_OUTPUT_TOKENS);
  return summary + tracker;
}

function watcherFor(deps: MeetingCliDeps, db: Db, api: MeetingsGoogleApi, clients: ClientConfig[]): MeetingWatcher {
  const { env } = deps;
  return new MeetingWatcher({
    db,
    api,
    clock: deps.clock,
    log: silentLogger(),
    settings: { teamDomains: env.TEAM_EMAIL_DOMAINS, maxMinutes: env.MEETING_MAX_MINUTES, since: env.MEETINGS_SINCE ?? istDate(deps.clock.now()) },
    clients,
  });
}

const count = (found: readonly FoundMeeting[], s: MeetingStatus) => found.filter((f) => f.status === s).length;

function costLines(deps: MeetingCliDeps, found: readonly FoundMeeting[]): string[] {
  const queued = found.filter((f) => f.status === 'queued');
  const maxSeconds = deps.env.MEETING_MAX_MINUTES * 60;
  const unknown = queued.filter((f) => f.driveSeconds === null).length;
  // A meeting Drive gives no length for is counted at the longest allowed.
  const seconds = queued.map((f) => f.driveSeconds ?? maxSeconds);
  const hours = seconds.reduce((a, b) => a + b, 0) / 3600;
  const ai = seconds.reduce((a, s) => a + meetingAiCeilingUsd(s, pricesFromEnv(deps.env)), 0);
  const lines = [
    `To be processed: ${queued.length} meeting${queued.length === 1 ? '' : 's'}, about ${hours.toFixed(1)} hours` +
      (unknown > 0 ? ` (${unknown} without a length from Drive, counted at ${deps.env.MEETING_MAX_MINUTES} minutes)` : ''),
  ];
  const speech = deps.speechCeilingUsd === undefined ? speechCeilingFromEnv(deps.env) : deps.speechCeilingUsd;
  if (speech === null) {
    lines.push(`Cost ceiling: AI up to $${ai.toFixed(2)}; speech: speech-to-text not set up (they wait until STT_PROVIDER is set)`);
  } else {
    const stt = seconds.reduce((a, s) => a + speech(s), 0);
    lines.push(`Cost ceiling: up to $${(ai + stt).toFixed(2)} (AI $${ai.toFixed(2)}, speech $${stt.toFixed(2)})`);
  }
  lines.push(`Spending counts toward the daily cap ($${deps.env.DAILY_SPEND_CAP_USD.toFixed(2)}), so a large backfill may take several days.`);
  lines.push('Unassigned and internal meetings cost nothing unless you assign them.');
  return lines;
}

/**
 * `meeting backfill --since`: finds older recordings. Without --yes it stores nothing (the watcher's dry run) and prints
 * the count, the hours and the cost ceiling; with --yes it stores the rows (the service then processes the queued ones).
 * Takes the data-folder lock, like link, so the service must be stopped.
 */
export async function meetingBackfillCommand(opts: { since: string; yes: boolean }, deps: MeetingCliDeps): Promise<void> {
  const { env, out } = deps;
  if (!env.MEETINGS_ENABLED) throw new CorrectionError(NOT_ENABLED);
  if (!isIsoDate(opts.since)) throw new CorrectionError('--since must be YYYY-MM-DD');
  const now = deps.clock.now();
  const from = fromIstDate(opts.since);
  if (from.getTime() >= now.getTime()) throw new CorrectionError('--since must be in the past');
  const lock = await acquireLock(env.DATA_DIR);
  let db: Db | undefined;
  try {
    const key = deps.keyProvider.getKey();
    const configs = loadGroupsFile(env.GROUPS_FILE);
    db = openDb(trackerDbPath(env.DATA_DIR));
    if (!meetingsReady(db)) throw new CorrectionError(NO_SCOPES);
    const api = deps.googleApi(db, key);
    const run = () => {
      // The groups file's clients are synced first, so a newly added client matches in the preview as in the real run.
      syncClients(db!, configs);
      return watcherFor(deps, db!, api, configs).backfill(from.toISOString(), now.toISOString(), deps.signal ?? new AbortController().signal, {
        dryRun: !opts.yes,
      });
    };
    let r: Awaited<ReturnType<typeof run>>;
    if (opts.yes) {
      r = await run();
    } else {
      // The preview syncs inside a transaction that is always rolled back, so it stores nothing. The lock is held (the
      // service is stopped), so no other writer waits on it. S1 only: a raw transaction, because the preview calls Google
      // inside it and the watcher reads through db; S1.12 moves it onto db.tx once the clients store is converted.
      db.raw.exec('BEGIN');
      try {
        r = await run();
      } finally {
        db.raw.exec('ROLLBACK');
      }
    }
    const f = r.found;
    out(`${opts.yes ? 'Stored' : 'Found'} ${f.length} recording${f.length === 1 ? '' : 's'} from ${opts.since} (IST) not stored before` +
      (r.skipped > 0 ? `; ${r.skipped} already stored` : '') + '.');
    if (f.length > 0) {
      out(`  ${count(f, 'queued')} for a client, ${count(f, 'unassigned')} unassigned, ${count(f, 'internal')} internal, ` +
        `${count(f, 'no_access')} no access, ${count(f, 'too_long')} too long`);
      for (const l of costLines(deps, f)) out(l);
    }
    if (r.errors > 0) out(`${r.errors} meeting${r.errors === 1 ? '' : 's'} could not be read from Google this time; run the backfill again later.`);
    if (!opts.yes) {
      out(f.length > 0 ? 'Nothing was changed. Re-run with --yes to store them.' : 'Nothing was changed.');
      return;
    }
    if (r.added > 0) requestRebuild(db, now);
    out('Next: start the service (net start wa-agent); it processes the queued meetings. See them with: npm run cli -- meeting list');
  } finally {
    db?.raw.close();
    await lock.release();
  }
}

const CHECK_DAYS = 7;

/**
 * `meeting check`: the owner's first run. Lists the last 7 days' recordings not yet stored, with each match and whether
 * the file opens. Read only: downloads nothing and stores nothing (the watcher's dry run; the client list is read as it
 * is stored, not synced). The service may keep running.
 */
export async function meetingCheckCommand(deps: MeetingCliDeps): Promise<void> {
  const { env, out } = deps;
  if (!env.MEETINGS_ENABLED) throw new CorrectionError(NOT_ENABLED);
  const key = deps.keyProvider.getKey();
  const configs = loadGroupsFile(env.GROUPS_FILE);
  const db = openDb(trackerDbPath(env.DATA_DIR));
  try {
    if (!meetingsReady(db)) throw new CorrectionError(NO_SCOPES);
    const api = deps.googleApi(db, key);
    const now = deps.clock.now();
    const from = new Date(now.getTime() - CHECK_DAYS * 86_400_000);
    const r = await watcherFor(deps, db, api, configs).backfill(from.toISOString(), now.toISOString(), deps.signal ?? new AbortController().signal, {
      dryRun: true,
    });
    const codes = new Map(listClients(db, false).map((c) => [c.id, c.code]));
    // Read only, with the service possibly running: clients are matched as stored, not synced from the groups file.
    const unsynced = configs.filter((c) => getClientByGroupId(db, c.groupId)?.active !== true).length;
    if (unsynced > 0) {
      out(`${unsynced} client${unsynced === 1 ? '' : 's'} in the groups file ${unsynced === 1 ? 'is' : 'are'} not stored yet; their meetings show as unassigned until the service restarts.`);
    }
    out(`Recordings in the last ${CHECK_DAYS} days not stored yet: ${r.found.length}` + (r.skipped > 0 ? ` (${r.skipped} already stored)` : ''));
    // With several Google accounts, each line names the account that found the recording.
    const router = api instanceof MultiAccountMeetingsApi ? api : null;
    for (const f of [...r.found].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
      const who = f.match === 'client' && f.clientId !== null ? (codes.get(f.clientId) ?? 'client') : f.match;
      const file = f.status === 'no_access' ? 'no access' : 'file opens';
      const length = f.driveSeconds === null ? '' : `  ${Math.round(f.driveSeconds / 60)} min`;
      const account = router ? `  [${router.accountOf(f.recording.split('/recordings/')[0]!) ?? '?'}]` : '';
      out(`  ${istShortDate(new Date(f.startedAt))} ${istTime(new Date(f.startedAt))}  ${who.padEnd(11)}${file}${f.status === 'too_long' ? ' (too long)' : ''}${length}${account}`);
    }
    if (r.errors > 0) out(`${r.errors} meeting${r.errors === 1 ? '' : 's'} could not be read from Google this time; try again later.`);
    for (const label of router?.lostAccounts() ?? []) {
      out(`Google refused the sign-in of account ${label}. Run: npm run cli -- google-auth${label === MAIN_ACCOUNT ? '' : ` --account ${label}`}`);
    }
    out('Nothing was downloaded or stored.');
  } finally {
    db.raw.close();
  }
}
