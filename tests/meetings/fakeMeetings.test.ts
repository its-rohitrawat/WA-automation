import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DownloadTooBigError, GoogleNoAccessError, GoogleTransientError } from '../../src/meetings/googleErrors.ts';
import { FakeMeetingsApi } from '../helpers/fakeMeetings.ts';

const signal = new AbortController().signal;
const info = { name: 'Weekly sync.mp4', size: 5, mimeType: 'video/mp4', durationMs: 60_000 };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wa-fake-meet-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('FakeMeetingsApi', () => {
  it('download writes the bytes and returns the count; an existing dest is an error and left untouched', async () => {
    const fake = new FakeMeetingsApi();
    fake.files.set('f1', { info, bytes: Buffer.from('video') });
    const dest = join(dir, 'a.mp4.part');
    expect(await fake.download('f1', dest, 5, signal)).toBe(5);
    expect(readFileSync(dest, 'utf8')).toBe('video');
    const kept = join(dir, 'kept.mp4.part');
    writeFileSync(kept, 'old');
    await expect(fake.download('f1', kept, 5, signal)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(readFileSync(kept, 'utf8')).toBe('old');
  });

  it('download leaves no file when too big, missing, or stopped while it hangs', async () => {
    const fake = new FakeMeetingsApi();
    fake.files.set('f1', { info, bytes: Buffer.from('video') });
    const dest = join(dir, 'b.mp4.part');
    await expect(fake.download('f1', dest, 4, signal)).rejects.toBeInstanceOf(DownloadTooBigError);
    expect(existsSync(dest)).toBe(false);
    await expect(fake.download('gone', dest, 100, signal)).rejects.toBeInstanceOf(GoogleNoAccessError);
    expect(existsSync(dest)).toBe(false);

    fake.gate = new Promise<void>(() => undefined); // never opens
    const stop = new AbortController();
    const reason = new Error('stopping');
    const pending = fake.download('f1', dest, 100, stop.signal);
    await vi.waitFor(() => expect(existsSync(dest)).toBe(true)); // in progress
    stop.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(existsSync(dest)).toBe(false);
  });

  it('failNextWith fails one call; failWith fails every call of its method only; every call is logged', async () => {
    const fake = new FakeMeetingsApi();
    fake.codes.set('spaces/a', 'abc-defg-hij');
    const boom = new GoogleTransientError('http_500');
    fake.failNextWith = boom;
    await expect(fake.meetingCode('spaces/a', signal)).rejects.toBe(boom);
    expect(await fake.meetingCode('spaces/a', signal)).toBe('abc-defg-hij');

    const refused = new GoogleNoAccessError('http_403');
    fake.failWith.set('videoInfo', refused);
    await expect(fake.videoInfo('f1', signal)).rejects.toBe(refused);
    await expect(fake.videoInfo('f1', signal)).rejects.toBe(refused);
    expect(await fake.meetingCode('spaces/b', signal)).toBeNull();
    fake.failWith.delete('videoInfo');
    await expect(fake.videoInfo('f1', signal)).rejects.toMatchObject({ code: 'http_404' });

    expect(fake.calls.map((c) => c.method)).toEqual(['meetingCode', 'meetingCode', 'videoInfo', 'videoInfo', 'meetingCode', 'videoInfo']);
    expect(fake.callsOf('meetingCode')).toEqual([['spaces/a'], ['spaces/a'], ['spaces/b']]);
  });

  it('gate holds calls until opened; a stopped signal throws its reason', async () => {
    const fake = new FakeMeetingsApi();
    fake.conferences = [
      { name: 'conferenceRecords/a', space: 'spaces/a', startTime: '2026-10-23T10:00:00Z', endTime: null },
      { name: 'conferenceRecords/b', space: 'spaces/b', startTime: '2026-10-23T12:00:00Z', endTime: null },
    ];
    let openGate!: () => void;
    fake.gate = new Promise<void>((r) => (openGate = r));
    let done = false;
    const pending = fake.listConferences('2026-10-23T09:00:00Z', '2026-10-23T12:00:00Z', signal).then((v) => ((done = true), v));
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    await new Promise((r) => setImmediate(r)); // every pending callback has run; the gate is still shut
    expect(done).toBe(false);
    openGate();
    // [from, to): the conference starting exactly at `to` is left out.
    expect((await pending).map((c) => c.name)).toEqual(['conferenceRecords/a']);

    const stop = new AbortController();
    const reason = new Error('stopping');
    stop.abort(reason);
    await expect(fake.listRecordings('conferenceRecords/a', stop.signal)).rejects.toBe(reason);
  });

  it('runs the same input checks as the real client, before logging the call', async () => {
    const fake = new FakeMeetingsApi();
    fake.files.set('f1', { info, bytes: Buffer.from('video') });
    await expect(fake.listConferences('yesterday', '2026-10-23T12:00:00Z', signal)).rejects.toBeInstanceOf(TypeError);
    await expect(fake.listRecordings('conferenceRecords/..', signal)).rejects.toBeInstanceOf(TypeError);
    await expect(fake.listSignedInNames('spaces/a', signal)).rejects.toBeInstanceOf(TypeError);
    await expect(fake.meetingCode('spaces/.', signal)).rejects.toBeInstanceOf(TypeError);
    await expect(fake.findInvite('abc-defg-hij', 'soon', signal)).rejects.toBeInstanceOf(TypeError);
    await expect(fake.videoInfo('a/b', signal)).rejects.toBeInstanceOf(TypeError);
    await expect(fake.download('f1', join(dir, 'x.part'), -1, signal)).rejects.toBeInstanceOf(TypeError);
    await expect(fake.download('f1', join(dir, 'x.part'), 1.5, signal)).rejects.toBeInstanceOf(TypeError);
    expect(fake.calls).toEqual([]);
    expect(existsSync(join(dir, 'x.part'))).toBe(false);
  });
});
