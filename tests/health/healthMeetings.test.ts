import { describe, expect, it } from 'vitest';
import { Health, MEETING_STT_PROBLEM_LINES, readHealthSnapshot, VOICE_PROBLEM_LINES, type MediaHealth, type MeetingsHealth } from '../../src/health/health.ts';
import { SpendGuard } from '../../src/spend/spendGuard.ts';
import { setKv } from '../../src/store/kv.ts';
import type { MeetingStats } from '../../src/store/meetings.ts';
import { manualClock } from '../../src/util/clock.ts';
import { seededDb } from '../helpers/db.ts';

async function setup(freeBytes: () => number | null = () => 200e9) {
  const db = await seededDb();
  const clock = manualClock('2026-10-19T08:00:00Z');
  const spend = new SpendGuard({ db, clock, capUsd: 1 });
  const h = new Health({ db, clock, spend, freeBytes });
  h.setWhatsApp({ state: 'open', since: '2026-10-19T08:00:00.000Z', lastErrorCode: null, credsSaveFailures: 0 });
  return { db, h, spend };
}
const stats = (o: Partial<MeetingStats> = {}): MeetingStats => ({
  done: 0, waiting: 0, unassigned: 0, failed: 0, noAccess: 0, tooLong: 0, internal: 0, deferred: {}, ...o,
});
const meetings = (o: Partial<MeetingsHealth> = {}, s: Partial<MeetingStats> = {}): MeetingsHealth => ({
  stats: stats(s), paused: null, sttProvider: 'sarvam', ...o,
});
const media = (o: Partial<MediaHealth> = {}): MediaHealth => ({ pending: 0, stale: 0, spendCap: 0, failedRecent: 0, uploadFailed: 0, sttRefused: 0, voiceFailed: 0, ...o });

const SCOPES = '⚠️ Meetings paused: Google sign-in needs meeting access. Run: npm run cli -- google-auth';
const FFMPEG = '⚠️ Meetings paused: ffmpeg not found';
const STT_NONE = '⚠️ Meetings waiting: speech-to-text is not set up';
const STT_REFUSED = '⚠️ Meetings waiting: the speech-to-text key was refused';
const GREEN = '✅ Connected · waiting for new messages';

describe('Health and meetings', () => {
  it('shows no meeting line while meetings are off (null), whatever the counts were', async () => {
    const { h } = await setup();
    h.setMeetings(meetings({ paused: 'google_scopes' }));
    h.setMeetings(null);
    expect(h.line()).toEqual({ ok: true, text: GREEN });
    expect(h.snapshot().meetings).toBeUndefined();
  });

  it('is green when meetings are on and nothing is wrong', async () => {
    const { h } = await setup();
    h.setMeetings(meetings({}, { done: 4, waiting: 1, unassigned: 2 }));
    expect(h.line()).toEqual({ ok: true, text: GREEN });
  });

  it.each([
    ['google_scopes', SCOPES],
    ['google_auth', SCOPES],
    ['no_ffmpeg', FFMPEG],
  ] as const)('paused %s has its own line', async (paused, text) => {
    const { h } = await setup();
    h.setMeetings(meetings({ paused }));
    expect(h.line()).toEqual({ ok: false, text });
    expect(h.workbookLine()).toEqual({ ok: false, text });
  });

  it('names extra Google accounts whose sign-in was refused, below the pauses and above failed meetings', async () => {
    const { h } = await setup();
    h.setMeetings(meetings({ lostAccounts: ['company2', 'company3'] }, { failed: 1 }));
    expect(h.line()).toEqual({
      ok: false,
      text: '⚠️ Meetings: Google sign-in lost for company2, company3. Run: npm run cli -- google-auth --account company2',
    });
    h.setMeetings(meetings({ paused: 'no_ffmpeg', lostAccounts: ['company2'] }));
    expect(h.line().text).toBe(FFMPEG);
    h.setMeetings(meetings({ lostAccounts: [] }));
    expect(h.line().text).toBe(GREEN);
  });

  it('counts meetings that could not be processed', async () => {
    const { h } = await setup();
    h.setMeetings(meetings({}, { failed: 1 }));
    expect(h.line()).toEqual({ ok: false, text: '⚠️ 1 meeting could not be processed' });
    h.setMeetings(meetings({}, { failed: 3 }));
    expect(h.line().text).toBe('⚠️ 3 meetings could not be processed');
  });

  it('says speech-to-text is not set up only while meetings wait', async () => {
    const { h } = await setup();
    h.setMeetings(meetings({ sttProvider: 'none' }));
    expect(h.line().text).toBe(GREEN);
    h.setMeetings(meetings({ sttProvider: 'none' }, { waiting: 2 }));
    expect(h.line()).toEqual({ ok: false, text: STT_NONE });
    h.setMeetings(meetings({ sttProvider: 'openai' }, { waiting: 2 }));
    expect(h.line().text).toBe(GREEN);
  });

  it('STT_PROVIDER=local (Task 3): working, the provider is local and no line shows, whatever waits', async () => {
    const { h } = await setup();
    h.setMeetings(meetings({ sttProvider: 'local' }, { waiting: 3 }));
    expect(h.line()).toEqual({ ok: true, text: GREEN });
  });

  it.each([
    ['local_not_set_up_bin', '⚠️ Meetings waiting: the local speech engine is not set up (STT_LOCAL_BIN)'],
    ['local_not_set_up_model', '⚠️ Meetings waiting: the local speech engine is not set up (STT_LOCAL_MODEL)'],
  ] as const)('the local engine not set up (%s): its own line, naming the setting as the voice-note line does', async (problem, text) => {
    const { h } = await setup();
    expect(MEETING_STT_PROBLEM_LINES[problem]).toBe(text);
    // The same problem, worded as the voice notes' line.
    expect(text.replace('Meetings waiting', '')).toBe(VOICE_PROBLEM_LINES[problem].replace('Voice notes are not being transcribed', ''));
    h.setMeetings(meetings({ sttProvider: 'local', sttProblem: problem }));
    expect(h.line()).toEqual({ ok: false, text });
    expect(h.workbookLine()).toEqual({ ok: false, text });
    // Below the pauses, above everything else about meetings.
    h.setMeetings(meetings({ sttProvider: 'local', sttProblem: problem, paused: 'no_ffmpeg' }));
    expect(h.line().text).toBe(FFMPEG);
    h.setMeetings(meetings({ sttProvider: 'local', sttProblem: problem, lostAccounts: ['company2'] }, { failed: 1, waiting: 1 }));
    expect(h.line().text).toBe(text);
  });

  it('keeps sttProvider local and the problem in the snapshot, and drops only the meetings for an unknown problem', async () => {
    const { db, h } = await setup();
    const m = meetings({ sttProvider: 'local', sttProblem: 'local_not_set_up_bin' }, { waiting: 1, deferred: { stt_none: 1 } });
    h.setMeetings(m);
    await h.persist();
    expect((await readHealthSnapshot(db))!.meetings).toEqual(m);
    h.setMeetings(meetings({ sttProvider: 'local' }));
    await h.persist();
    expect((await readHealthSnapshot(db))!.meetings).toEqual(meetings({ sttProvider: 'local' }));
    const snap = JSON.parse(JSON.stringify(h.snapshot())) as Record<string, unknown>;
    await setKv(db, 'health', JSON.stringify({ ...snap, meetings: { ...meetings({ sttProvider: 'local' }), sttProblem: 'local_broken' } }));
    const read = await readHealthSnapshot(db);
    expect(read).toBeDefined();
    expect('meetings' in read!).toBe(false);
  });

  it('says the speech-to-text key was refused when meetings are deferred stt_unavailable', async () => {
    const { h } = await setup();
    h.setMeetings(meetings({}, { waiting: 1, deferred: { spend_cap: 1 } }));
    expect(h.line().text).toBe(GREEN);
    h.setMeetings(meetings({}, { waiting: 1, deferred: { stt_unavailable: 1 } }));
    expect(h.line()).toEqual({ ok: false, text: STT_REFUSED });
  });

  it('orders the meeting lines: paused (scopes, then ffmpeg), failed, speech not set up, key refused', async () => {
    const { h } = await setup();
    const all = { failed: 1, waiting: 1, deferred: { stt_unavailable: 1 } };
    h.setMeetings(meetings({ paused: 'google_auth', sttProvider: 'none' }, all));
    expect(h.line().text).toBe(SCOPES);
    h.setMeetings(meetings({ paused: 'no_ffmpeg', sttProvider: 'none' }, all));
    expect(h.line().text).toBe(FFMPEG);
    h.setMeetings(meetings({ sttProvider: 'none' }, all));
    expect(h.line().text).toBe('⚠️ 1 meeting could not be processed');
    h.setMeetings(meetings({ sttProvider: 'none' }, { ...all, failed: 0 }));
    expect(h.line().text).toBe(STT_NONE);
    h.setMeetings(meetings({}, { ...all, failed: 0 }));
    expect(h.line().text).toBe(STT_REFUSED);
  });

  it('comes after every older warning, media lines included, and before low disk', async () => {
    const { h } = await setup(() => 5e9);
    h.setMeetings(meetings({ paused: 'google_scopes' }));
    expect(h.line().text).toBe(SCOPES); // outranks low disk
    h.setMedia(media({ spendCap: 1 }));
    expect(h.line().text).toBe("⚠️ 1 shared file waiting for today's AI budget (read after midnight IST)");
    h.setMedia(media({ uploadFailed: 1 }));
    expect(h.line().text).toBe('⚠️ 1 file could not be uploaded to Drive. See docs/SETUP.md.');
    h.setMedia(media({ stale: 1 }));
    expect(h.line().text).toBe('⚠️ 1 shared file waiting over 30 minutes to be read. See docs/SETUP.md.');
    h.setIngestFailures(1);
    expect(h.line().text).toBe('⚠️ 1 incoming message could not be saved. See docs/SETUP.md.');
    h.recordOutcome(1, { status: 'failed', errorCode: 'refusal' });
    expect(h.line().text).toBe('⚠️ 1 group waiting (AI error)');
    h.recordOutcome(1, { status: 'paused' });
    expect(h.line().text).toBe('⚠️ Daily spend cap reached. Paused until midnight IST');
    // Without the meeting line the older order is unchanged.
    h.setMeetings(null);
    h.recordOutcome(1, { status: 'noop' });
    h.setIngestFailures(0);
    h.setMedia(media());
    expect(h.line().text).toBe('⚠️ Low disk: 5.0 GB free');
  });

  it('with the morning report (Phase 2c): after the media lines, its warning first, then the meeting lines, then low disk', async () => {
    const { db, h } = await setup(() => 5e9);
    const report = { text: 'Morning report: unknown, check WhatsApp', warning: '⚠️ Morning report: unknown, check WhatsApp.' };
    h.setMeetings(meetings({ paused: 'google_scopes' }));
    h.setReport(report);
    expect(h.line().text).toBe(report.warning);
    h.setMedia(media({ spendCap: 1 }));
    expect(h.line().text).toBe("⚠️ 1 shared file waiting for today's AI budget (read after midnight IST)");
    h.setMedia(media());
    h.setReport({ text: 'Morning report: sent at 06:00 IST', warning: null });
    expect(h.line().text).toBe(SCOPES);
    h.setMeetings(null);
    expect(h.line().text).toBe('⚠️ Low disk: 5.0 GB free');
    // Both live side by side in the snapshot; a meeting state this version does not know drops only the meetings.
    h.setMeetings(meetings({ paused: 'google_scopes' }));
    h.setReport(report);
    await h.persist();
    const read = (await readHealthSnapshot(db))!;
    expect(read.meetings).toEqual(meetings({ paused: 'google_scopes' }));
    expect(read.report).toEqual(report);
    await setKv(db, 'health', JSON.stringify({ ...read, meetings: { ...meetings(), paused: 'some_new_reason' } }));
    const again = (await readHealthSnapshot(db))!;
    expect(again.meetings).toBeUndefined();
    expect(again.report).toEqual(report);
  });

  it('keeps the meetings in the snapshot and reads them back', async () => {
    const { db, h } = await setup();
    const m = meetings({ paused: 'no_ffmpeg', sttProvider: 'none' }, { done: 4, waiting: 1, unassigned: 2, deferred: { stt_none: 1 } });
    h.setMeetings(m);
    await h.persist();
    expect((await readHealthSnapshot(db))!.meetings).toEqual(m);
    // A later change to the object given does not change what Health stored.
    m.stats.deferred.stt_none = 9;
    expect(h.snapshot().meetings!.stats.deferred).toEqual({ stt_none: 1 });
  });

  it('still reads an older snapshot without meetings, and refuses a malformed one', async () => {
    const { db, h } = await setup();
    h.setMeetings(meetings());
    const snap = JSON.parse(JSON.stringify(h.snapshot())) as Record<string, unknown>;
    const { meetings: _m, ...old } = snap;
    await setKv(db, 'health', JSON.stringify(old));
    expect(await readHealthSnapshot(db)).toBeDefined();
    expect((await readHealthSnapshot(db))!.meetings).toBeUndefined();
    const bad: unknown[] = [
      null,
      { ...meetings(), stats: { ...stats(), done: '1' } },
      { ...meetings(), stats: { ...stats(), deferred: { stt_none: 'x' } } },
      { ...meetings(), stats: { ...stats(), deferred: null } },
      { paused: null, sttProvider: 'none' },
    ];
    for (const m of bad) {
      await setKv(db, 'health', JSON.stringify({ ...old, meetings: m }));
      expect(await readHealthSnapshot(db)).toBeUndefined();
    }
  });

  it('drops only the meetings when their pause reason or provider is unknown', async () => {
    const { db, h } = await setup();
    h.setMeetings(meetings());
    const snap = JSON.parse(JSON.stringify(h.snapshot())) as Record<string, unknown>;
    for (const m of [{ ...meetings(), paused: 'other' }, { ...meetings(), sttProvider: 'whisper' }]) {
      await setKv(db, 'health', JSON.stringify({ ...snap, meetings: m }));
      const read = await readHealthSnapshot(db);
      expect(read).toBeDefined();
      expect(read!.meetings).toBeUndefined();
      expect('meetings' in read!).toBe(false);
      expect(read!.line).toEqual(h.snapshot().line);
    }
  });

  it('splits spend today into AI and speech in the snapshot', async () => {
    const { db, h, spend } = await setup();
    spend.record('ai', 0.25, 'test');
    spend.record('stt', 0.1, 'test');
    spend.record('ai', 0.05, 'test');
    expect(h.snapshot().spendByKind).toEqual({ ai: 0.3, stt: 0.1 });
    await h.persist();
    expect((await readHealthSnapshot(db))!.spendByKind).toEqual({ ai: 0.3, stt: 0.1 });
    const { spendByKind: _s, ...old } = JSON.parse(JSON.stringify(h.snapshot())) as Record<string, unknown>;
    await setKv(db, 'health', JSON.stringify(old));
    expect((await readHealthSnapshot(db))!.spendByKind).toBeUndefined();
    await setKv(db, 'health', JSON.stringify({ ...old, spendByKind: { ai: 1 } }));
    expect(await readHealthSnapshot(db)).toBeUndefined();
  });
});
