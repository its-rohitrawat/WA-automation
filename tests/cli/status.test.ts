import { describe, expect, it } from 'vitest';
import { formatStatus } from '../../src/cli/status.ts';
import type { HealthSnapshot } from '../../src/health/health.ts';
import { listClients } from '../../src/store/clients.ts';
import { seededDb } from '../helpers/db.ts';

const snapshot: HealthSnapshot = {
  at: '2026-10-19T07:58:00.000Z',
  line: { ok: true, text: '✅ Connected · last update 19 Oct 13:25' },
  whatsapp: { state: 'open', since: '2026-10-19T03:30:00.000Z', lastErrorCode: null, credsSaveFailures: 0 },
  downSince: null, failed: [], lastSuccessAt: null, lastPublishedAt: null, spentToday: 1.234, capUsd: 15, freeGb: 182.43,
  publishFailingSince: null, ingestFailures: 0,
};

const now = new Date('2026-10-19T08:00:00Z');
const base = { clients: [], batches: [], unprocessed: new Map<number, number>(), now };

describe('formatStatus', () => {
  it('summarises health, spend, disk and each client', () => {
    const out = formatStatus({
      snapshot,
      clients: listClients(seededDb(), false),
      batches: [{ clientId: 2, status: 'failed', errorCode: 'network', finishedAt: '2026-10-19T07:50:00.000Z' }],
      unprocessed: new Map([[2, 3]]),
      now,
    });
    expect(out).toContain('Health:      ✅ Connected · last update 19 Oct 13:25 (reported 2 min ago)');
    expect(out).toContain('WhatsApp:    open since 19 Oct 09:00');
    expect(out).toContain('Spend today: $1.23 of $15.00');
    expect(out).toContain('Disk free:   182.4 GB');
    expect(out).not.toContain('Drive:');
    expect(out).not.toContain('has not reported');
    expect(out).toMatch(/MEH\s+Mehta Foods\s+queued 3\s+last batch failed \(network\)/);
    expect(out).toMatch(/SHA\s+Sharma Interiors\s+queued 0\s+no batches yet/);
  });

  it('shows the speech-to-text copies that could not be deleted, on a status line of their own, even with no report', () => {
    expect(formatStatus({ ...base, snapshot })).not.toContain('Speech copies');
    expect(formatStatus({ ...base, snapshot, sttCopiesLeft: 0 })).not.toContain('Speech copies');
    const one = formatStatus({ ...base, snapshot, sttCopiesLeft: 1 });
    expect(one).toContain('Speech copies: 1 speech-to-text copy could not be deleted from the provider; see SETUP (Meeting summaries)');
    expect(one).toContain('Health:      ✅ Connected · last update 19 Oct 13:25'); // the health line is unchanged
    expect(formatStatus({ ...base, snapshot: undefined, sttCopiesLeft: 3 })).toContain('Speech copies: 3 speech-to-text copies could not be deleted');
  });

  it('says when the service has not reported yet', () => {
    const out = formatStatus({ ...base, snapshot: undefined });
    expect(out).toContain('no report yet (is the service running?)');
  });

  it('prints a Drive row when publishing is failing', () => {
    const out = formatStatus({ ...base, snapshot: { ...snapshot, publishFailingSince: '2026-10-19T06:30:00.000Z' } });
    expect(out).toContain('Drive:       failing since 19 Oct 12:00');
  });

  it('prints how many incoming messages were not saved, only when there are some', () => {
    expect(formatStatus({ ...base, snapshot })).not.toContain('Messages not saved');
    const out = formatStatus({ ...base, snapshot: { ...snapshot, ingestFailures: 2 } });
    expect(out).toContain('Messages not saved: 2 (see wa-agent.out.log)');
  });

  it('puts a stale-report line first when the report is more than 2 minutes old', () => {
    const out = formatStatus({ ...base, snapshot: { ...snapshot, at: '2026-10-19T07:57:00.000Z' } });
    const lines = out.split('\n');
    expect(lines[0]).toBe('⚠️ The service has not reported since 19 Oct 13:27. Is it running?');
    expect(lines[1]).toContain('WA Agent status');
  });

  it('does not flag a report exactly 2 minutes old', () => {
    const out = formatStatus({ ...base, snapshot: { ...snapshot, at: '2026-10-19T07:58:00.000Z' } });
    expect(out).not.toContain('has not reported');
  });

  it('does not flag a 1 minute old report', () => {
    const out = formatStatus({ ...base, snapshot: { ...snapshot, at: '2026-10-19T07:59:00.000Z' } });
    expect(out).not.toContain('has not reported');
  });

  it('labels stale data as last known and shows the age in minutes, hours, days', () => {
    const at = (ms: number) => new Date(now.getTime() - ms).toISOString();
    const out10 = formatStatus({ ...base, snapshot: { ...snapshot, at: at(10 * 60_000) } });
    expect(out10).toContain('last known: open since');
    expect(out10).toContain('last known: $1.23 of $15.00');
    expect(out10).toContain('reported 10 min ago');
    expect(formatStatus({ ...base, snapshot: { ...snapshot, at: at(120 * 60_000) } })).toContain('reported 120 min ago');
    expect(formatStatus({ ...base, snapshot: { ...snapshot, at: at(121 * 60_000) } })).toContain('reported 2 hours ago');
    expect(formatStatus({ ...base, snapshot: { ...snapshot, at: at(48 * 3_600_000) } })).toContain('reported 48 hours ago');
    expect(formatStatus({ ...base, snapshot: { ...snapshot, at: at(73 * 3_600_000) } })).toContain('reported 3 days ago');
  });

  it('does not say last known for fresh data', () => {
    expect(formatStatus({ ...base, snapshot })).not.toContain('last known');
  });

  it('prints the shared-file counts when the service reports them', () => {
    const out = formatStatus({ ...base, snapshot: { ...snapshot, media: { pending: 2, stale: 0, spendCap: 0, failedRecent: 1, uploadFailed: 0, sttRefused: 0 } } });
    expect(out).toContain('Files:       2 waiting to be read · 1 could not be read (24 h) · 0 not uploaded to Drive');
    expect(formatStatus({ ...base, snapshot })).not.toContain('Files:');
  });

  it('adds the voice notes waiting for a refused speech key to the Files line, only when there are some (Phase 2b)', () => {
    const files = { pending: 3, stale: 0, spendCap: 0, failedRecent: 1, uploadFailed: 0 };
    const three = formatStatus({ ...base, snapshot: { ...snapshot, media: { ...files, sttRefused: 2 } } });
    expect(three).toMatch(/^Files: {7}3 waiting to be read · 1 could not be read \(24 h\) · 0 not uploaded to Drive · including 2 voice notes waiting \(speech key refused\)$/m);
    expect(formatStatus({ ...base, snapshot: { ...snapshot, media: { ...files, sttRefused: 1 } } })).toContain(' · including 1 voice note waiting (speech key refused)');
    const none = /^Files: {7}3 waiting to be read · 1 could not be read \(24 h\) · 0 not uploaded to Drive$/m;
    expect(formatStatus({ ...base, snapshot: { ...snapshot, media: { ...files, sttRefused: 0 } } })).toMatch(none);
    // A snapshot written before Phase 2b has no sttRefused.
    expect(formatStatus({ ...base, snapshot: { ...snapshot, media: files } })).toMatch(none);
  });

  it('shows the voice-note copies that could not be deleted, on a status line of their own, even with no report (Phase 2b)', () => {
    expect(formatStatus({ ...base, snapshot })).not.toContain('Voice copies');
    expect(formatStatus({ ...base, snapshot, voiceCopiesLeft: 0 })).not.toContain('Voice copies');
    const one = formatStatus({ ...base, snapshot, voiceCopiesLeft: 1 });
    expect(one).toContain('Voice copies: 1 speech-to-text copy of voice notes could not be deleted from the provider; see SETUP (Voice notes)');
    expect(one).toContain('Health:      ✅ Connected · last update 19 Oct 13:25'); // the health line is unchanged
    expect(one).not.toContain('Speech copies');
    expect(formatStatus({ ...base, snapshot: undefined, voiceCopiesLeft: 3 })).toContain(
      'Voice copies: 3 speech-to-text copies of voice notes could not be deleted from the provider; see SETUP (Voice notes)',
    );
    // Next to the meetings' line, after it.
    const both = formatStatus({ ...base, snapshot, sttCopiesLeft: 2, voiceCopiesLeft: 4 }).split('\n');
    const speech = both.findIndex((l) => l.startsWith('Speech copies: 2 '));
    expect(speech).toBeGreaterThan(-1);
    expect(both[speech + 1]).toBe('Voice copies: 4 speech-to-text copies of voice notes could not be deleted from the provider; see SETUP (Voice notes)');
  });
});

describe('formatStatus meetings and spend split', () => {
  const stats = { done: 4, waiting: 1, unassigned: 2, failed: 0, noAccess: 0, tooLong: 0, internal: 3, deferred: {} };

  it('prints a meetings line when the snapshot has meetings, and none otherwise', () => {
    expect(formatStatus({ ...base, snapshot })).not.toContain('Meetings:');
    const out = formatStatus({ ...base, snapshot: { ...snapshot, meetings: { stats, paused: null, sttProvider: 'sarvam' } } });
    expect(out).toContain('Meetings:    4 done, 1 waiting, 2 unassigned, 0 failed');
    expect(out).not.toContain('no access');
  });

  it('adds no-access and too-long counts only when there are some', () => {
    const out = formatStatus({ ...base, snapshot: { ...snapshot, meetings: { stats: { ...stats, noAccess: 1, tooLong: 2 }, paused: null, sttProvider: 'none' } } });
    expect(out).toContain('Meetings:    4 done, 1 waiting, 2 unassigned, 0 failed, 1 no access, 2 too long');
  });

  it('splits spend today into AI and speech only when the snapshot has the split, and meetings or speech spend', () => {
    const split = { ai: 1.0, stt: 0.234 };
    const out = formatStatus({ ...base, snapshot: { ...snapshot, spendByKind: split, meetings: { stats, paused: null, sttProvider: 'sarvam' } } });
    expect(out).toContain('Spend today: $1.23 of $15.00 (AI $1.00, speech $0.23)');
    // Without meetings and with no speech spend (Phase 2b shows the split once voice notes cost speech spend).
    expect(formatStatus({ ...base, snapshot: { ...snapshot, spendByKind: { ...split, stt: 0 } } })).toMatch(/Spend today: \$1\.23 of \$15\.00$/m);
    expect(formatStatus({ ...base, snapshot: { ...snapshot, meetings: { stats, paused: null, sttProvider: 'sarvam' } } })).toMatch(
      /Spend today: \$1\.23 of \$15\.00$/m,
    );
  });

  it('splits spend today without meetings once speech-to-text has cost something (voice notes, Phase 2b)', () => {
    expect(formatStatus({ ...base, snapshot: { ...snapshot, spendByKind: { ai: 1.0, stt: 0.234 } } })).toContain(
      'Spend today: $1.23 of $15.00 (AI $1.00, speech $0.23)',
    );
    // Nothing spent on speech and no meetings: no split, as before.
    expect(formatStatus({ ...base, snapshot: { ...snapshot, spendByKind: { ai: 1.234, stt: 0 } } })).toMatch(/Spend today: \$1\.23 of \$15\.00$/m);
    // With meetings the split shows even at 0 speech, as before.
    const meetings = { stats, paused: null, sttProvider: 'sarvam' as const };
    expect(formatStatus({ ...base, snapshot: { ...snapshot, spendByKind: { ai: 1.234, stt: 0 }, meetings } })).toContain(
      'Spend today: $1.23 of $15.00 (AI $1.23, speech $0.00)',
    );
  });
});
