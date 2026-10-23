import { open, rm, type FileHandle } from 'node:fs/promises';
import { addAbortSignal, Readable } from 'node:stream';
import { drive } from '@googleapis/drive';
import { z } from 'zod';
import { isAuthFailure } from '../output/drive.ts';
import type { OAuth2Client } from '../output/googleAuth.ts';

// Read only. Meet lists the recordings (never Gmail), Calendar gives the invite with the same Meet code, and Drive gives
// the recording file (drive.meet.readonly). Every answer is read through zod; unknown fields are ignored.

export interface ConferenceRef { name: string; space: string; startTime: string; endTime: string | null }
export interface RecordingRef { name: string; state: 'STARTED' | 'ENDED' | 'FILE_GENERATED'; driveFileId: string | null; startTime: string | null; endTime: string | null }
/** Resources (rooms) are left out. */
export interface InviteInfo { title: string; attendees: { email: string; name: string | null; self: boolean }[] }
export interface DriveVideoInfo { name: string; size: number | null; mimeType: string; durationMs: number | null }

export interface MeetingsGoogleApi {
  /** Conferences that started in [fromIso, toIso), all pages up to 20 × 100. */
  listConferences(fromIso: string, toIso: string, signal: AbortSignal): Promise<ConferenceRef[]>;
  /** driveFileId is set only on FILE_GENERATED recordings; recordings in states this code does not know are skipped. */
  listRecordings(conference: string, signal: AbortSignal): Promise<RecordingRef[]>;
  /** Display names of signed-in participants only. */
  listSignedInNames(conference: string, signal: AbortSignal): Promise<string[]>;
  meetingCode(space: string, signal: AbortSignal): Promise<string | null>;
  /** The primary-calendar invite whose Meet conference id equals the code, within ±3 h of startIso. */
  findInvite(code: string, startIso: string, signal: AbortSignal): Promise<InviteInfo | null>;
  videoInfo(fileId: string, signal: AbortSignal): Promise<DriveVideoInfo>;
  /** Streams the file to dest ('wx'), stopping at maxBytes, fsync; removes dest on any failure. Returns bytes written. */
  download(fileId: string, dest: string, maxBytes: number, signal: AbortSignal): Promise<number>;
}

/** Sign-in expired or revoked, or a meeting permission is missing: nothing works until google-auth is run again. */
export class GoogleAccessError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Google sign-in or a meeting permission is missing (${code}). Run: npm run cli -- google-auth`);
    this.name = 'GoogleAccessError';
    this.code = code;
  }
}

/** This one item is gone or not readable by WA Agent (404, or a 403 that is not about scopes or quotas). */
export class GoogleNoAccessError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Google item not found or not readable (${code})`);
    this.name = 'GoogleNoAccessError';
    this.code = code;
  }
}

/** May pass: 429, 5xx, timeouts, network errors, quota 403s, and answers that do not have the expected shape. */
export class GoogleTransientError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Google gave no usable answer (${code})`);
    this.name = 'GoogleTransientError';
    this.code = code;
  }
}

/** The recording is larger than the download limit. */
export class DownloadTooBigError extends Error {
  readonly code = 'too_big';
  constructor() {
    super('Recording is larger than the download limit (too_big)');
    this.name = 'DownloadTooBigError';
  }
}

const MEET = 'https://meet.googleapis.com/v2';
const CALENDAR_EVENTS = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const CALL_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
/** Every list stops here, silently: 20 pages of conferences is 2,000, far more than one pass can need. */
const MAX_PAGES = 20;
const INVITE_WINDOW_MS = 3 * 60 * 60_000;

// Resource names go into URL paths, so only Google's own shapes are accepted (unreserved URL characters only).
const CONFERENCE_NAME = /^conferenceRecords\/[\w.~-]+$/;
const SPACE_NAME = /^spaces\/[\w.~-]+$/;
const FILE_ID = /^[\w-]+$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

const isIsoTime = (s: string): boolean => ISO_TIME.test(s) && !Number.isNaN(Date.parse(s));

function checked(value: string, pattern: RegExp | ((s: string) => boolean), what: string): string {
  const ok = typeof pattern === 'function' ? pattern(value) : pattern.test(value);
  if (!ok) throw new TypeError(`Not a valid ${what}`);
  return value;
}

const Time = z.string().refine(isIsoTime);
const PageToken = z.string().optional();

const ConferencePage = z.object({
  conferenceRecords: z
    .array(z.object({ name: z.string().regex(CONFERENCE_NAME), space: z.string().regex(SPACE_NAME), startTime: Time, endTime: Time.nullish() }))
    .optional(),
  nextPageToken: PageToken,
});

const RECORDING_STATES = new Set<string>(['STARTED', 'ENDED', 'FILE_GENERATED']);
const RecordingPage = z.object({
  recordings: z
    .array(
      z.object({
        name: z.string().min(1),
        state: z.string().optional(),
        driveDestination: z.object({ file: z.string().nullish() }).nullish(),
        startTime: Time.nullish(),
        endTime: Time.nullish(),
      }),
    )
    .optional(),
  nextPageToken: PageToken,
});

const ParticipantPage = z.object({
  participants: z.array(z.object({ signedinUser: z.object({ displayName: z.string().nullish() }).nullish() })).optional(),
  nextPageToken: PageToken,
});

const Space = z.object({ meetingCode: z.string().nullish() });

const EventList = z.object({
  items: z
    .array(
      z.object({
        summary: z.string().nullish(),
        conferenceData: z.object({ conferenceId: z.string().nullish() }).nullish(),
        attendees: z
          .array(z.object({ email: z.string().nullish(), displayName: z.string().nullish(), self: z.boolean().nullish(), resource: z.boolean().nullish() }))
          .nullish(),
      }),
    )
    .optional(),
});

/** Drive sends int64 values as text. */
const Int64 = z.union([z.string(), z.number()]).nullish();
const DriveFile = z.object({
  name: z.string(),
  mimeType: z.string(),
  size: Int64,
  videoMediaMetadata: z.object({ durationMillis: Int64 }).nullish(),
});

/** A whole, non-negative number, from a number or its text; anything else is null. */
function count(v: string | number | null | undefined): number | null {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? v : null;
  if (typeof v !== 'string' || !/^\d+$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new GoogleTransientError('bad_answer');
  return result.data as z.output<T>;
}

const SCOPE_REASONS = new Set(['insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT']);
const RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'downloadQuotaExceeded']);

/**
 * The reasons in a Google error body, in either shape: `error.errors[].reason` (Drive, Calendar), or `error.status`
 * with `error.details[].reason` (AIP-193: Meet). A body that arrived as text (a streamed download) is parsed first.
 * Only compared against fixed sets, never shown.
 */
function errorReasons(data: unknown): Set<string> {
  const out = new Set<string>();
  let body = data;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body) as unknown;
    } catch {
      return out;
    }
  }
  const error = (body as { error?: unknown } | null | undefined)?.error;
  if (typeof error === 'string') out.add(error);
  if (!error || typeof error !== 'object') return out;
  const { status, errors, details } = error as { status?: unknown; errors?: unknown; details?: unknown };
  if (typeof status === 'string') out.add(status);
  for (const list of [errors, details]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const reason = (item as { reason?: unknown } | null)?.reason;
      if (typeof reason === 'string') out.add(reason);
    }
  }
  return out;
}

/** The HTTP status of a gaxios error, read as drive.ts does: response.status, status, or a numeric code. */
function httpStatus(e: unknown): number | undefined {
  const x = e as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  for (const v of [x.response?.status, x.status, x.code]) {
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{3}$/.test(v) ? Number(v) : NaN;
    if (Number.isInteger(n) && n >= 100 && n <= 599) return n;
  }
  return undefined;
}

/**
 * One of the three Google errors, or, after a stop through the signal, the signal's own reason (so callers can tell a
 * stop from a failure). Errors this module raised itself pass through.
 */
function mapError(e: unknown, signal: AbortSignal): unknown {
  if (signal.aborted) return signal.reason ?? e;
  if (e instanceof GoogleAccessError || e instanceof GoogleNoAccessError || e instanceof GoogleTransientError || e instanceof DownloadTooBigError) return e;
  if (e === null || typeof e !== 'object') return new GoogleTransientError('network');
  const status = httpStatus(e);
  if (isAuthFailure(e)) return new GoogleAccessError(status === 401 ? 'http_401' : 'invalid_grant');
  if (status === 403) {
    const reasons = errorReasons((e as { response?: { data?: unknown } }).response?.data);
    if ([...reasons].some((r) => SCOPE_REASONS.has(r))) return new GoogleAccessError('http_403_scope');
    if ([...reasons].some((r) => RATE_REASONS.has(r))) return new GoogleTransientError('http_403_rate');
    return new GoogleNoAccessError('http_403');
  }
  if (status === 404) return new GoogleNoAccessError('http_404');
  if (status !== undefined) return new GoogleTransientError(`http_${status}`);
  const x = e as { code?: unknown; name?: unknown; cause?: { name?: unknown } };
  // Not the caller's stop, so an abort here is the time limit firing.
  const timeoutNames = ['TimeoutError', 'AbortError', 'ETIMEDOUT'];
  if ([x.code, x.name, x.cause?.name].some((v) => typeof v === 'string' && timeoutNames.includes(v))) return new GoogleTransientError('timeout');
  return new GoogleTransientError('network');
}

/** Writes all of buf at the file's current position. */
async function writeAll(fh: FileHandle, buf: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < buf.length) {
    const { bytesWritten } = await fh.write(buf, offset, buf.length - offset);
    if (bytesWritten <= 0) throw Object.assign(new Error('Short write'), { code: 'EIO' });
    offset += bytesWritten;
  }
}

/** The download body as a Node stream (gaxios gives one; a web stream is converted), or null for anything else. */
function asReadable(data: unknown): Readable | null {
  if (data instanceof Readable) return data;
  if (data && typeof (data as { getReader?: unknown }).getReader === 'function') return Readable.fromWeb(data as Parameters<typeof Readable.fromWeb>[0]);
  return null;
}

type Params = Record<string, string>;

export function googleMeetingsApi(client: OAuth2Client): MeetingsGoogleApi {
  const files = drive({ version: 'v3', auth: client }).files;

  async function getJson<T extends z.ZodType>(url: string, params: Params, schema: T, signal: AbortSignal): Promise<z.output<T>> {
    signal.throwIfAborted();
    let data: unknown;
    try {
      ({ data } = await client.request<unknown>({ url, method: 'GET', params, signal, timeout: CALL_TIMEOUT_MS, responseType: 'json' }));
    } catch (e) {
      throw mapError(e, signal);
    }
    return parse(schema, data);
  }

  /** Every page, following nextPageToken, up to MAX_PAGES. */
  async function allPages<P extends { nextPageToken?: string | undefined }>(read: (pageToken: string | undefined) => Promise<P>): Promise<P[]> {
    const pages: P[] = [];
    let token: string | undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      const page = await read(token);
      pages.push(page);
      if (!page.nextPageToken) break;
      token = page.nextPageToken;
    }
    return pages;
  }

  const withToken = (params: Params, token: string | undefined): Params => (token ? { ...params, pageToken: token } : params);

  return {
    async listConferences(fromIso, toIso, signal) {
      const filter = `start_time>="${checked(fromIso, isIsoTime, 'time')}" AND start_time<"${checked(toIso, isIsoTime, 'time')}"`;
      const pages = await allPages((t) => getJson(`${MEET}/conferenceRecords`, withToken({ filter, pageSize: '100' }, t), ConferencePage, signal));
      return pages.flatMap((p) =>
        (p.conferenceRecords ?? []).map((c) => ({ name: c.name, space: c.space, startTime: c.startTime, endTime: c.endTime ?? null })),
      );
    },

    async listRecordings(conference, signal) {
      const url = `${MEET}/${checked(conference, CONFERENCE_NAME, 'conference name')}/recordings`;
      const pages = await allPages((t) => getJson(url, withToken({}, t), RecordingPage, signal));
      const out: RecordingRef[] = [];
      for (const r of pages.flatMap((p) => p.recordings ?? [])) {
        if (r.state === undefined || !RECORDING_STATES.has(r.state)) continue;
        const state = r.state as RecordingRef['state'];
        const file = r.driveDestination?.file;
        out.push({
          name: r.name,
          state,
          // Before FILE_GENERATED the file is not complete, so it is never offered for download.
          driveFileId: state === 'FILE_GENERATED' && file ? file : null,
          startTime: r.startTime ?? null,
          endTime: r.endTime ?? null,
        });
      }
      return out;
    },

    async listSignedInNames(conference, signal) {
      const url = `${MEET}/${checked(conference, CONFERENCE_NAME, 'conference name')}/participants`;
      const pages = await allPages((t) => getJson(url, withToken({}, t), ParticipantPage, signal));
      const names = new Set<string>();
      for (const p of pages.flatMap((page) => page.participants ?? [])) {
        const name = p.signedinUser?.displayName?.trim();
        if (name) names.add(name);
      }
      return [...names];
    },

    async meetingCode(space, signal) {
      const s = await getJson(`${MEET}/${checked(space, SPACE_NAME, 'space name')}`, {}, Space, signal);
      return s.meetingCode || null;
    },

    async findInvite(code, startIso, signal) {
      const start = Date.parse(checked(startIso, isIsoTime, 'time'));
      const params = {
        timeMin: new Date(start - INVITE_WINDOW_MS).toISOString(),
        timeMax: new Date(start + INVITE_WINDOW_MS).toISOString(),
        singleEvents: 'true',
        maxResults: '250',
      };
      const list = await getJson(CALENDAR_EVENTS, params, EventList, signal);
      const event = (list.items ?? []).find((e) => e.conferenceData?.conferenceId === code);
      if (!event) return null;
      const attendees: InviteInfo['attendees'] = [];
      for (const a of event.attendees ?? []) {
        if (a.resource === true || !a.email) continue;
        attendees.push({ email: a.email, name: a.displayName?.trim() || null, self: a.self ?? false });
      }
      return { title: event.summary ?? '', attendees };
    },

    async videoInfo(fileId, signal) {
      checked(fileId, FILE_ID, 'Drive file id');
      signal.throwIfAborted();
      let data: unknown;
      try {
        ({ data } = await files.get(
          { fileId, fields: 'name,size,mimeType,videoMediaMetadata(durationMillis)', supportsAllDrives: true },
          { signal, timeout: CALL_TIMEOUT_MS },
        ));
      } catch (e) {
        throw mapError(e, signal);
      }
      const f = parse(DriveFile, data);
      return { name: f.name, size: count(f.size), mimeType: f.mimeType, durationMs: count(f.videoMediaMetadata?.durationMillis) };
    },

    async download(fileId, dest, maxBytes, signal) {
      checked(fileId, FILE_ID, 'Drive file id');
      signal.throwIfAborted();
      // 'wx': never replaces a file. When dest exists this throws (EEXIST) and the file there is left alone.
      const fh = await open(dest, 'wx');
      let written = 0;
      let local = false; // true while our own disk call runs: its errors are rethrown as they are
      let closing = false;
      try {
        let data: unknown;
        try {
          ({ data } = await files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'stream', signal, timeout: DOWNLOAD_TIMEOUT_MS }));
        } catch (e) {
          throw mapError(e, signal);
        }
        const body = asReadable(data);
        if (!body) throw new GoogleTransientError('bad_answer');
        // A stop ends the read even if the body never sends another byte. Leaving the loop early destroys the body.
        addAbortSignal(signal, body);
        for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
          const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          if (written + buf.length > maxBytes) throw new DownloadTooBigError();
          local = true;
          await writeAll(fh, buf);
          local = false;
          written += buf.length;
        }
        local = true;
        await fh.sync();
        closing = true;
        await fh.close();
        local = false;
      } catch (e) {
        // Closed before removal: Windows cannot delete an open file. Best effort: the original error is what matters.
        if (!closing) await fh.close().catch(() => undefined);
        await rm(dest, { force: true }).catch(() => undefined);
        throw local ? e : mapError(e, signal);
      }
      return written;
    },
  };
}
