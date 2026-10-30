import { describe, expect, it } from 'vitest';
import { parseEnv } from '../../src/config/env.ts';
import { AgentControl, type PartState } from '../../src/control/agentControl.ts';
import { Health } from '../../src/health/health.ts';
import type { MeetingsHealth } from '../../src/health/health.ts';
import { saveAccountEmail, saveMeetingAccount } from '../../src/output/googleAuth.ts';
import { TRACKER_ID_KEY } from '../../src/output/trackerKey.ts';
import type { SenderState } from '../../src/report/types.ts';
import { SpendGuard } from '../../src/spend/spendGuard.ts';
import { setKv } from '../../src/store/kv.ts';
import { insertMessage } from '../../src/store/messages.ts';
import { manualClock } from '../../src/util/clock.ts';
import type { GatewayState, GatewayStatus } from '../../src/wa/gateway.ts';
import { seededDb } from '../helpers/db.ts';

const NOW = '2026-10-19T08:00:00.000Z';
const KEY = Buffer.alloc(32, 7);

async function setup(o: { env?: Record<string, string>; sender?: SenderState; heartbeat?: Date | null | 'none'; cap?: number; spareLinked?: () => boolean } = {}) {
  const db = await seededDb();
  const clock = manualClock(NOW);
  const spend = new SpendGuard({ db, clock, capUsd: o.cap ?? 10 });
  const health = new Health({ db, clock, spend, freeBytes: () => 200e9 });
  let gw: GatewayStatus = { state: 'open', since: NOW, lastErrorCode: null, credsSaveFailures: 0 };
  const setGateway = (state: GatewayState, since = clock.now().toISOString()) => {
    gw = { state, since, lastErrorCode: null, credsSaveFailures: 0 };
    health.setWhatsApp(gw);
  };
  setGateway('open');
  let senderState: SenderState = o.sender ?? 'idle';
  const control = new AgentControl({
    app: { health, spend },
    db,
    gateway: { status: () => gw },
    env: parseEnv(o.env ?? {}),
    clock,
    ...(o.sender === undefined ? {} : {
      sender: { status: () => ({ state: senderState, since: NOW, lastErrorCode: null }), maskedRecipient: () => '…5678' },
    }),
    ...(o.heartbeat === undefined || o.heartbeat === 'none' ? {} : { heartbeat: { lastBeatAt: () => o.heartbeat as Date | null } }),
    ...(o.spareLinked ? { spareLinked: o.spareLinked } : {}),
  });
  return { db, clock, spend, health, control, setGateway, setSender: (s: SenderState) => (senderState = s) };
}

const part = async (t: Awaited<ReturnType<typeof setup>>, key: string) => (await t.control.status()).parts.find((p) => p.key === key)!;
const state = async (t: Awaited<ReturnType<typeof setup>>, key: string): Promise<PartState> => (await part(t, key)).state;

function meetings(over: Partial<MeetingsHealth> = {}): MeetingsHealth {
  return {
    stats: { done: 0, waiting: 0, unassigned: 0, failed: 0, noAccess: 0, tooLong: 0, internal: 0, deferred: {} },
    paused: null, sttProvider: 'sarvam', ...over,
  };
}

describe('AgentControl.status', () => {
  it('gives the line, up, every part, the last message time and the spend', async () => {
    const t = await setup();
    await insertMessage(t.db, { waId: 'w1', clientId: 1, senderJid: 'x', senderNumber: '919812345678', senderName: null, fromMe: false, ts: '2026-10-19T07:00:00.000Z',
      text: 'hello', quotedWaId: null, mediaType: null });
    t.spend.record('ai', 1.25, 'batch 1');
    const s = (await t.control.status());
    expect(s).toMatchObject({ up: true, line: { ok: expect.any(Boolean), text: expect.any(String) }, lastMessageAt: '2026-10-19T07:00:00.000Z', spentToday: 1.25, capUsd: 10 });
    expect(s.parts.map((p) => p.key)).toEqual(['whatsapp', 'tracker', 'meetings', 'voice', 'report', 'spend']);
    for (const p of s.parts) expect(['ok', 'warn', 'down', 'off']).toContain(p.state);
  });

  it('maps WhatsApp: open, closed within and past the grace period, unlinked, replaced, refused', async () => {
    const t = await setup();
    expect(await part(t, 'whatsapp')).toMatchObject({ state: 'ok', label: 'Connected' });
    t.setGateway('closed');
    expect(await part(t, 'whatsapp')).toMatchObject({ state: 'warn', label: 'Reconnecting' });
    t.clock.advance(31 * 60_000);
    expect(await part(t, 'whatsapp')).toMatchObject({ state: 'down', label: 'Disconnected' });
    expect((await t.control.status()).up).toBe(false);
    for (const [s, label] of [['logged_out', 'Unlinked from the phone'], ['replaced', 'Taken over by another copy'], ['forbidden', 'Refused by WhatsApp']] as const) {
      t.setGateway(s);
      expect(await part(t, 'whatsapp'), s).toMatchObject({ state: 'down', label });
    }
  });

  it('shows setup mode and a dashboard link in progress, on Overview and Connections alike', async () => {
    const t = await setup();
    t.setGateway('not_linked');
    expect(await part(t, 'whatsapp')).toMatchObject({ state: 'down', label: 'Not linked' });
    expect((await t.control.connections()).founder).toMatchObject({ state: 'down', label: 'Not linked' });
    t.setGateway('linking');
    expect(await part(t, 'whatsapp')).toMatchObject({ state: 'warn', label: 'Linking from the dashboard' });
    expect((await t.control.connections()).founder).toMatchObject({ state: 'warn', label: 'Linking from the dashboard' });
  });

  it('maps the tracker: updated, failing, failing for over an hour, and a Google sign-in failure', async () => {
    const t = await setup();
    expect(await part(t, 'tracker')).toMatchObject({ state: 'ok' });
    t.health.markPublishFailed({ step: 'drive', auth: false });
    expect(await part(t, 'tracker')).toMatchObject({ state: 'warn', label: 'Upload failing' });
    t.clock.advance(61 * 60_000);
    expect(await part(t, 'tracker')).toMatchObject({ state: 'down', label: 'Uploads failing for over an hour' });
    t.health.markPublished();
    t.health.markPublishFailed({ step: 'drive', auth: true });
    expect(await part(t, 'tracker')).toMatchObject({ state: 'down', label: 'Google sign-in expired' });
  });

  it('maps meetings: off, paused, lost accounts, failed, waiting for speech-to-text, working', async () => {
    expect(await state(await setup(), 'meetings')).toBe('off');
    const t = await setup({ env: { MEETINGS_ENABLED: 'true', TEAM_EMAIL_DOMAINS: 'example.com' } });
    t.health.setMeetings(meetings());
    expect(await part(t, 'meetings')).toMatchObject({ state: 'ok', label: 'Working' });
    t.health.setMeetings(meetings({ paused: 'google_auth' }));
    expect(await part(t, 'meetings')).toMatchObject({ state: 'down', label: 'Paused: Google needs meeting access' });
    t.health.setMeetings(meetings({ paused: 'no_ffmpeg' }));
    expect(await part(t, 'meetings')).toMatchObject({ state: 'down', label: 'Paused: ffmpeg not found' });
    t.health.setMeetings(meetings({ lostAccounts: ['company2'] }));
    expect(await part(t, 'meetings')).toMatchObject({ state: 'warn', label: 'Google sign-in lost for company2' });
    t.health.setMeetings(meetings({ stats: { ...meetings().stats, failed: 2 } }));
    expect(await part(t, 'meetings')).toMatchObject({ state: 'warn', label: '2 meetings could not be processed' });
    t.health.setMeetings(meetings({ sttProvider: 'none', stats: { ...meetings().stats, waiting: 1 } }));
    expect(await part(t, 'meetings')).toMatchObject({ state: 'warn', label: 'Waiting: speech-to-text is not set up' });
  });

  it('meetings on the local engine (Task 3): working, or waiting with the same "local speech engine is not set up" as voice notes', async () => {
    const t = await setup({ env: { MEETINGS_ENABLED: 'true', TEAM_EMAIL_DOMAINS: 'example.com' } });
    t.health.setMeetings(meetings({ sttProvider: 'local', stats: { ...meetings().stats, waiting: 2 } }));
    expect(await part(t, 'meetings')).toMatchObject({ state: 'ok', label: 'Working' });
    for (const sttProblem of ['local_not_set_up_bin', 'local_not_set_up_model'] as const) {
      t.health.setMeetings(meetings({ sttProvider: 'local', sttProblem }));
      expect(await part(t, 'meetings')).toMatchObject({ state: 'warn', label: 'Waiting: the local speech engine is not set up' });
    }
    // Below the pauses, which say what to fix first.
    t.health.setMeetings(meetings({ sttProvider: 'local', sttProblem: 'local_not_set_up_bin', paused: 'no_ffmpeg' }));
    expect(await part(t, 'meetings')).toMatchObject({ state: 'down', label: 'Paused: ffmpeg not found' });
  });

  it('maps voice notes: off, a missing engine or ffmpeg, a refused key, failures, working', async () => {
    expect(await state(await setup(), 'voice')).toBe('off');
    const t = await setup({ env: { VOICE_STT_PROVIDER: 'sarvam', STT_PROVIDER: 'sarvam', STT_API_KEY: 'test-key-not-real' } });
    expect(await part(t, 'voice')).toMatchObject({ state: 'ok', label: 'Working' });
    t.health.setVoiceProblem('no_ffmpeg');
    expect(await part(t, 'voice')).toMatchObject({ state: 'warn', label: 'ffmpeg not found' });
    t.health.setVoiceProblem('local_not_set_up_model');
    expect(await part(t, 'voice')).toMatchObject({ state: 'warn', label: 'The local speech engine is not set up' });
    t.health.setVoiceProblem(null);
    t.health.setMedia({ pending: 0, stale: 0, spendCap: 0, failedRecent: 0, uploadFailed: 0, sttRefused: 3, voiceFailed: 0 });
    expect(await part(t, 'voice')).toMatchObject({ state: 'warn', label: 'The speech-to-text key was refused' });
    t.health.setMedia({ pending: 0, stale: 0, spendCap: 0, failedRecent: 0, uploadFailed: 0, sttRefused: 0, voiceFailed: 1 });
    expect(await part(t, 'voice')).toMatchObject({ state: 'warn', label: '1 voice note could not be transcribed' });
  });

  it('maps the morning report: off, sent, and a warning', async () => {
    const t = await setup();
    expect(await part(t, 'report')).toMatchObject({ state: 'off', label: 'Off' });
    t.health.setReport({ text: 'Morning report: off', warning: null });
    expect(await part(t, 'report')).toMatchObject({ state: 'off', label: 'Off' });
    t.health.setReport({ text: 'Morning report: sent at 06:00 IST', warning: null, recipientMasked: '…5678' });
    expect(await part(t, 'report')).toMatchObject({ state: 'ok', label: 'Sent at 06:00 IST' });
    t.health.setReport({ text: 'Morning report: unknown, check WhatsApp', warning: '⚠️ Morning report: unknown, check WhatsApp.' });
    expect(await part(t, 'report')).toMatchObject({ state: 'warn', label: 'Unknown, check WhatsApp' });
  });

  it('maps the spend: within budget, near the limit, at the limit', async () => {
    const t = await setup({ cap: 10 });
    expect(await part(t, 'spend')).toMatchObject({ state: 'ok', label: 'Within the daily limit' });
    t.spend.record('ai', 8, 'batch 1');
    expect(await part(t, 'spend')).toMatchObject({ state: 'warn', label: 'Near the daily limit' });
    t.spend.record('ai', 2, 'batch 2');
    expect(await part(t, 'spend')).toMatchObject({ state: 'warn', label: 'Daily limit reached: AI work waits until midnight IST' });
  });
});

describe('AgentControl.connections', () => {
  it('describes each card', async () => {
    const t = await setup({ env: { MEETINGS_ENABLED: 'true', TEAM_EMAIL_DOMAINS: 'example.com' }, sender: 'idle', heartbeat: new Date('2026-10-19T07:55:00.000Z') });
    await saveMeetingAccount(t.db, KEY, 'company2', 'refresh-token-not-real', 'https://www.googleapis.com/auth/meetings.space.readonly');
    t.health.setMeetings(meetings({ lostAccounts: ['company2'] }));
    await insertMessage(t.db, { waId: 'w1', clientId: 1, senderJid: 'x', senderNumber: null, senderName: null, fromMe: false, ts: '2026-10-19T07:00:00.000Z',
      text: 'hi', quotedWaId: null, mediaType: null });
    t.spend.record('ai', 0.5, 'batch 1');
    t.spend.record('ai', 0.25, 'batch 2');
    t.spend.record('stt', 0.25, 'meeting 1 part 0');
    db_publish(t.db);
    expect((await t.control.connections())).toEqual({
      founder: { state: 'ok', label: 'Connected', groups: 2, lastActivityAt: '2026-10-19T07:00:00.000Z', device: 'WA Agent - Tracker' },
      spare: { state: 'ok', label: 'Linked', device: 'WA Agent - Morning report', recipientMasked: '…5678' },
      google: [
        { label: 'main', email: null, usedFor: ['Tracker on Drive', 'Meetings'], state: 'ok', stateLabel: 'Connected' },
        { label: 'company2', email: null, usedFor: ['Meetings'], state: 'down', stateLabel: 'Sign-in lost' },
      ],
      drive: {
        state: 'ok', label: expect.any(String), lastUploadAt: '2026-10-19T06:00:00.000Z', file: 'Tracker.xlsx', folder: 'WA Agent', account: null, url: null,
      },
      claude: { callsToday: 2, spentToday: 1, capUsd: 10 },
      monitoring: { on: true, lastBeatAt: '2026-10-19T07:55:00.000Z' },
    });
  });

  it('the Drive card names the file, its folder, its link and the main account it is written with', async () => {
    const t = await setup();
    await setKv(t.db, TRACKER_ID_KEY, '1AbCdEfGhIjKlMnOp_qr-st');
    await setKv(t.db, 'google_account_email:main', 'owner@example.com');
    expect((await t.control.connections()).drive).toMatchObject({
      file: 'Tracker.xlsx', folder: 'WA Agent', account: 'owner@example.com', url: 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp_qr-st/view',
    });
  });

  it("shows each Google account's stored email, and names the main one on the Drive card", async () => {
    const t = await setup({ env: { MEETINGS_ENABLED: 'true', TEAM_EMAIL_DOMAINS: 'example.com' } });
    await saveMeetingAccount(t.db, KEY, 'company2', 'refresh-token-not-real', 'https://www.googleapis.com/auth/meetings.space.readonly');
    await saveAccountEmail(t.db, 'main', 'owner@studio.in');
    const c = (await t.control.connections());
    expect(c.google.map((g) => [g.label, g.email])).toEqual([['main', 'owner@studio.in'], ['company2', null]]);
    expect(c.drive.account).toBe('owner@studio.in');
  });

  it('maps the spare phone states, and has no spare card state without the report', async () => {
    expect((await (await setup()).control.connections()).spare).toEqual({ state: 'off', label: 'Switched off', device: 'WA Agent - Morning report', recipientMasked: null });
    // With the dashboard, the briefing may be off with no sender open: the saved link decides (Automations' switch needs it).
    let saved = true;
    const off = await setup({ spareLinked: () => saved });
    expect((await off.control.connections()).spare).toEqual({ state: 'ok', label: 'Linked', device: 'WA Agent - Morning report', recipientMasked: null });
    saved = false;
    expect((await off.control.connections()).spare).toEqual({ state: 'warn', label: 'Not linked', device: 'WA Agent - Morning report', recipientMasked: null });
    // An open sender's own state comes first.
    expect((await (await setup({ sender: 'logged_out', spareLinked: () => true })).control.connections()).spare).toMatchObject({ state: 'down', label: 'Logged out' });
    const t = await setup({ sender: 'not_linked' });
    const spare = async () => (await t.control.connections()).spare;
    expect(await spare()).toMatchObject({ state: 'warn', label: 'Not linked' });
    for (const [s, st] of [['open', 'ok'], ['connecting', 'ok'], ['unreadable', 'down'], ['unavailable', 'down'], ['self_send', 'down'], ['logged_out', 'down'],
      ['forbidden', 'down'], ['replaced', 'down']] as const) {
      t.setSender(s);
      expect((await spare()).state, s).toBe(st);
    }
  });

  it("main's Google state follows a publish sign-in failure and the meetings' Google pause", async () => {
    const t = await setup({ env: { MEETINGS_ENABLED: 'true', TEAM_EMAIL_DOMAINS: 'example.com' } });
    t.health.markPublishFailed({ step: 'drive', auth: true });
    expect((await t.control.connections()).google[0]).toMatchObject({ label: 'main', state: 'down', stateLabel: 'Sign-in expired' });
    t.health.markPublished();
    t.health.setMeetings(meetings({ paused: 'google_scopes' }));
    expect((await t.control.connections()).google[0]).toMatchObject({ state: 'warn', stateLabel: 'Needs meeting access' });
  });

  it('monitoring is off without a heartbeat, and has no beat before the first one', async () => {
    expect((await (await setup()).control.connections()).monitoring).toEqual({ on: false, lastBeatAt: null });
    expect((await (await setup({ heartbeat: null })).control.connections()).monitoring).toEqual({ on: true, lastBeatAt: null });
  });
});

function db_publish(db: Awaited<ReturnType<typeof seededDb>>) {
  db.raw.prepare("INSERT INTO audit_log (at, actor, event, kind, detail) VALUES ('2026-10-19T06:00:00.000Z', 'agent', 'tracker.published', 'ops', 'x')").run();
}

describe('AgentControl answers carry no secrets', () => {
  it('no token, key or full phone number in any answer', async () => {
    const t = await setup({ env: { MEETINGS_ENABLED: 'true', TEAM_EMAIL_DOMAINS: 'example.com', HEARTBEAT_URL: 'https://heartbeat.uptimerobot.com/secret-hb-token' },
      sender: 'open', heartbeat: new Date(NOW) });
    await saveMeetingAccount(t.db, KEY, 'company2', 'refresh-token-not-real', 'scope');
    await insertMessage(t.db, { waId: 'w1', clientId: 1, senderJid: '919812345678@s.whatsapp.net', senderNumber: '919812345678', senderName: 'Ravi', fromMe: false,
      ts: '2026-10-19T07:00:00.000Z', text: 'secret chat words', quotedWaId: null, mediaType: null });
    t.health.setReport({ text: 'Morning report: sent at 06:00 IST', warning: null, recipientMasked: '…5678' });
    const json = JSON.stringify([(await t.control.status()), (await t.control.overview()), (await t.control.connections())]);
    expect(json).not.toMatch(/refresh-token|secret-hb-token|heartbeat\.uptimerobot|9812345678|secret chat words|Ravi/);
    // No run of 7 or more digits outside a date or time.
    expect(json.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '')).not.toMatch(/\d{7,}/);
  });
});

describe('AgentControl review fixes', () => {
  it('shows the tracker and Google problem even while WhatsApp is down for another cause', async () => {
    const t = await setup({ env: { MEETINGS_ENABLED: 'true', TEAM_EMAIL_DOMAINS: 'example.com' } });
    t.setGateway('logged_out');
    t.health.markPublishFailed({ step: 'drive', auth: true });
    expect(await part(t, 'tracker')).toMatchObject({ state: 'down', label: 'Google sign-in expired' });
    expect((await t.control.connections()).google[0]).toMatchObject({ state: 'down', stateLabel: 'Sign-in expired' });
    t.health.markPublished();
    t.health.markPublishFailed({ step: 'drive', auth: false });
    t.clock.advance(61 * 60_000);
    expect(await part(t, 'tracker')).toMatchObject({ state: 'down', label: 'Uploads failing for over an hour' });
  });

  it('warns when meetings wait for a refused speech-to-text key, and is ok with no speech-to-text and nothing waiting', async () => {
    const t = await setup({ env: { MEETINGS_ENABLED: 'true', TEAM_EMAIL_DOMAINS: 'example.com' } });
    t.health.setMeetings(meetings({ stats: { ...meetings().stats, deferred: { stt_unavailable: 1 } } }));
    expect(await part(t, 'meetings')).toMatchObject({ state: 'warn', label: 'Waiting: the speech-to-text key was refused' });
    t.health.setMeetings(meetings({ sttProvider: 'none' }));
    expect(await part(t, 'meetings')).toMatchObject({ state: 'ok', label: 'Working' });
  });

  it('labels the tracker from the last recorded upload, which survives a restart', async () => {
    const t = await setup();
    expect(await part(t, 'tracker')).toMatchObject({ state: 'ok', label: 'Waiting for the first upload' });
    db_publish(t.db);
    expect(await part(t, 'tracker')).toMatchObject({ state: 'ok', label: 'Updated' });
  });

  it('warns while the WhatsApp session cannot be saved, and says Starting before the gateway runs', async () => {
    const t = await setup();
    t.health.setWhatsApp({ state: 'open', since: NOW, lastErrorCode: null, credsSaveFailures: 1 });
    const gw = { state: 'open' as const, since: NOW, lastErrorCode: null, credsSaveFailures: 1 };
    const c = new AgentControl({ app: { health: t.health, spend: t.spend }, db: t.db, gateway: { status: () => gw }, env: parseEnv({}), clock: t.clock });
    expect((await c.status()).parts[0]).toMatchObject({ state: 'warn', label: 'The session could not be saved' });
    t.setGateway('stopped');
    expect(await part(t, 'whatsapp')).toMatchObject({ state: 'warn', label: 'Starting' });
  });

  it('counts approved groups only, and main is used for the tracker only while meetings are off', async () => {
    const t = await setup();
    t.db.raw.prepare("UPDATE clients SET active = 0 WHERE code = 'MEH'").run();
    expect((await t.control.connections()).founder.groups).toBe(1);
    expect((await t.control.connections()).google).toEqual([{ label: 'main', email: null, usedFor: ['Tracker on Drive'], state: 'ok', stateLabel: 'Connected' }]);
  });

  it('the last message is the newest one stored', async () => {
    const t = await setup();
    for (const [waId, ts] of [['a', '2026-10-19T06:00:00.000Z'], ['b', '2026-10-19T07:30:00.000Z']] as const) {
      await insertMessage(t.db, { waId, clientId: 1, senderJid: 'x', senderNumber: null, senderName: null, fromMe: false, ts, text: 'x', quotedWaId: null, mediaType: null });
    }
    expect((await t.control.status()).lastMessageAt).toBe('2026-10-19T07:30:00.000Z');
  });
});

describe('AgentControl review round 2', () => {
  it('the last message is the newest one even when older messages are stored after it (catch-up after a reconnect)', async () => {
    const t = await setup();
    for (const [waId, ts] of [['new', '2026-10-19T07:30:00.000Z'], ['old', '2026-10-18T22:00:00.000Z']] as const) {
      await insertMessage(t.db, { waId, clientId: 1, senderJid: 'x', senderNumber: null, senderName: null, fromMe: false, ts, text: 'x', quotedWaId: null, mediaType: null });
    }
    expect((await t.control.status()).lastMessageAt).toBe('2026-10-19T07:30:00.000Z');
    expect((await t.control.connections()).founder.lastActivityAt).toBe('2026-10-19T07:30:00.000Z');
  });
});
