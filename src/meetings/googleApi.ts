import { open, rm, type FileHandle } from 'node:fs/promises';
import { addAbortSignal, Readable } from 'node:stream';
import { drive } from '@googleapis/drive';
import { z } from 'zod';
import type { OAuth2Client } from '../output/googleAuth.ts';
import { DownloadTooBigError, GoogleTransientError, mapGoogleError } from './googleErrors.ts';

export { DownloadTooBigError, GoogleAccessError, GoogleNoAccessError, GoogleTransientError } from './googleErrors.ts';

// Read only. Meet lists the recordings (never Gmail), Calendar gives the invite with the same Meet code, and Drive gives
// the recording file (drive.meet.readonly). Every answer is read through zod; unknown fields are ignored. No call is
// retried here (callers retry), and every Google failure is thrown as described at mapGoogleError.

export interface ConferenceRef { name: string; space: string; startTime: string; endTime: string | null }
export interface RecordingRef { name: string; state: 'STARTED' | 'ENDED' | 'FILE_GENERATED'; driveFileId: string | null; startTime: string | null; endTime: string | null }
/** Resources (rooms) are left out. */
export interface InviteInfo { title: string; attendees: { email: string; name: string | null; self: boolean }[] }
export interface DriveVideoInfo { name: string; size: number | null; mimeType: string; durationMs: number | null }

export interface MeetingsGoogleApi {
  /** Conferences that started in [fromIso, toIso), up to 20 pages of 100. A malformed record is skipped. */
  listConferences(fromIso: string, toIso: string, signal: AbortSignal): Promise<ConferenceRef[]>;
  /**
   * Up to 20 pages. Recordings in states this code does not know are skipped. driveFileId is set only on FILE_GENERATED
   * recordings whose file id has Drive's shape; otherwise it is null.
   */
  listRecordings(conference: string, signal: AbortSignal): Promise<RecordingRef[]>;
  /** Display names of signed-in participants only, trimmed, deduped, empty ones dropped. Up to 20 pages. */
  listSignedInNames(conference: string, signal: AbortSignal): Promise<string[]>;
  meetingCode(space: string, signal: AbortSignal): Promise<string | null>;
  /**
   * The primary-calendar invite whose Meet conference id equals the code, among events within ±3 h of startIso (up to 20
   * pages). When several match, the one whose start is closest to startIso. Null when none matches.
   */
  findInvite(code: string, startIso: string, signal: AbortSignal): Promise<InviteInfo | null>;
  videoInfo(fileId: string, signal: AbortSignal): Promise<DriveVideoInfo>;
  /**
   * Streams the file to dest, opened with 'wx', and returns the bytes written. Past maxBytes it stops with
   * DownloadTooBigError. When all is read it fsyncs, then closes.
   * - dest already exists: the raw EEXIST error, and the existing file is left alone.
   * - Disk errors (open, write, fsync, close) come back as raw Node errors; Google errors as the Google error classes;
   *   a stop through the signal as the signal's reason.
   * - On any failure after dest was opened, dest is closed and removed. A failed removal is ignored: the part file is
   *   then left behind, and the next 'wx' download to the same dest fails with EEXIST, which the caller must handle.
   */
  download(fileId: string, dest: string, maxBytes: number, signal: AbortSignal): Promise<number>;
}

const MEET = 'https://meet.googleapis.com/v2';
const CALENDAR_EVENTS = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const CALL_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
/** Every list stops here, silently: 20 pages of conferences is 2,000, far more than one pass can need. */
const MAX_PAGES = 20;
const INVITE_WINDOW_MS = 3 * 60 * 60_000;
/** Only what findInvite reads, so full event bodies are not downloaded. */
const EVENT_FIELDS = 'items(summary,start,conferenceData/conferenceId,attendees(email,displayName,self,resource)),nextPageToken';

// Resource names go into URL paths, so only Google's own shapes are accepted: letters, digits, '_' and '-'. No dots, so
// a segment can never be '.' or '..'.
const CONFERENCE_NAME = /^conferenceRecords\/[\w-]+$/;
const SPACE_NAME = /^spaces\/[\w-]+$/;
const FILE_ID = /^[\w-]+$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

const isIsoTime = (s: string): boolean => ISO_TIME.test(s) && !Number.isNaN(Date.parse(s));

function check<T>(value: T, ok: boolean, what: string): T {
  if (!ok) throw new TypeError(`Not a valid ${what}`);
  return value;
}

// The input checks, run before anything is asked of Google. Exported so the fake runs the same ones. Each throws TypeError.
export const checkConferenceName = (name: string): string => check(name, CONFERENCE_NAME.test(name), 'conference name');
export const checkSpaceName = (name: string): string => check(name, SPACE_NAME.test(name), 'space name');
export const checkFileId = (id: string): string => check(id, FILE_ID.test(id), 'Drive file id');
export const checkIsoTime = (iso: string): string => check(iso, isIsoTime(iso), 'time');
export const checkMaxBytes = (n: number): number => check(n, Number.isSafeInteger(n) && n >= 0, 'byte limit');

const Time = z.string().refine(isIsoTime);
const PageToken = z.string().optional();

const ConferenceItem = z.object({ name: z.string().regex(CONFERENCE_NAME), space: z.string().regex(SPACE_NAME), startTime: Time, endTime: Time.nullish() });
// Items are checked one by one, so a malformed record is skipped, not the whole page.
const ConferencePage = z.object({ conferenceRecords: z.array(z.unknown()).optional(), nextPageToken: PageToken });

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

const EventItem = z.object({
  summary: z.string().nullish(),
  start: z.object({ dateTime: z.string().nullish(), date: z.string().nullish() }).nullish(),
  conferenceData: z.object({ conferenceId: z.string().nullish() }).nullish(),
  attendees: z
    .array(z.object({ email: z.string().nullish(), displayName: z.string().nullish(), self: z.boolean().nullish(), resource: z.boolean().nullish() }))
    .nullish(),
});
const EventPage = z.object({ items: z.array(EventItem).optional(), nextPageToken: PageToken });

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
      throw mapGoogleError(e, signal);
    }
    return parse(schema, data);
  }

  /** Every page, following nextPageToken, up to MAX_PAGES. A token seen before ends the list, so no page comes twice. */
  async function allPages<P extends { nextPageToken?: string | undefined }>(read: (pageToken: string | undefined) => Promise<P>): Promise<P[]> {
    const pages: P[] = [];
    const seen = new Set<string>();
    let token: string | undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      const page = await read(token);
      pages.push(page);
      const next = page.nextPageToken;
      if (!next || seen.has(next)) break;
      seen.add(next);
      token = next;
    }
    return pages;
  }

  const withToken = (params: Params, token: string | undefined): Params => (token ? { ...params, pageToken: token } : params);

  return {
    async listConferences(fromIso, toIso, signal) {
      const filter = `start_time>="${checkIsoTime(fromIso)}" AND start_time<"${checkIsoTime(toIso)}"`;
      const pages = await allPages((t) => getJson(`${MEET}/conferenceRecords`, withToken({ filter, pageSize: '100' }, t), ConferencePage, signal));
      const out: ConferenceRef[] = [];
      for (const raw of pages.flatMap((p) => p.conferenceRecords ?? [])) {
        const c = ConferenceItem.safeParse(raw);
        if (c.success) out.push({ name: c.data.name, space: c.data.space, startTime: c.data.startTime, endTime: c.data.endTime ?? null });
      }
      return out;
    },

    async listRecordings(conference, signal) {
      const url = `${MEET}/${checkConferenceName(conference)}/recordings`;
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
          driveFileId: state === 'FILE_GENERATED' && file && FILE_ID.test(file) ? file : null,
          startTime: r.startTime ?? null,
          endTime: r.endTime ?? null,
        });
      }
      return out;
    },

    async listSignedInNames(conference, signal) {
      const url = `${MEET}/${checkConferenceName(conference)}/participants`;
      const pages = await allPages((t) => getJson(url, withToken({}, t), ParticipantPage, signal));
      const names = new Set<string>();
      for (const p of pages.flatMap((page) => page.participants ?? [])) {
        const name = p.signedinUser?.displayName?.trim();
        if (name) names.add(name);
      }
      return [...names];
    },

    async meetingCode(space, signal) {
      const s = await getJson(`${MEET}/${checkSpaceName(space)}`, {}, Space, signal);
      return s.meetingCode || null;
    },

    async findInvite(code, startIso, signal) {
      const start = Date.parse(checkIsoTime(startIso));
      const params = {
        timeMin: new Date(start - INVITE_WINDOW_MS).toISOString(),
        timeMax: new Date(start + INVITE_WINDOW_MS).toISOString(),
        singleEvents: 'true',
        maxResults: '250',
        fields: EVENT_FIELDS,
      };
      // A page can be short or empty while more follow, so every page is read.
      const pages = await allPages((t) => getJson(CALENDAR_EVENTS, withToken(params, t), EventPage, signal));
      let event: z.output<typeof EventItem> | undefined;
      let bestGap = Number.POSITIVE_INFINITY;
      for (const e of pages.flatMap((p) => p.items ?? [])) {
        if (e.conferenceData?.conferenceId !== code) continue;
        const at = Date.parse(e.start?.dateTime ?? e.start?.date ?? '');
        const gap = Number.isNaN(at) ? Number.POSITIVE_INFINITY : Math.abs(at - start);
        if (event === undefined || gap < bestGap) {
          event = e;
          bestGap = gap;
        }
      }
      if (!event) return null;
      const attendees: InviteInfo['attendees'] = [];
      for (const a of event.attendees ?? []) {
        if (a.resource === true || !a.email) continue;
        attendees.push({ email: a.email, name: a.displayName?.trim() || null, self: a.self ?? false });
      }
      return { title: event.summary ?? '', attendees };
    },

    async videoInfo(fileId, signal) {
      checkFileId(fileId);
      signal.throwIfAborted();
      let data: unknown;
      try {
        ({ data } = await files.get(
          { fileId, fields: 'name,size,mimeType,videoMediaMetadata(durationMillis)', supportsAllDrives: true },
          { signal, timeout: CALL_TIMEOUT_MS, retry: false },
        ));
      } catch (e) {
        throw mapGoogleError(e, signal);
      }
      const f = parse(DriveFile, data);
      return { name: f.name, size: count(f.size), mimeType: f.mimeType, durationMs: count(f.videoMediaMetadata?.durationMillis) };
    },

    async download(fileId, dest, maxBytes, signal) {
      checkFileId(fileId);
      checkMaxBytes(maxBytes);
      signal.throwIfAborted();
      // 'wx' never replaces a file: when dest exists, open throws EEXIST here and the existing file is left alone.
      const fh = await open(dest, 'wx');
      let written = 0;
      let local = false; // true while our own disk call runs: its error is rethrown as it is
      let closing = false;
      try {
        // retry: false, so the 30 minutes are the whole download, not one attempt of several.
        const { data } = await files.get(
          { fileId, alt: 'media', supportsAllDrives: true },
          { responseType: 'stream', signal, timeout: DOWNLOAD_TIMEOUT_MS, retry: false },
        );
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
      } catch (e) {
        // Closed before removal: Windows cannot delete an open file. A failed close or removal is ignored here.
        if (!closing) await fh.close().catch(() => undefined);
        await rm(dest, { force: true }).catch(() => undefined);
        throw local ? e : mapGoogleError(e, signal);
      }
      return written;
    },
  };
}
