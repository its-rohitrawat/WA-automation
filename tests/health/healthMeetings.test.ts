import { describe, expect, it } from 'vitest';
import { Health, readHealthSnapshot, type MediaHealth, type MeetingsHealth } from '../../src/health/health.ts';
import { SpendGuard } from '../../src/spend/spendGuard.ts';
import { setKv } from '../../src/store/kv.ts';
import type { MeetingStats } from '../../src/store/meetings.ts';
import { manualClock } from '../../src/util/clock.ts';
import { seededDb } from '../helpers/db.ts';

function setup(freeBytes: () => number | null = () => 200e9) {
  const db = seededDb();
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
const media = (o: Partial<MediaHealth> = {}): MediaHealth => ({ pending: 0, stale: 0, spendCap: 0, failedRecent: 0, uploadFailed: 0, sttRefused: 0, ...o });

const SCOPES = '⚠️ Meetings paused: Google sign-in needs meeting access. Run: npm run cli -- google-auth';
const FFMPEG = '⚠️ Meetings paused: ffmpeg not found';
const STT_NONE = '⚠️ Meetings waiting: speech-to-text is not set up';
const STT_REFUSED = '⚠️ Meetings waiting: the speech-to-text key was refused';
const GREEN = '✅ Connected · waiting for new messages';

describe('Health and meetings', () => {
  it('shows no meeting line while meetings are off (null), whatever the counts were', () => {
    const { h } = setup();
    h.setMeetings(meetings({ paused: 'google_scopes' }));
    h.setMeetings(null);
    expect(h.line()).toEqual({ ok: true, text: GREEN });
    expect(h.snapshot().meetings).toBeUndefined();
  });

  it('is green when meetings are on and nothing is wrong', () => {
    const { h } = setup();
    h.setMeetings(meetings({}, { done: 4, waiting: 1, unassigned: 2 }));
    expect(h.line()).toEqual({ ok: true, text: GREEN });
  });

  it.each([
    ['google_scopes', SCOPES],
    ['google_auth', SCOPES],
    ['no_ffmpeg', FFMPEG],
  ] as const)('paused %s has its own line', (paused, text) => {
    const { h } = setup();
    h.setMeetings(meetings({ paused }));
    expect(h.line()).toEqual({ ok: false, text });
    expect(h.workbookLine()).toEqual({ ok: false, text });
  });

  it('counts meetings that could not be processed', () => {
    const { h } = setup();
    h.setMeetings(meetings({}, { failed: 1 }));
    expect(h.line()).toEqual({ ok: false, text: '⚠️ 1 meeting could not be processed' });
    h.setMeetings(meetings({}, { failed: 3 }));
    expect(h.line().text).toBe('⚠️ 3 meetings could not be processed');
  });

  it('says speech-to-text is not set up only while meetings wait', () => {
    const { h } = setup();
    h.setMeetings(meetings({ sttProvider: 'none' }));
    expect(h.line().text).toBe(GREEN);
    h.setMeetings(meetings({ sttProvider: 'none' }, { waiting: 2 }));
    expect(h.line()).toEqual({ ok: false, text: STT_NONE });
    h.setMeetings(meetings({ sttProvider: 'openai' }, { waiting: 2 }));
    expect(h.line().text).toBe(GREEN);
  });

  it('says the speech-to-text key was refused when meetings are deferred stt_unavailable', () => {
    const { h } = setup();
    h.setMeetings(meetings({}, { waiting: 1, deferred: { spend_cap: 1 } }));
    expect(h.line().text).toBe(GREEN);
    h.setMeetings(meetings({}, { waiting: 1, deferred: { stt_unavailable: 1 } }));
    expect(h.line()).toEqual({ ok: false, text: STT_REFUSED });
  });

  it('orders the meeting lines: paused (scopes, then ffmpeg), failed, speech not set up, key refused', () => {
    const { h } = setup();
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

  it('comes after every older warning, media lines included, and before low disk', () => {
    const { h } = setup(() => 5e9);
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

  it('with the morning report (Phase 2c): after the media lines, its warning first, then the meeting lines, then low disk', () => {
    const { db, h } = setup(() => 5e9);
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
    h.persist();
    const read = readHealthSnapshot(db)!;
    expect(read.meetings).toEqual(meetings({ paused: 'google_scopes' }));
    expect(read.report).toEqual(report);
    setKv(db, 'health', JSON.stringify({ ...read, meetings: { ...meetings(), paused: 'some_new_reason' } }));
    const again = readHealthSnapshot(db)!;
    expect(again.meetings).toBeUndefined();
    expect(again.report).toEqual(report);
  });

  it('keeps the meetings in the snapshot and reads them back', () => {
    const { db, h } = setup();
    const m = meetings({ paused: 'no_ffmpeg', sttProvider: 'none' }, { done: 4, waiting: 1, unassigned: 2, deferred: { stt_none: 1 } });
    h.setMeetings(m);
    h.persist();
    expect(readHealthSnapshot(db)!.meetings).toEqual(m);
    // A later change to the object given does not change what Health stored.
    m.stats.deferred.stt_none = 9;
    expect(h.snapshot().meetings!.stats.deferred).toEqual({ stt_none: 1 });
  });

  it('still reads an older snapshot without meetings, and refuses a malformed one', () => {
    const { db, h } = setup();
    h.setMeetings(meetings());
    const snap = JSON.parse(JSON.stringify(h.snapshot())) as Record<string, unknown>;
    const { meetings: _m, ...old } = snap;
    setKv(db, 'health', JSON.stringify(old));
    expect(readHealthSnapshot(db)).toBeDefined();
    expect(readHealthSnapshot(db)!.meetings).toBeUndefined();
    const bad: unknown[] = [
      null,
      { ...meetings(), stats: { ...stats(), done: '1' } },
      { ...meetings(), stats: { ...stats(), deferred: { stt_none: 'x' } } },
      { ...meetings(), stats: { ...stats(), deferred: null } },
      { paused: null, sttProvider: 'none' },
    ];
    for (const m of bad) {
      setKv(db, 'health', JSON.stringify({ ...old, meetings: m }));
      expect(readHealthSnapshot(db)).toBeUndefined();
    }
  });

  it('drops only the meetings when their pause reason or provider is unknown', () => {
    const { db, h } = setup();
    h.setMeetings(meetings());
    const snap = JSON.parse(JSON.stringify(h.snapshot())) as Record<string, unknown>;
    for (const m of [{ ...meetings(), paused: 'other' }, { ...meetings(), sttProvider: 'whisper' }]) {
      setKv(db, 'health', JSON.stringify({ ...snap, meetings: m }));
      const read = readHealthSnapshot(db);
      expect(read).toBeDefined();
      expect(read!.meetings).toBeUndefined();
      expect('meetings' in read!).toBe(false);
      expect(read!.line).toEqual(h.snapshot().line);
    }
  });

  it('splits spend today into AI and speech in the snapshot', () => {
    const { db, h, spend } = setup();
    spend.record('ai', 0.25, 'test');
    spend.record('stt', 0.1, 'test');
    spend.record('ai', 0.05, 'test');
    expect(h.snapshot().spendByKind).toEqual({ ai: 0.3, stt: 0.1 });
    h.persist();
    expect(readHealthSnapshot(db)!.spendByKind).toEqual({ ai: 0.3, stt: 0.1 });
    const { spendByKind: _s, ...old } = JSON.parse(JSON.stringify(h.snapshot())) as Record<string, unknown>;
    setKv(db, 'health', JSON.stringify(old));
    expect(readHealthSnapshot(db)!.spendByKind).toBeUndefined();
    setKv(db, 'health', JSON.stringify({ ...old, spendByKind: { ai: 1 } }));
    expect(readHealthSnapshot(db)).toBeUndefined();
  });
});
