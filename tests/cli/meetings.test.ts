import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CorrectionError } from '../../src/cli/corrections.ts';
import {
  assignMeetingToClient, meetingAiCeilingUsd, meetingBackfillCommand, meetingCheckCommand, meetingListLines, retryLine, retryMeetingById, skipMeetingById,
  defaultMeetingDeps, speechCeilingFromEnv, storedGoogleApi, type MeetingCliDeps,
} from '../../src/cli/meetings.ts';
import { parseEnv } from '../../src/config/env.ts';
import { trackerDbPath } from '../../src/config/paths.ts';
import { StaticKeyProvider } from '../../src/crypto/keyProvider.ts';
import { GoogleAccessError } from '../../src/meetings/googleErrors.ts';
import { DRIVE_SCOPES, MEETING_SCOPES, saveGrantedScopes, TokenStore } from '../../src/output/googleAuth.ts';
import { FALLBACK_PRICES } from '../../src/spend/pricing.ts';
import { syncClients } from '../../src/store/clients.ts';
import { openDb, type Db } from '../../src/store/db.ts';
import { getKv } from '../../src/store/kv.ts';
import { getMeeting, insertFound, type MeetingStatus, type NewMeeting } from '../../src/store/meetings.ts';
import { manualClock } from '../../src/util/clock.ts';
import { acquireLock } from '../../src/util/lock.ts';
import { FakeMeetingsApi } from '../helpers/fakeMeetings.ts';

const KEY = Buffer.alloc(32, 7);
const NOW = '2026-10-23T06:00:00.000Z';
const HOUR = 3_600_000;
const ago = (hours: number): string => new Date(Date.parse(NOW) - hours * HOUR).toISOString();
const SHARMA = { groupId: '120363000000000011@g.us', name: 'Sharma Interiors', code: 'SHA', emailDomains: ['sharma.example'] };
const MEHTA = { groupId: '120363000000000012@g.us', name: 'Mehta Foods', code: 'MEH', emailDomains: ['mehtafoods.example'] };
const PHASES = ['Discovery', 'Design', 'Development', 'Review', 'Launch'];

let dir: string;
let dataDir: string;
let groupsFile: string;
let lines: string[];
let api: FakeMeetingsApi;
let db: Db;

function env(over: Record<string, string> = {}) {
  return parseEnv({ DATA_DIR: dataDir, GROUPS_FILE: groupsFile, MEETINGS_ENABLED: 'true', TEAM_EMAIL_DOMAINS: 'studio.example', ...over });
}

function deps(over: Partial<MeetingCliDeps> = {}): MeetingCliDeps {
  return {
    env: env(),
    keyProvider: new StaticKeyProvider(KEY),
    out: (l) => void lines.push(l),
    clock: manualClock(NOW),
    googleApi: () => api,
    speechCeilingUsd: null,
    ...over,
  };
}

let seq = 0;
async function meeting(status: MeetingStatus, o: Partial<NewMeeting> = {}): Promise<number> {
  seq++;
  // An internal row keeps ids, the start and the status only (the table's CHECK).
  const internal: Partial<NewMeeting> = status === 'internal' ? { title: '', clientId: null, matchKind: null } : {};
  return (await insertFound(db, {
    recording: `conferenceRecords/x${seq}/recordings/r1`, conference: `conferenceRecords/x${seq}`, driveFileId: `file${seq}`, meetingCode: null,
    title: `Sharma weekly ${seq}`, startedAt: ago(48 - seq), endedAt: null, attendees: [], participants: [], clientId: 1, matchKind: 'title',
    status, driveSeconds: 2700, createdAt: NOW, ...o, ...internal,
  }))!;
}

/** One conference with an invite (null: none) and one recording whose file exists unless fileMissing. */
function conference(id: string, o: { start: string; attendees?: string[] | null; title?: string; fileMissing?: boolean; durationMs?: number | null }): void {
  const name = `conferenceRecords/${id}`;
  api.conferences.push({ name, space: `spaces/${id}`, startTime: o.start, endTime: new Date(Date.parse(o.start) + HOUR).toISOString() });
  api.recordings.set(name, [{ name: `${name}/recordings/r1`, state: 'FILE_GENERATED', driveFileId: `file${id}`, startTime: o.start, endTime: null }]);
  api.codes.set(`spaces/${id}`, `code-${id}`);
  if (o.attendees !== null) {
    api.invites.set(`code-${id}`, {
      title: o.title ?? 'Weekly call',
      attendees: [{ email: 'owner@studio.example', name: 'Owner', self: true }, ...(o.attendees ?? []).map((email) => ({ email, name: null, self: false }))],
    });
  }
  if (!o.fileMissing) {
    api.files.set(`file${id}`, {
      info: { name: 'Recording.mp4', size: 1000, mimeType: 'video/mp4', durationMs: o.durationMs === undefined ? 60 * 60_000 : o.durationMs },
      bytes: Buffer.alloc(0),
    });
  }
}

/** Every table's rows, to prove a command wrote nothing. */
function dump(d: Db): string {
  const tables = (d.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
  return JSON.stringify(tables.map((t) => [t, d.raw.prepare(`SELECT * FROM "${t}"`).all()]));
}

const rows = async () => {
  const out = [];
  for (const r of db.raw.prepare('SELECT id FROM meetings ORDER BY id').all() as { id: number }[]) out.push((await getMeeting(db, r.id))!);
  return out;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wa-meet-cli-'));
  dataDir = join(dir, 'data');
  mkdirSync(dataDir);
  groupsFile = join(dir, 'groups.json');
  writeFileSync(groupsFile, JSON.stringify({ clients: [SHARMA, MEHTA] }));
  lines = [];
  api = new FakeMeetingsApi();
  db = openDb(trackerDbPath(dataDir));
  syncClients(db, [{ ...SHARMA, phases: PHASES, meetingKeywords: [] }, { ...MEHTA, phases: PHASES, meetingKeywords: [] }]);
  saveGrantedScopes(db, [...DRIVE_SCOPES, ...MEETING_SCOPES].join(' '));
  seq = 0;
});

afterEach(() => {
  db.raw.close();
  rmSync(dir, { recursive: true, force: true });
});

const now = new Date(NOW);
const events = () => db.raw.prepare("SELECT client_id AS clientId, op, detail FROM task_events WHERE op = 'assign_meeting'").all();

describe('meeting list', () => {
  it('shows the meetings that need the owner by default, newest first, with date, client, status and title', async () => {
    const q = await meeting('queued');
    const u = await meeting('unassigned', { clientId: null, matchKind: null });
    await meeting('done');
    await meeting('skipped', { clientId: null, matchKind: null });
    const i = await meeting('internal', { clientId: null, matchKind: null, title: '' });
    const n = await meeting('no_access', { errorCode: 'http_404' });
    const out = await meetingListLines(db, false);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatch(new RegExp(`^\\s+${n}  2026-10-21 \\d\\d:\\d\\d  SHA\\s+no access \\(http_404\\)\\s+Sharma weekly 6$`));
    expect(out[1]).toMatch(new RegExp(`^\\s+${u}  .*unassigned\\s+unassigned\\s+Sharma weekly 2$`));
    expect(out[2]).toMatch(new RegExp(`^\\s+${q}  .*SHA\\s+queued\\s+Sharma weekly 1$`));
    expect(out.join('\n')).not.toContain(`${i} `);
  });

  it('--all adds done, skipped, too long and internal; internal shows no title', async () => {
    await meeting('done');
    await meeting('skipped', { clientId: null, matchKind: null });
    await meeting('too_long');
    const i = await meeting('internal');
    const out = await meetingListLines(db, true);
    expect(out).toHaveLength(4);
    const internal = out.find((l) => l.trimStart().startsWith(`${i} `))!;
    expect(internal).toMatch(/internal\s+internal$/);
    expect(out.join('\n')).not.toContain('should never show');
    expect(out.join('\n')).toContain('too long');
  });

  it('labels a no-access meeting by how it was found: internal (no title) or unassigned', async () => {
    const i = await meeting('no_access', { clientId: null, matchKind: null, title: '', errorCode: 'http_404', foundInternal: true });
    const u = await meeting('no_access', { clientId: null, matchKind: null, errorCode: 'http_403' });
    const out = await meetingListLines(db, false);
    expect(out.find((l) => l.trimStart().startsWith(`${i} `))).toMatch(/internal\s+no access \(http_404\)$/);
    expect(out.find((l) => l.trimStart().startsWith(`${u} `))).toMatch(/unassigned\s+no access \(http_403\)\s+Sharma weekly 2$/);
  });

  it('says when nothing needs the owner', async () => {
    expect(await meetingListLines(db, false)).toEqual(['No meetings need you. (npm run cli -- meeting list --all shows every meeting.)']);
    expect(await meetingListLines(db, true)).toEqual(['No meetings yet.']);
  });
});

describe('meeting assign', () => {
  it('queues an unassigned meeting for the client, match kind human, and requests a rebuild', async () => {
    const id = await meeting('unassigned', { clientId: null, matchKind: null });
    expect(await assignMeetingToClient(db, String(id), 'meh', now)).toEqual({ id, code: 'MEH' });
    expect(await getMeeting(db, id)).toMatchObject({ status: 'queued', clientId: 2, matchKind: 'human' });
    expect(getKv(db, 'rebuild_requested')).toBe(NOW);
    expect(events()).toEqual([{ clientId: 2, op: 'assign_meeting', detail: JSON.stringify({ meetingId: id }) }]);
  });

  it('queues an internal meeting too', async () => {
    const id = await meeting('internal', { clientId: null, matchKind: null, title: '' });
    await assignMeetingToClient(db, String(id), 'SHA', now);
    expect(await getMeeting(db, id)).toMatchObject({ status: 'queued', clientId: 1, matchKind: 'human' });
  });

  it('queues a no-access meeting without a client (found as internal or unassigned), with fresh attempts', async () => {
    const i = await meeting('no_access', { clientId: null, matchKind: null, title: '', errorCode: 'http_404', foundInternal: true });
    const u = await meeting('no_access', { clientId: null, matchKind: null, errorCode: 'http_403' });
    db.raw.prepare('UPDATE meetings SET attempts = 2 WHERE id = ?').run(u);
    expect(await assignMeetingToClient(db, String(i), 'SHA', now)).toEqual({ id: i, code: 'SHA' });
    expect(await assignMeetingToClient(db, String(u), 'MEH', now)).toEqual({ id: u, code: 'MEH' });
    expect(await getMeeting(db, i)).toMatchObject({ status: 'queued', clientId: 1, matchKind: 'human', errorCode: null, attempts: 0, note: null });
    expect(await getMeeting(db, u)).toMatchObject({ status: 'queued', clientId: 2, matchKind: 'human', errorCode: null, attempts: 0 });
  });

  it.each(['queued', 'done', 'skipped', 'too_long', 'no_access', 'failed'] as const)('refuses a %s meeting and changes nothing', async (status) => {
    const id = await meeting(status);
    const before = dump(db);
    await expect(assignMeetingToClient(db, String(id), 'MEH', now)).rejects.toThrow(/only unassigned or internal meetings can be assigned/);
    expect(dump(db)).toBe(before);
  });

  it('refuses an unknown client code, an inactive client, an unknown id and a bad id', async () => {
    const id = await meeting('unassigned', { clientId: null, matchKind: null });
    const before = dump(db);
    await expect(assignMeetingToClient(db, String(id), 'XYZ', now)).rejects.toThrow('No client with code XYZ');
    syncClients(db, [{ ...SHARMA, phases: PHASES, meetingKeywords: [] }]);
    const synced = dump(db);
    await expect(assignMeetingToClient(db, String(id), 'MEH', now)).rejects.toThrow('Client MEH is not in the allow-list');
    await expect(assignMeetingToClient(db, '999', 'SHA', now)).rejects.toThrow('No meeting 999');
    await expect(assignMeetingToClient(db, '1x', 'SHA', now)).rejects.toThrow(CorrectionError);
    await expect(assignMeetingToClient(db, '0', 'SHA', now)).rejects.toThrow(/meeting id is a number/);
    expect(dump(db)).toBe(synced);
    expect(before).not.toBe(synced); // only the sync above changed anything
  });
});

describe('meeting skip and retry', () => {
  it('skips an unassigned meeting and refuses every other status', async () => {
    const id = await meeting('unassigned', { clientId: null, matchKind: null });
    expect(await skipMeetingById(db, String(id), now)).toBe(id);
    expect((await getMeeting(db, id))!.status).toBe('skipped');
    expect(getKv(db, 'rebuild_requested')).toBe(NOW);
    for (const s of ['internal', 'queued', 'done', 'skipped', 'too_long', 'no_access', 'failed'] as const) {
      const other = await meeting(s);
      await expect(skipMeetingById(db, String(other), now)).rejects.toThrow(/only unassigned meetings can be skipped/);
      expect((await getMeeting(db, other))!.status).toBe(s);
    }
    await expect(skipMeetingById(db, '42', now)).rejects.toThrow('No meeting 42');
  });

  it('retries a failed or no-access meeting and refuses every other status', async () => {
    const f = await meeting('failed', { errorCode: 'x' });
    const n = await meeting('no_access', { errorCode: 'http_404' });
    expect(await retryMeetingById(db, String(f), now)).toEqual({ id: f, status: 'queued' });
    expect(await retryMeetingById(db, String(n), now)).toEqual({ id: n, status: 'queued' });
    expect(retryLine({ id: f, status: 'queued' })).toBe(`Meeting ${f} queued again.`);
    expect(await getMeeting(db, f)).toMatchObject({ status: 'queued', attempts: 0, errorCode: null });
    expect((await getMeeting(db, n))!.status).toBe('queued');
    // The workbook lists only unassigned and done meetings, so a retry asks for no rebuild.
    expect(getKv(db, 'rebuild_requested')).toBeUndefined();
    for (const s of ['unassigned', 'internal', 'queued', 'done', 'skipped', 'too_long'] as const) {
      const other = await meeting(s);
      await expect(retryMeetingById(db, String(other), now)).rejects.toThrow(/only failed or no-access meetings can be retried/);
      expect((await getMeeting(db, other))!.status).toBe(s);
    }
  });
});

describe('meeting retry of a meeting without a client', () => {
  it('puts a no-access meeting found as internal or unassigned back to unassigned, asks for a rebuild and says to assign it', async () => {
    const i = await meeting('no_access', { clientId: null, matchKind: null, title: '', errorCode: 'http_404', foundInternal: true });
    const u = await meeting('no_access', { clientId: null, matchKind: null, errorCode: 'http_403' });
    const r = await retryMeetingById(db, String(i), now);
    expect(r).toEqual({ id: i, status: 'unassigned' });
    expect(await retryMeetingById(db, String(u), now)).toEqual({ id: u, status: 'unassigned' });
    expect(await getMeeting(db, i)).toMatchObject({ status: 'unassigned', clientId: null, errorCode: null, attempts: 0, note: null, title: '' });
    expect(await getMeeting(db, u)).toMatchObject({ status: 'unassigned', clientId: null, errorCode: null });
    expect(getKv(db, 'rebuild_requested')).toBe(NOW); // the workbook lists unassigned meetings
    expect(retryLine(r)).toBe(
      `Meeting ${i} has no client, so it cannot be processed; it is unassigned again. Assign it to a client with: npm run cli -- meeting assign ${i} <CODE>`,
    );
    // Then it can be assigned, and is processed for that client.
    await assignMeetingToClient(db, String(i), 'SHA', now);
    expect(await getMeeting(db, i)).toMatchObject({ status: 'queued', clientId: 1 });
  });

  it('a failed meeting without a client goes back to unassigned too, never to queued', async () => {
    const f = await meeting('failed', { clientId: null, matchKind: null, errorCode: 'no_client' });
    expect(await retryMeetingById(db, String(f), now)).toEqual({ id: f, status: 'unassigned' });
    expect(await getMeeting(db, f)).toMatchObject({ status: 'unassigned', errorCode: null });
  });
});

describe('meeting backfill', () => {
  beforeEach(() => {
    conference('a', { start: '2026-10-05T05:00:00.000Z', attendees: ['ravi@sharma.example'] }); // Sharma by domain, 60 min
    conference('b', { start: '2026-10-06T05:00:00.000Z', attendees: ['dev@studio.example'] }); // internal
    conference('c', { start: '2026-10-07T05:00:00.000Z', attendees: null, durationMs: null }); // unassigned
    conference('d', { start: '2026-10-08T05:00:00.000Z', attendees: ['a@mehtafoods.example'], durationMs: null }); // Mehta, no length
  });

  it('without --yes prints the count, hours and cost ceiling and changes nothing', async () => {
    db.raw.close();
    db = openDb(trackerDbPath(dataDir));
    const before = dump(db);
    await meetingBackfillCommand({ since: '2026-10-01', yes: false }, deps());
    expect(dump(db)).toBe(before);
    expect(api.callsOf('download')).toEqual([]);
    expect(api.callsOf('listConferences')).toEqual([['2026-09-30T18:30:00.000Z', NOW]]);
    const ai = meetingAiCeilingUsd(3600, { inputPerMTok: 4, outputPerMTok: 20, cacheWritePerMTok: 5, cacheReadPerMTok: 0.2 }) +
      meetingAiCeilingUsd(180 * 60, { inputPerMTok: 4, outputPerMTok: 20, cacheWritePerMTok: 5, cacheReadPerMTok: 0.2 });
    expect(lines).toEqual([
      'Found 4 recordings from 2026-10-01 (IST) not stored before.',
      '  2 for a client, 1 unassigned, 1 internal, 0 no access, 0 too long',
      'To be processed: 2 meetings, about 4.0 hours (1 without a length from Drive, counted at 180 minutes)',
      `Cost ceiling: AI up to $${ai.toFixed(2)}; speech: speech-to-text not set up (they wait until STT_PROVIDER is set)`,
      'Spending counts toward the daily cap ($15.00), so a large backfill may take several days.',
      'Unassigned and internal meetings cost nothing unless you assign them.',
      'Nothing was changed. Re-run with --yes to store them.',
    ]);
  });

  it('adds the speech ceiling when a provider is set', async () => {
    await meetingBackfillCommand({ since: '2026-10-01', yes: false }, deps({ speechCeilingUsd: (s) => s / 3600 }));
    expect(lines.find((l) => l.startsWith('Cost ceiling'))).toMatch(/^Cost ceiling: up to \$\d+\.\d\d \(AI \$\d+\.\d\d, speech \$4\.00\)$/);
  });

  it('with --yes stores the rows and requests a rebuild', async () => {
    await meetingBackfillCommand({ since: '2026-10-01', yes: true }, deps());
    expect((await rows()).map((r) => [r.status, r.clientId])).toEqual([['queued', 1], ['internal', null], ['unassigned', null], ['queued', 2]]);
    expect(getKv(db, 'rebuild_requested')).toBe(NOW);
    expect(api.callsOf('download')).toEqual([]);
    expect(lines[0]).toBe('Stored 4 recordings from 2026-10-01 (IST) not stored before.');
    lines = [];
    await meetingBackfillCommand({ since: '2026-10-01', yes: false }, deps());
    expect(lines).toEqual(['Found 0 recordings from 2026-10-01 (IST) not stored before; 4 already stored.', 'Nothing was changed.']);
  });

  it('needs MEETINGS_ENABLED, meeting scopes, a good date and the lock', async () => {
    await expect(meetingBackfillCommand({ since: '2026-10-01', yes: true }, deps({ env: env({ MEETINGS_ENABLED: 'false' }) }))).rejects.toThrow(
      /Meetings are switched off/,
    );
    await expect(meetingBackfillCommand({ since: '2026-13-01', yes: true }, deps())).rejects.toThrow('--since must be YYYY-MM-DD');
    await expect(meetingBackfillCommand({ since: '2026-10-24', yes: true }, deps())).rejects.toThrow('--since must be in the past');
    saveGrantedScopes(db, DRIVE_SCOPES.join(' '));
    await expect(meetingBackfillCommand({ since: '2026-10-01', yes: true }, deps())).rejects.toThrow(
      'Google sign-in needs meeting access. Run: npm run cli -- google-auth',
    );
    saveGrantedScopes(db, [...DRIVE_SCOPES, ...MEETING_SCOPES].join(' '));
    const lock = await acquireLock(dataDir);
    try {
      await expect(meetingBackfillCommand({ since: '2026-10-01', yes: true }, deps())).rejects.toThrow(/Another WA Agent process/);
    } finally {
      await lock.release();
    }
    expect(api.calls).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  it('matches a client newly added to the groups file in the preview and in --yes; the preview stores nothing', async () => {
    const GUPTA = { groupId: '120363000000000013@g.us', name: 'Gupta Traders', code: 'GUP', emailDomains: ['gupta.example'] };
    writeFileSync(groupsFile, JSON.stringify({ clients: [SHARMA, MEHTA, GUPTA] }));
    conference('e', { start: '2026-10-09T05:00:00.000Z', attendees: ['x@gupta.example'] });
    const before = dump(db);
    await meetingBackfillCommand({ since: '2026-10-01', yes: false }, deps());
    expect(dump(db)).toBe(before);
    expect(lines[1]).toBe('  3 for a client, 1 unassigned, 1 internal, 0 no access, 0 too long');
    lines = [];
    await meetingBackfillCommand({ since: '2026-10-01', yes: true }, deps());
    expect(lines[1]).toBe('  3 for a client, 1 unassigned, 1 internal, 0 no access, 0 too long');
    const gupta = db.raw.prepare("SELECT id FROM clients WHERE code = 'GUP'").get() as { id: number };
    expect((await rows()).at(-1)).toMatchObject({ status: 'queued', clientId: gupta.id, matchKind: 'domain' });
  });

  it('works with STT_PROVIDER set, using its list price and no provider', async () => {
    const e = env({ STT_PROVIDER: 'openai', STT_API_KEY: 'test-stt-key' });
    const { speechCeilingUsd: _s, ...noSpeech } = deps({ env: e });
    await meetingBackfillCommand({ since: '2026-10-01', yes: false }, noSpeech);
    // 1 hour and 3 hours (no length) at $0.36 an hour.
    expect(lines.find((l) => l.startsWith('Cost ceiling'))).toMatch(/speech \$1\.44\)$/);
  });

  it('passes a Google sign-in failure on and stores nothing', async () => {
    api.failWith.set('listConferences', new GoogleAccessError('invalid_grant'));
    await expect(meetingBackfillCommand({ since: '2026-10-01', yes: true }, deps())).rejects.toThrow(/Run: npm run cli -- google-auth/);
    expect(await rows()).toEqual([]);
  });
});

describe('meeting check', () => {
  it('lists the last 7 days with the match and whether each file opens, downloading and storing nothing', async () => {
    conference('a', { start: ago(30), attendees: ['ravi@sharma.example'] });
    conference('b', { start: ago(26), attendees: ['dev@studio.example'], fileMissing: true });
    conference('c', { start: ago(20), attendees: null, durationMs: 200 * 60_000 });
    conference('old', { start: ago(8 * 24), attendees: ['ravi@sharma.example'] });
    const before = dump(db);
    await meetingCheckCommand(deps());
    expect(dump(db)).toBe(before);
    expect(api.callsOf('download')).toEqual([]);
    expect(api.callsOf('listConferences')).toEqual([[ago(7 * 24), NOW]]);
    expect(lines).toEqual([
      'Recordings in the last 7 days not stored yet: 3',
      '  22 Oct 05:30  SHA        file opens  60 min',
      '  22 Oct 09:30  internal   no access',
      '  22 Oct 15:30  unassigned file opens (too long)  200 min',
      'Nothing was downloaded or stored.',
    ]);
  });

  it('notes clients in the groups file that are not stored yet, and matches them as unassigned', async () => {
    const GUPTA = { groupId: '120363000000000013@g.us', name: 'Gupta Traders', code: 'GUP', emailDomains: ['gupta.example'] };
    writeFileSync(groupsFile, JSON.stringify({ clients: [SHARMA, MEHTA, GUPTA] }));
    conference('e', { start: ago(10), attendees: ['x@gupta.example'] });
    const before = dump(db);
    await meetingCheckCommand(deps());
    expect(dump(db)).toBe(before);
    expect(lines[0]).toBe('1 client in the groups file is not stored yet; their meetings show as unassigned until the service restarts.');
    expect(lines[2]).toMatch(/unassigned file opens/);
  });

  it('builds no speech provider: the default deps carry no speech price, which only backfill reads from the env', async () => {
    const d = defaultMeetingDeps(env({ STT_PROVIDER: 'openai', STT_API_KEY: 'test-stt-key' }), new StaticKeyProvider(KEY), manualClock(NOW));
    expect(d).not.toHaveProperty('speechCeilingUsd');
    await meetingCheckCommand({ ...d, googleApi: () => api, out: (l) => void lines.push(l) });
    expect(lines.at(-1)).toBe('Nothing was downloaded or stored.');
  });

  it('prints no title, attendee or name', async () => {
    conference('a', { start: ago(30), attendees: ['ravi@sharma.example'], title: 'Sharma Interiors secret plan' });
    api.signedInNames.set('conferenceRecords/a', ['Ravi Kumar']);
    await meetingCheckCommand(deps());
    const text = lines.join('\n');
    expect(text).not.toMatch(/secret plan|ravi|Ravi Kumar|Owner/i);
  });

  it('needs meetings on and the meeting scopes, and asks Google nothing otherwise', async () => {
    await expect(meetingCheckCommand(deps({ env: env({ MEETINGS_ENABLED: 'false' }) }))).rejects.toThrow(/Meetings are switched off/);
    saveGrantedScopes(db, DRIVE_SCOPES.join(' '));
    await expect(meetingCheckCommand(deps())).rejects.toThrow('Google sign-in needs meeting access');
    expect(api.calls).toEqual([]);
  });
});

describe('storedGoogleApi', () => {
  it('needs a stored sign-in, and builds a client without calling Google', () => {
    const e = env({ GOOGLE_OAUTH_CLIENT_ID: 'test-id', GOOGLE_OAUTH_CLIENT_SECRET: 'test-secret' });
    expect(() => storedGoogleApi(e)(db, KEY)).toThrow('Google is not connected. Run: npm run cli -- google-auth');
    new TokenStore(db, KEY).save('rt-test');
    const client = storedGoogleApi(e)(db, KEY);
    expect(typeof client.listConferences).toBe('function');
  });
});

describe('speechCeilingFromEnv', () => {
  it('is null for none, and the list price with speaker labels otherwise (Sarvam in rupees)', () => {
    expect(speechCeilingFromEnv({ STT_PROVIDER: 'none', INR_PER_USD: 88 })).toBeNull();
    expect(speechCeilingFromEnv({ STT_PROVIDER: 'openai', INR_PER_USD: 88 })!(3600)).toBeCloseTo(0.36);
    expect(speechCeilingFromEnv({ STT_PROVIDER: 'sarvam', INR_PER_USD: 90 })!(3600)).toBeCloseTo(0.4);
  });

  it('is $0 for the local engine: nothing is paid', () => {
    const local = speechCeilingFromEnv({ STT_PROVIDER: 'local', INR_PER_USD: 88 });
    expect(local).not.toBeNull();
    expect(local!(3 * 3600)).toBe(0);
  });
});

describe('meetingAiCeilingUsd', () => {
  it('grows with length, stops at the transcript limit, and is about $1 an hour at the default prices', () => {
    const p = { inputPerMTok: 4, outputPerMTok: 20, cacheWritePerMTok: 5, cacheReadPerMTok: 0.2 };
    expect(meetingAiCeilingUsd(3600, p)).toBeGreaterThan(0.8);
    expect(meetingAiCeilingUsd(3600, p)).toBeLessThan(1.3);
    expect(meetingAiCeilingUsd(7200, p)).toBeGreaterThan(meetingAiCeilingUsd(3600, p));
    expect(meetingAiCeilingUsd(100 * 3600, p)).toBe(meetingAiCeilingUsd(200 * 3600, p));
    expect(meetingAiCeilingUsd(3600, FALLBACK_PRICES)).toBeGreaterThan(meetingAiCeilingUsd(3600, p));
  });
});
