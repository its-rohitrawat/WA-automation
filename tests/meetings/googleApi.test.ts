import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// No network: Meet and Calendar go through client.request (stubbed here), Drive through @googleapis/drive (mocked as in
// driveApi.test.ts). These tests check what googleMeetingsApi asks for and how it reads the answers.
const files = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@googleapis/drive', () => ({ drive: vi.fn(() => ({ files })) }));
// The real open, wrapped so one test can hand out a file handle whose close fails.
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return { ...real, open: vi.fn(real.open) };
});

import { drive } from '@googleapis/drive';
import {
  DownloadTooBigError,
  GoogleAccessError,
  GoogleNoAccessError,
  GoogleTransientError,
  googleMeetingsApi,
} from '../../src/meetings/googleApi.ts';
import type { OAuth2Client } from '../../src/output/googleAuth.ts';

const request = vi.fn();
const client = { request } as unknown as OAuth2Client;
const signal = new AbortController().signal;
const api = () => googleMeetingsApi(client);

const conf = (id: string, startTime = '2026-10-23T10:00:00.123456Z', endTime?: string) => ({
  name: `conferenceRecords/${id}`,
  space: `spaces/sp-${id}`,
  startTime,
  ...(endTime ? { endTime } : {}),
  expireTime: '2026-11-22T10:00:00Z',
});

/** A rejection shaped like a GaxiosError: status, numeric code and the response body. Its message echoes the body. */
function gaxiosError(status: number, data?: unknown): Error {
  return Object.assign(new Error(`Request failed: alice@example.com Weekly sync ${JSON.stringify(data ?? '')}`), {
    status,
    code: status,
    response: { status, data },
    config: {},
  });
}
const legacy = (code: number, reason: string) => ({ error: { code, message: 'alice@example.com', errors: [{ domain: 'global', reason, message: 'x' }] } });
const aip = (code: number, status: string, reason: string) => ({
  error: { code, message: 'alice@example.com', status, details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'googleapis.com' }] },
});

let dir: string;
beforeEach(() => {
  request.mockReset();
  files.get.mockReset();
  dir = mkdtempSync(join(tmpdir(), 'wa-meet-api-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('googleMeetingsApi: requests', () => {
  it('builds the Drive client on the given OAuth client', () => {
    api();
    expect(vi.mocked(drive)).toHaveBeenCalledWith(expect.objectContaining({ version: 'v3', auth: client }));
  });

  it('listConferences sends the start_time filter, pageSize 100 and nothing else, then follows the page token', async () => {
    request
      .mockResolvedValueOnce({ data: { conferenceRecords: [conf('a', '2026-10-23T10:00:00.123456Z', '2026-10-23T11:00:00Z')], nextPageToken: 'p2' } })
      .mockResolvedValueOnce({ data: { conferenceRecords: [conf('b')] } });
    const out = await api().listConferences('2026-10-20T00:00:00.000Z', '2026-10-23T12:00:00.000Z', signal);
    expect(out).toEqual([
      { name: 'conferenceRecords/a', space: 'spaces/sp-a', startTime: '2026-10-23T10:00:00.123456Z', endTime: '2026-10-23T11:00:00Z' },
      { name: 'conferenceRecords/b', space: 'spaces/sp-b', startTime: '2026-10-23T10:00:00.123456Z', endTime: null },
    ]);
    expect(request).toHaveBeenCalledTimes(2);
    const filter = 'start_time>="2026-10-20T00:00:00.000Z" AND start_time<"2026-10-23T12:00:00.000Z"';
    expect(request.mock.calls[0]![0]).toEqual({
      url: 'https://meet.googleapis.com/v2/conferenceRecords',
      method: 'GET',
      params: { filter, pageSize: '100' },
      signal,
      timeout: 60_000,
      responseType: 'json',
    });
    expect(request.mock.calls[1]![0]).toEqual(expect.objectContaining({ params: { filter, pageSize: '100', pageToken: 'p2' } }));
  });

  it('listConferences reads an empty answer as no conferences', async () => {
    request.mockResolvedValueOnce({ data: {} });
    expect(await api().listConferences('2026-10-20T00:00:00Z', '2026-10-21T00:00:00Z', signal)).toEqual([]);
  });

  it('paging stops silently after 20 pages', async () => {
    let n = 0;
    request.mockImplementation(async () => ({ data: { conferenceRecords: [conf(`c${++n}`)], nextPageToken: `t${n}` } }));
    const out = await api().listConferences('2026-10-20T00:00:00Z', '2026-10-21T00:00:00Z', signal);
    expect(request).toHaveBeenCalledTimes(20);
    expect(out).toHaveLength(20);
    expect(request.mock.calls[19]![0].params.pageToken).toBe('t19');
  });

  it('paging stops when a page token repeats, so no page comes twice', async () => {
    let n = 0;
    request.mockImplementation(async () => ({ data: { conferenceRecords: [conf(`c${++n}`)], nextPageToken: n === 1 ? 'a' : n === 2 ? 'b' : 'a' } }));
    const out = await api().listConferences('2026-10-20T00:00:00Z', '2026-10-21T00:00:00Z', signal);
    expect(request.mock.calls.map((c) => c[0].params.pageToken)).toEqual([undefined, 'a', 'b']);
    expect(out.map((c) => c.name)).toEqual(['conferenceRecords/c1', 'conferenceRecords/c2', 'conferenceRecords/c3']);
  });

  it('listConferences skips a malformed record and keeps the rest of the page', async () => {
    request.mockResolvedValueOnce({
      data: {
        conferenceRecords: [
          conf('good'),
          { ...conf('dots'), name: 'conferenceRecords/..' },
          { ...conf('sp'), space: 'spaces/.' },
          { name: 'conferenceRecords/nostart', space: 'spaces/x' },
          { ...conf('badtime'), startTime: 'tomorrow' },
          'not an object',
          null,
        ],
      },
    });
    const out = await api().listConferences('2026-10-20T00:00:00Z', '2026-10-21T00:00:00Z', signal);
    expect(out.map((c) => c.name)).toEqual(['conferenceRecords/good']);
  });

  it('refuses times that are not ISO timestamps without calling Google', async () => {
    await expect(api().listConferences('2026-10-20" OR x="', '2026-10-21T00:00:00Z', signal)).rejects.toBeInstanceOf(TypeError);
    await expect(api().findInvite('abc-defg-hij', 'yesterday', signal)).rejects.toBeInstanceOf(TypeError);
    expect(request).not.toHaveBeenCalled();
  });

  it('listRecordings follows pages; only FILE_GENERATED carries a file id; unknown states are skipped', async () => {
    request
      .mockResolvedValueOnce({
        data: {
          recordings: [
            { name: 'conferenceRecords/a/recordings/r1', state: 'FILE_GENERATED', driveDestination: { file: 'file-1', exportUri: 'https://x' }, startTime: '2026-10-23T10:01:00Z', endTime: '2026-10-23T10:59:00Z' },
            { name: 'conferenceRecords/a/recordings/r2', state: 'ENDED', driveDestination: { file: 'file-2' }, startTime: '2026-10-23T11:00:00Z' },
          ],
          nextPageToken: 'n2',
        },
      })
      .mockResolvedValueOnce({
        data: {
          recordings: [
            { name: 'conferenceRecords/a/recordings/r3', state: 'STARTED' },
            { name: 'conferenceRecords/a/recordings/r4', state: 'STATE_UNSPECIFIED' },
            { name: 'conferenceRecords/a/recordings/r5', state: 'SOMETHING_NEW', driveDestination: { file: 'file-5' } },
            { name: 'conferenceRecords/a/recordings/r6', state: 'FILE_GENERATED' },
            { name: 'conferenceRecords/a/recordings/r7', state: 'FILE_GENERATED', driveDestination: { file: '../x' } },
          ],
        },
      });
    const out = await api().listRecordings('conferenceRecords/a', signal);
    expect(out).toEqual([
      { name: 'conferenceRecords/a/recordings/r1', state: 'FILE_GENERATED', driveFileId: 'file-1', startTime: '2026-10-23T10:01:00Z', endTime: '2026-10-23T10:59:00Z' },
      { name: 'conferenceRecords/a/recordings/r2', state: 'ENDED', driveFileId: null, startTime: '2026-10-23T11:00:00Z', endTime: null },
      { name: 'conferenceRecords/a/recordings/r3', state: 'STARTED', driveFileId: null, startTime: null, endTime: null },
      { name: 'conferenceRecords/a/recordings/r6', state: 'FILE_GENERATED', driveFileId: null, startTime: null, endTime: null },
      // A file id without Drive's shape is never used.
      { name: 'conferenceRecords/a/recordings/r7', state: 'FILE_GENERATED', driveFileId: null, startTime: null, endTime: null },
    ]);
    expect(request.mock.calls[0]![0]).toEqual({
      url: 'https://meet.googleapis.com/v2/conferenceRecords/a/recordings',
      method: 'GET',
      params: {},
      signal,
      timeout: 60_000,
      responseType: 'json',
    });
    expect(request.mock.calls[1]![0].params).toEqual({ pageToken: 'n2' });
  });

  it('listSignedInNames keeps signed-in display names only, deduped, empty names dropped', async () => {
    request
      .mockResolvedValueOnce({
        data: {
          participants: [
            { name: 'p1', signedinUser: { user: 'users/1', displayName: 'Asha Rao' } },
            { name: 'p2', anonymousUser: { displayName: 'Guest' } },
            { name: 'p3', phoneUser: { displayName: 'Phone 98' } },
            { name: 'p4', signedinUser: { user: 'users/4', displayName: '  ' } },
          ],
          nextPageToken: 'q2',
          totalSize: 6,
        },
      })
      .mockResolvedValueOnce({ data: { participants: [{ signedinUser: { user: 'users/1', displayName: 'Asha Rao' } }, { signedinUser: { user: 'users/5', displayName: 'Vikram' } }, { signedinUser: { user: 'users/6' } }] } });
    expect(await api().listSignedInNames('conferenceRecords/a', signal)).toEqual(['Asha Rao', 'Vikram']);
    expect(request.mock.calls[0]![0]).toEqual(expect.objectContaining({ url: 'https://meet.googleapis.com/v2/conferenceRecords/a/participants', params: {} }));
    expect(request.mock.calls[1]![0].params).toEqual({ pageToken: 'q2' });
  });

  it('meetingCode reads the space; a missing code is null', async () => {
    request.mockResolvedValueOnce({ data: { name: 'spaces/sp-a', meetingUri: 'https://meet.google.com/abc-defg-hij', meetingCode: 'abc-defg-hij' } });
    request.mockResolvedValueOnce({ data: { name: 'spaces/sp-b' } });
    expect(await api().meetingCode('spaces/sp-a', signal)).toBe('abc-defg-hij');
    expect(await api().meetingCode('spaces/sp-b', signal)).toBeNull();
    expect(request.mock.calls[0]![0]).toEqual({ url: 'https://meet.googleapis.com/v2/spaces/sp-a', method: 'GET', params: {}, signal, timeout: 60_000, responseType: 'json' });
  });

  it('refuses resource names that are not Meet names without calling Google', async () => {
    await expect(api().listRecordings('conferenceRecords/../spaces', signal)).rejects.toBeInstanceOf(TypeError);
    await expect(api().listRecordings('conferenceRecords/..', signal)).rejects.toBeInstanceOf(TypeError);
    await expect(api().listSignedInNames('conferenceRecords/.', signal)).rejects.toBeInstanceOf(TypeError);
    await expect(api().meetingCode('spaces/.', signal)).rejects.toBeInstanceOf(TypeError);
    await expect(api().meetingCode('spaces/..', signal)).rejects.toBeInstanceOf(TypeError);
    await expect(api().listSignedInNames('spaces/x', signal)).rejects.toBeInstanceOf(TypeError);
    await expect(api().meetingCode('conferenceRecords/a', signal)).rejects.toBeInstanceOf(TypeError);
    await expect(api().videoInfo('a/b', signal)).rejects.toBeInstanceOf(TypeError);
    expect(request).not.toHaveBeenCalled();
    expect(files.get).not.toHaveBeenCalled();
  });

  it('findInvite asks the primary calendar for start ± 3 h and matches the conference id; rooms and no-email attendees are dropped', async () => {
    request.mockResolvedValueOnce({
      data: {
        items: [
          { summary: 'Other', conferenceData: { conferenceId: 'zzz-zzzz-zzz' }, attendees: [{ email: 'x@y.com' }] },
          { summary: 'No conference' },
          {
            summary: 'Weekly sync',
            conferenceData: { conferenceId: 'abc-defg-hij', conferenceSolution: { key: { type: 'hangoutsMeet' } } },
            attendees: [
              { email: 'me@team.com', self: true, responseStatus: 'accepted' },
              { email: 'asha@client.com', displayName: 'Asha Rao' },
              { email: 'room-1@resource.calendar.google.com', displayName: 'Room 1', resource: true },
              { displayName: 'No email' },
            ],
          },
          { summary: 'Second match', conferenceData: { conferenceId: 'abc-defg-hij' } },
        ],
      },
    });
    const invite = await api().findInvite('abc-defg-hij', '2026-10-23T10:00:00.000Z', signal);
    expect(invite).toEqual({
      title: 'Weekly sync',
      attendees: [
        { email: 'me@team.com', name: null, self: true },
        { email: 'asha@client.com', name: 'Asha Rao', self: false },
      ],
    });
    expect(request.mock.calls[0]![0]).toEqual({
      url: 'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      method: 'GET',
      params: {
        timeMin: '2026-10-23T07:00:00.000Z',
        timeMax: '2026-10-23T13:00:00.000Z',
        singleEvents: 'true',
        maxResults: '250',
        fields: 'items(summary,start,conferenceData/conferenceId,attendees(email,displayName,self,resource)),nextPageToken',
      },
      signal,
      timeout: 60_000,
      responseType: 'json',
    });
  });

  it('findInvite follows pages (a page can be empty) and picks the match whose start is closest', async () => {
    request
      .mockResolvedValueOnce({ data: { items: [], nextPageToken: 'e2' } })
      .mockResolvedValueOnce({
        data: {
          items: [
            { summary: 'Two hours early', start: { dateTime: '2026-10-23T08:00:00Z' }, conferenceData: { conferenceId: 'abc-defg-hij' } },
            { summary: 'All day', start: { date: '2026-10-23' }, conferenceData: { conferenceId: 'abc-defg-hij' } },
          ],
          nextPageToken: 'e3',
        },
      })
      .mockResolvedValueOnce({
        data: { items: [{ summary: 'Half an hour late', start: { dateTime: '2026-10-23T15:30:00+05:00' }, conferenceData: { conferenceId: 'abc-defg-hij' } }] },
      });
    const invite = await api().findInvite('abc-defg-hij', '2026-10-23T10:00:00Z', signal);
    expect(invite?.title).toBe('Half an hour late');
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[1]![0].params).toMatchObject({ pageToken: 'e2', singleEvents: 'true', maxResults: '250' });
    expect(request.mock.calls[2]![0].params.pageToken).toBe('e3');
  });

  it('findInvite: no matching event is null; an event without summary or attendees gives an empty title and list', async () => {
    request.mockResolvedValueOnce({ data: { items: [{ summary: 'Other', conferenceData: { conferenceId: 'zzz-zzzz-zzz' } }] } });
    expect(await api().findInvite('abc-defg-hij', '2026-10-23T10:00:00Z', signal)).toBeNull();
    request.mockResolvedValueOnce({ data: {} });
    expect(await api().findInvite('abc-defg-hij', '2026-10-23T10:00:00Z', signal)).toBeNull();
    request.mockResolvedValueOnce({ data: { items: [{ conferenceData: { conferenceId: 'abc-defg-hij' } }] } });
    expect(await api().findInvite('abc-defg-hij', '2026-10-23T10:00:00Z', signal)).toEqual({ title: '', attendees: [] });
  });

  it('videoInfo asks Drive for the documented fields and coerces numbers sent as text', async () => {
    files.get.mockResolvedValueOnce({ data: { name: 'Weekly sync (2026-10-23 10:00 GMT+5:30)', size: '123456789', mimeType: 'video/mp4', videoMediaMetadata: { durationMillis: '3600000', width: 1280 } } });
    expect(await api().videoInfo('file-1', signal)).toEqual({ name: 'Weekly sync (2026-10-23 10:00 GMT+5:30)', size: 123456789, mimeType: 'video/mp4', durationMs: 3600000 });
    expect(files.get.mock.calls[0]).toEqual([
      { fileId: 'file-1', fields: 'name,size,mimeType,videoMediaMetadata(durationMillis)', supportsAllDrives: true },
      { signal, timeout: 60_000, retry: false },
    ]);
  });

  it('videoInfo: invalid or missing numbers are null', async () => {
    files.get.mockResolvedValueOnce({ data: { name: 'a.mp4', size: 'abc', mimeType: 'video/mp4', videoMediaMetadata: { durationMillis: '-5' } } });
    expect(await api().videoInfo('file-1', signal)).toEqual({ name: 'a.mp4', size: null, mimeType: 'video/mp4', durationMs: null });
    files.get.mockResolvedValueOnce({ data: { name: 'a.mp4', mimeType: 'video/mp4' } });
    expect(await api().videoInfo('file-1', signal)).toEqual({ name: 'a.mp4', size: null, mimeType: 'video/mp4', durationMs: null });
    files.get.mockResolvedValueOnce({ data: { name: 'a.mp4', size: 42, mimeType: 'video/mp4', videoMediaMetadata: { durationMillis: '1.5' } } });
    expect(await api().videoInfo('file-1', signal)).toEqual({ name: 'a.mp4', size: 42, mimeType: 'video/mp4', durationMs: null });
  });
});

describe('googleMeetingsApi: error mapping', () => {
  type Want = [typeof GoogleAccessError | typeof GoogleNoAccessError | typeof GoogleTransientError, string];
  const A = GoogleAccessError;
  const N = GoogleNoAccessError;
  const T = GoogleTransientError;
  const reasons: [string, Want][] = [
    ['insufficientPermissions', [A, 'http_403_scope']],
    ['ACCESS_TOKEN_SCOPE_INSUFFICIENT', [A, 'http_403_scope']],
    ['rateLimitExceeded', [T, 'http_403_rate']],
    ['userRateLimitExceeded', [T, 'http_403_rate']],
    ['downloadQuotaExceeded', [T, 'http_403_rate']],
    ['quotaExceeded', [T, 'http_403_rate']],
    ['dailyLimitExceeded', [T, 'http_403_rate']],
    ['forbidden', [N, 'http_403']],
    ['appNotAuthorizedToFile', [N, 'http_403']],
    ['cannotDownloadFile', [N, 'http_403']],
    ['somethingElse', [N, 'http_403']],
  ];
  const rows: [string, unknown, Want][] = [
    ['401', gaxiosError(401, { error: { code: 401, status: 'UNAUTHENTICATED', message: 'x' } }), [A, 'http_401']],
    ['invalid_grant', gaxiosError(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }), [A, 'invalid_grant']],
    ...reasons.map(([r, want]): [string, unknown, Want] => [`403 ${r} (errors[] shape)`, gaxiosError(403, legacy(403, r)), want]),
    ...reasons.map(([r, want]): [string, unknown, Want] => [`403 ${r} (details[] shape)`, gaxiosError(403, aip(403, 'PERMISSION_DENIED', r)), want]),
    ['403 reason in a body sent as text', gaxiosError(403, JSON.stringify(legacy(403, 'downloadQuotaExceeded'))), [T, 'http_403_rate']],
    ['403 without a body', gaxiosError(403), [N, 'http_403']],
    ['404', gaxiosError(404, legacy(404, 'notFound')), [N, 'http_404']],
    ['429', gaxiosError(429, aip(429, 'RESOURCE_EXHAUSTED', 'RATE_LIMIT_EXCEEDED')), [T, 'http_429']],
    ['500', gaxiosError(500, legacy(500, 'backendError')), [T, 'http_500']],
    ['503', gaxiosError(503), [T, 'http_503']],
    ['network error', Object.assign(new Error('request to alice@example.com failed'), { code: 'ECONNRESET', config: {} }), [T, 'network']],
    ['timeout', Object.assign(new Error('The operation was aborted due to timeout'), { code: 'TimeoutError', config: {} }), [T, 'timeout']],
  ];

  it.each(rows)('%s through Meet/Calendar', async (_label, rejection, [cls, code]) => {
    request.mockRejectedValueOnce(rejection);
    const e = await api().meetingCode('spaces/sp-a', signal).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(cls);
    expect(e).toMatchObject({ code, name: cls.name });
    expect((e as Error).message).not.toMatch(/alice|Weekly|example/);
  });

  it.each(rows)('%s through Drive', async (_label, rejection, [cls, code]) => {
    files.get.mockRejectedValueOnce(rejection);
    const e = await api().videoInfo('file-1', signal).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(cls);
    expect(e).toMatchObject({ code, name: cls.name });
    expect((e as Error).message).not.toMatch(/alice|Weekly|example/);
  });

  it('a bad answer is transient bad_answer', async () => {
    request.mockResolvedValueOnce({ data: { conferenceRecords: 'nope' } });
    await expect(api().listConferences('2026-10-20T00:00:00Z', '2026-10-21T00:00:00Z', signal)).rejects.toMatchObject({ name: 'GoogleTransientError', code: 'bad_answer' });
    request.mockResolvedValueOnce({ data: '<html>' });
    await expect(api().meetingCode('spaces/sp-a', signal)).rejects.toMatchObject({ code: 'bad_answer' });
    request.mockResolvedValueOnce({ data: { items: [{ attendees: 'x' }] } });
    await expect(api().findInvite('abc-defg-hij', '2026-10-23T10:00:00Z', signal)).rejects.toBeInstanceOf(GoogleTransientError);
    files.get.mockResolvedValueOnce({ data: { size: '5' } });
    await expect(api().videoInfo('file-1', signal)).rejects.toMatchObject({ code: 'bad_answer' });
  });

  it('a stop through the signal rethrows the abort, not a transient error', async () => {
    const stop = new AbortController();
    const reason = new Error('stopping');
    request.mockImplementationOnce(async () => {
      stop.abort(reason);
      throw Object.assign(new Error('The operation was aborted'), { code: 'AbortError', config: {} });
    });
    await expect(api().listRecordings('conferenceRecords/a', stop.signal)).rejects.toBe(reason);
    // Already stopped: nothing is asked.
    await expect(api().listConferences('2026-10-20T00:00:00Z', '2026-10-21T00:00:00Z', stop.signal)).rejects.toBe(reason);
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('googleMeetingsApi: download', () => {
  const streamOf = (...chunks: (Buffer | string)[]) => ({ data: Readable.from(chunks) });

  it('sends alt=media as a stream with the 30-minute limit, writes the bytes, fsyncs and returns the count', async () => {
    const probe = await open(join(dir, 'probe'), 'w');
    const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
    await probe.close();
    const sync = vi.spyOn(proto, 'sync');
    files.get.mockResolvedValueOnce(streamOf(Buffer.from('hello '), 'world'));
    const dest = join(dir, 'm.mp4.part');
    expect(await api().download('file-1', dest, 11, signal)).toBe(11);
    expect(readFileSync(dest, 'utf8')).toBe('hello world');
    expect(files.get.mock.calls[0]).toEqual([
      { fileId: 'file-1', alt: 'media', supportsAllDrives: true },
      { responseType: 'stream', signal, timeout: 1_800_000, retry: false },
    ]);
    expect(sync).toHaveBeenCalledTimes(1);
    // Closed: Windows cannot remove a file that is still open.
    rmSync(dest);
    expect(existsSync(dest)).toBe(false);
  });

  it('a file of exactly maxBytes is kept', async () => {
    files.get.mockResolvedValueOnce(streamOf(Buffer.alloc(5, 1), Buffer.alloc(5, 2)));
    const dest = join(dir, 'exact.mp4.part');
    expect(await api().download('file-1', dest, 10, signal)).toBe(10);
    expect(readFileSync(dest)).toEqual(Buffer.concat([Buffer.alloc(5, 1), Buffer.alloc(5, 2)]));
  });

  it('a file over maxBytes is DownloadTooBigError and leaves no file', async () => {
    files.get.mockResolvedValueOnce(streamOf(Buffer.alloc(6), Buffer.alloc(6)));
    const dest = join(dir, 'big.mp4.part');
    const e = await api().download('file-1', dest, 10, signal).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DownloadTooBigError);
    expect(e).toMatchObject({ code: 'too_big', name: 'DownloadTooBigError' });
    expect(existsSync(dest)).toBe(false);
  });

  it('an abort in the middle of the stream leaves no file and the abort propagates', async () => {
    const stop = new AbortController();
    const reason = new Error('stopping');
    let reads = 0;
    const body = new Readable({
      read() {
        if (reads++ === 0) this.push(Buffer.from('first part'));
        else stop.abort(reason); // never ends by itself
      },
    });
    files.get.mockResolvedValueOnce({ data: body });
    const dest = join(dir, 'abort.mp4.part');
    await expect(api().download('file-1', dest, 1000, stop.signal)).rejects.toBe(reason);
    expect(existsSync(dest)).toBe(false);
  });

  it('a stream error in the middle is transient and leaves no file', async () => {
    let reads = 0;
    const body = new Readable({
      read() {
        if (reads++ === 0) this.push(Buffer.from('first part'));
        else this.destroy(Object.assign(new Error('terminated'), { code: 'ECONNRESET' }));
      },
    });
    files.get.mockResolvedValueOnce({ data: body });
    const dest = join(dir, 'reset.mp4.part');
    await expect(api().download('file-1', dest, 1000, signal)).rejects.toMatchObject({ name: 'GoogleTransientError', code: 'network' });
    expect(existsSync(dest)).toBe(false);
  });

  it('a refused download is mapped, from a body sent as text, and leaves no file', async () => {
    files.get.mockRejectedValueOnce(gaxiosError(403, JSON.stringify(legacy(403, 'cannotDownloadFile'))));
    const dest = join(dir, 'refused.mp4.part');
    await expect(api().download('file-1', dest, 1000, signal)).rejects.toBeInstanceOf(GoogleNoAccessError);
    expect(existsSync(dest)).toBe(false);
    files.get.mockResolvedValueOnce({ data: { not: 'a stream' } });
    await expect(api().download('file-1', dest, 1000, signal)).rejects.toMatchObject({ code: 'bad_answer' });
    expect(existsSync(dest)).toBe(false);
  });

  it('a byte limit that is not a whole non-negative number is a TypeError, before any file or request', async () => {
    const dest = join(dir, 'limit.mp4.part');
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      await expect(api().download('file-1', dest, bad, signal)).rejects.toBeInstanceOf(TypeError);
    }
    expect(existsSync(dest)).toBe(false);
    expect(files.get).not.toHaveBeenCalled();
  });

  it('a timeout while the body is read (an abort not from the caller) is transient timeout and leaves no file', async () => {
    for (const name of ['AbortError', 'TimeoutError']) {
      let reads = 0;
      const body = new Readable({
        read() {
          if (reads++ === 0) this.push(Buffer.from('first part'));
          else this.destroy(new DOMException('This operation was aborted', name));
        },
      });
      files.get.mockResolvedValueOnce({ data: body });
      const dest = join(dir, `${name}.mp4.part`);
      await expect(api().download('file-1', dest, 1000, signal)).rejects.toMatchObject({ name: 'GoogleTransientError', code: 'timeout' });
      expect(existsSync(dest)).toBe(false);
    }
  });

  it('a failing fsync gives the raw disk error back and leaves no file', async () => {
    const probe = await open(join(dir, 'probe'), 'w');
    const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
    await probe.close();
    const diskError = Object.assign(new Error('i/o error'), { code: 'EIO', syscall: 'fsync' });
    vi.spyOn(proto, 'sync').mockRejectedValueOnce(diskError);
    files.get.mockResolvedValueOnce(streamOf('video'));
    const dest = join(dir, 'sync.mp4.part');
    await expect(api().download('file-1', dest, 1000, signal)).rejects.toBe(diskError);
    expect(existsSync(dest)).toBe(false);
  });

  it('a failing close gives the raw disk error back and leaves no file', async () => {
    const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const diskError = Object.assign(new Error('i/o error'), { code: 'EIO', syscall: 'close' });
    vi.mocked(open).mockImplementationOnce(async (path, flags, mode) => {
      const fh = await real.open(path, flags, mode);
      const close = fh.close.bind(fh);
      fh.close = async () => {
        await close(); // the handle is released, as an OS close that reports an error still releases it
        throw diskError;
      };
      return fh;
    });
    files.get.mockResolvedValueOnce(streamOf('video'));
    const dest = join(dir, 'close.mp4.part');
    await expect(api().download('file-1', dest, 1000, signal)).rejects.toBe(diskError);
    expect(existsSync(dest)).toBe(false);
  });

  it('an existing dest is an error, is left untouched, and nothing is downloaded', async () => {
    const dest = join(dir, 'kept.mp4.part');
    writeFileSync(dest, 'old bytes');
    await expect(api().download('file-1', dest, 1000, signal)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(readFileSync(dest, 'utf8')).toBe('old bytes');
    expect(files.get).not.toHaveBeenCalled();
  });
});
