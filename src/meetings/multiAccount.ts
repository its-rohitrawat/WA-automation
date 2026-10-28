import { hasMeetingScopes, MAIN_ACCOUNT, meetingAccounts, TokenDecryptError, TokenStore, type OAuth2Client } from '../output/googleAuth.ts';
import type { Db } from '../store/db.ts';
import type { Logger } from '../util/logger.ts';
import { googleMeetingsApi, type ConferenceRef, type DriveVideoInfo, type InviteInfo, type MeetingsGoogleApi, type RecordingRef } from './googleApi.ts';
import { GoogleAccessError, GoogleNoAccessError, GoogleTransientError } from './googleErrors.ts';

// Several Google accounts behind one MeetingsGoogleApi, so the watcher and the processor stay single-account.
// - Discovery asks every account and merges the conferences (the first account to list one owns it).
// - Every later call goes to the account that listed the conference, space, file or meeting code. After a restart, or for
//   an item no account listed in this process, the accounts are tried in order: a no-access or sign-in error moves on to
//   the next account, a transient error is rethrown at once (the caller retries later).
// Logs carry the account label and error codes only, never an email, title or name.

export interface MeetingAccount {
  /** 'main' for the main sign-in, or the label given to `google-auth --account`. */
  label: string;
  api: MeetingsGoogleApi;
}

type GoogleError = GoogleAccessError | GoogleNoAccessError | GoogleTransientError;

const isGoogleError = (e: unknown): e is GoogleError =>
  e instanceof GoogleAccessError || e instanceof GoogleNoAccessError || e instanceof GoogleTransientError;

/** The most serious of the accounts' errors: a lost sign-in (Health shows it), then a transient one, then no access. */
function worst(errors: GoogleError[]): GoogleError {
  const rank = (e: GoogleError): number => (e instanceof GoogleAccessError ? 3 : e instanceof GoogleTransientError ? 2 : 1);
  return errors.reduce((a, b) => (rank(b) > rank(a) ? b : a));
}

/**
 * The accounts meetings may use: the main sign-in (its client, already holding its token) when it has every meeting
 * scope, then each extra account that has them. An account without the meeting scopes gets no call at all. An extra
 * token this key cannot read is skipped and logged by label. No account qualifies: the main one, so the API exists and
 * the service stays paused (google_scopes) without calling Google.
 */
export function storedMeetingAccounts(o: {
  db: Db;
  key: Buffer;
  main: OAuth2Client;
  newClient: () => OAuth2Client;
  log: Logger;
}): MeetingAccount[] {
  const out: MeetingAccount[] = [];
  if (hasMeetingScopes(o.db)) out.push({ label: MAIN_ACCOUNT, api: googleMeetingsApi(o.main) });
  for (const label of meetingAccounts(o.db)) {
    if (!hasMeetingScopes(o.db, label)) continue;
    let token: string | undefined;
    try {
      token = new TokenStore(o.db, o.key, label).load();
    } catch (e) {
      if (!(e instanceof TokenDecryptError)) throw e;
      o.log.warn({ account: label, code: 'token_unreadable' }, 'meeting account skipped: its stored sign-in cannot be read');
      continue;
    }
    if (!token) continue;
    const client = o.newClient();
    client.setCredentials({ refresh_token: token });
    out.push({ label, api: googleMeetingsApi(client) });
  }
  return out.length > 0 ? out : [{ label: MAIN_ACCOUNT, api: googleMeetingsApi(o.main) }];
}

/** What hubMeetingAccounts reads of GoogleAuthHub: each account's current client. */
export interface MeetingClients {
  client(label: string): OAuth2Client | undefined;
}

/**
 * The accounts meetings may use, from the hub's current clients (D3): the main sign-in when it has every meeting scope
 * and a client, then each meeting account that has both. An account without either gets no call at all. Unlike
 * storedMeetingAccounts there is no fallback: with no account, LiveMeetingsApi refuses each call as not connected.
 */
export function hubMeetingAccounts(db: Db, hub: MeetingClients): MeetingAccount[] {
  const out: MeetingAccount[] = [];
  for (const label of [MAIN_ACCOUNT, ...meetingAccounts(db)]) {
    const client = hub.client(label);
    if (!client || !hasMeetingScopes(db, label === MAIN_ACCOUNT ? undefined : label)) continue;
    out.push({ label, api: googleMeetingsApi(client) });
  }
  return out;
}

/**
 * The combined meetings API, rebuilt in place when an account is reconnected (GoogleAuthHub.onChange → rebuild()), so
 * meetings resume without a restart. A call in flight finishes on the build it started with. A rebuild forgets which
 * account listed which item; the router then tries the accounts in order, as after a restart.
 */
export class LiveMeetingsApi implements MeetingsGoogleApi {
  readonly #build: () => MeetingAccount[];
  readonly #log: Logger;
  #current: { api: MeetingsGoogleApi; router: MultiAccountMeetingsApi | null } | null = null;

  constructor(build: () => MeetingAccount[], log: Logger) {
    this.#build = build;
    this.#log = log;
    this.rebuild();
  }

  rebuild(): void {
    const accounts = this.#build();
    this.#current = accounts.length === 0 ? null : combineMeetingAccounts(accounts, this.#log);
  }

  /** As MultiAccountMeetingsApi.lostAccounts; empty with one account (the meetings service shows that one as paused). */
  lostAccounts(): string[] {
    return this.#current?.router?.lostAccounts() ?? [];
  }

  accountOf(conference: string): string | null {
    return this.#current?.router?.accountOf(conference) ?? null;
  }

  #api(): MeetingsGoogleApi {
    if (!this.#current) throw new GoogleAccessError('not_connected');
    return this.#current.api;
  }

  async listConferences(fromIso: string, toIso: string, signal: AbortSignal): Promise<ConferenceRef[]> {
    return this.#api().listConferences(fromIso, toIso, signal);
  }
  async listRecordings(conference: string, signal: AbortSignal): Promise<RecordingRef[]> {
    return this.#api().listRecordings(conference, signal);
  }
  async listSignedInNames(conference: string, signal: AbortSignal): Promise<string[]> {
    return this.#api().listSignedInNames(conference, signal);
  }
  async meetingCode(space: string, signal: AbortSignal): Promise<string | null> {
    return this.#api().meetingCode(space, signal);
  }
  async findInvite(code: string, startIso: string, signal: AbortSignal): Promise<InviteInfo | null> {
    return this.#api().findInvite(code, startIso, signal);
  }
  async videoInfo(fileId: string, signal: AbortSignal): Promise<DriveVideoInfo> {
    return this.#api().videoInfo(fileId, signal);
  }
  async download(fileId: string, dest: string, maxBytes: number, signal: AbortSignal): Promise<number> {
    return this.#api().download(fileId, dest, maxBytes, signal);
  }
}

/** One account: its API unchanged, and no account labels. Several: the router. */
export function combineMeetingAccounts(
  accounts: readonly MeetingAccount[],
  log: Logger,
): { api: MeetingsGoogleApi; router: MultiAccountMeetingsApi | null } {
  if (accounts.length === 0) throw new Error('No Google account for meetings');
  if (accounts.length === 1) return { api: accounts[0]!.api, router: null };
  const router = new MultiAccountMeetingsApi(accounts, log);
  return { api: router, router };
}

export class MultiAccountMeetingsApi implements MeetingsGoogleApi {
  readonly #accounts: readonly MeetingAccount[];
  readonly #log: Logger;
  /** Conference, space, Drive file id or meeting code → the index of the account that listed it. */
  readonly #owner = new Map<string, number>();
  /** Accounts whose last answer was a sign-in or permission refusal; cleared by their next answer that works. */
  readonly #lost = new Set<number>();

  constructor(accounts: readonly MeetingAccount[], log: Logger) {
    this.#accounts = accounts;
    this.#log = log;
  }

  /** Labels of the accounts whose sign-in Google refused last time, in account order. */
  lostAccounts(): string[] {
    return [...this.#lost].sort((a, b) => a - b).map((i) => this.#accounts[i]!.label);
  }

  /** The label of the account that listed this conference in this process, or null. */
  accountOf(conference: string): string | null {
    const i = this.#owner.get(conference);
    return i === undefined ? null : this.#accounts[i]!.label;
  }

  #note(i: number, e?: unknown): void {
    if (e instanceof GoogleAccessError) this.#lost.add(i);
    else if (e === undefined) this.#lost.delete(i);
  }

  /**
   * Every account's conferences, each once. An account that fails is skipped for this pass (logged); only when every
   * account failed is the most serious error thrown, so one lost sign-in does not stop the other accounts.
   */
  async listConferences(fromIso: string, toIso: string, signal: AbortSignal): Promise<ConferenceRef[]> {
    const out: ConferenceRef[] = [];
    const failures: GoogleError[] = [];
    for (const [i, a] of this.#accounts.entries()) {
      let list: ConferenceRef[];
      try {
        list = await a.api.listConferences(fromIso, toIso, signal);
        this.#note(i);
      } catch (e) {
        if (signal.aborted || !isGoogleError(e)) throw e;
        this.#note(i, e);
        failures.push(e);
        this.#log.warn({ account: a.label, code: e.code }, 'meeting account skipped this pass');
        continue;
      }
      for (const c of list) {
        if (this.#owner.has(c.name)) continue; // already listed by an earlier account
        this.#owner.set(c.name, i);
        this.#owner.set(c.space, i);
        out.push(c);
      }
    }
    if (failures.length === this.#accounts.length) throw worst(failures);
    return out;
  }

  async listRecordings(conference: string, signal: AbortSignal): Promise<RecordingRef[]> {
    const { value, index } = await this.#route(conference, signal, (api) => api.listRecordings(conference, signal));
    for (const r of value) if (r.driveFileId !== null) this.#owner.set(r.driveFileId, index);
    return value;
  }

  async listSignedInNames(conference: string, signal: AbortSignal): Promise<string[]> {
    return (await this.#route(conference, signal, (api) => api.listSignedInNames(conference, signal))).value;
  }

  async meetingCode(space: string, signal: AbortSignal): Promise<string | null> {
    const { value, index } = await this.#route(space, signal, (api) => api.meetingCode(space, signal));
    // The invite is looked up in the calendar of the account that hosted or joined the meeting.
    if (value !== null && !this.#owner.has(value)) this.#owner.set(value, index);
    return value;
  }

  /** The owner's calendar first; another account's calendar when the owner has no matching invite. */
  async findInvite(code: string, startIso: string, signal: AbortSignal): Promise<InviteInfo | null> {
    return (await this.#route(code, signal, (api) => api.findInvite(code, startIso, signal), (r) => r !== null)).value;
  }

  async videoInfo(fileId: string, signal: AbortSignal): Promise<DriveVideoInfo> {
    return (await this.#route(fileId, signal, (api) => api.videoInfo(fileId, signal))).value;
  }

  async download(fileId: string, dest: string, maxBytes: number, signal: AbortSignal): Promise<number> {
    return (await this.#route(fileId, signal, (api) => api.download(fileId, dest, maxBytes, signal))).value;
  }

  /**
   * The owner of `key` first, then the other accounts in order. A no-access or sign-in error, or an answer `found` rejects,
   * moves on to the next account; any other error is thrown at once. The first accepted answer wins and its account
   * becomes the owner. No accepted answer: the first rejected answer, else the most serious error.
   */
  async #route<T>(
    key: string,
    signal: AbortSignal,
    call: (api: MeetingsGoogleApi) => Promise<T>,
    found: (value: T) => boolean = () => true,
  ): Promise<{ value: T; index: number }> {
    const owner = this.#owner.get(key);
    const order = [...this.#accounts.keys()];
    if (owner !== undefined) order.sort((a, b) => Number(b === owner) - Number(a === owner));
    let rejected: { value: T; index: number } | undefined;
    const failures: GoogleError[] = [];
    for (const i of order) {
      let value: T;
      try {
        value = await call(this.#accounts[i]!.api);
        this.#note(i);
      } catch (e) {
        if (signal.aborted || !(e instanceof GoogleNoAccessError || e instanceof GoogleAccessError)) throw e;
        this.#note(i, e);
        failures.push(e);
        continue;
      }
      if (found(value)) {
        this.#owner.set(key, i);
        return { value, index: i };
      }
      rejected ??= { value, index: i };
    }
    if (rejected) return rejected;
    throw worst(failures);
  }
}
