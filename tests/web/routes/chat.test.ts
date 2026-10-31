import { beforeEach, describe, expect, it } from 'vitest';
import type { ClientConfig } from '../../../src/config/groups.ts';
import { chatPage } from '../../../src/control/chatQueries.ts';
import { getClientByCode } from '../../../src/store/clients.ts';
import type { Db } from '../../../src/store/db.ts';
import { insertMessage } from '../../../src/store/messages.ts';
import { claimOutbox, markSending, outboxByUuid, sentTextFor, settleInterrupted } from '../../../src/store/outbox.ts';
import { retryMessage } from '../../../src/wa/gateway.ts';
import { upsertPerson } from '../../../src/store/people.ts';
import { manualClock, type ManualClock } from '../../../src/util/clock.ts';
import { createLogger } from '../../../src/util/logger.ts';
import type { GroupSendSocket, QuotedMessage } from '../../../src/wa/groupSend.ts';
import { Ingestor } from '../../../src/wa/ingest.ts';
import { normalizeMessage } from '../../../src/wa/normalize.ts';
import { chatReadHandler, chatSendHandler, SEND_HOURLY_MAX, type ChatDeps } from '../../../src/web/routes/chat.ts';
import type { AuditFn, OwnerContext } from '../../../src/web/routes/context.ts';
import { MEHTA, NOW, row, rows, seeded, SHARMA } from '../../helpers/db.ts';

// Open chat: a fake socket only. Nothing here can reach WhatsApp.

const CTX: OwnerContext = { actor: 'owner@example.com', sessionId: 'session-hash', requestId: 'a1b2c3d4e5f6' };
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Records every send; answers as told. `stateDuring` is the outbox row's state at the moment WhatsApp is asked. */
class FakeSocket implements GroupSendSocket {
  calls: { jid: string; text: string; quoted: QuotedMessage | undefined }[] = [];
  mode: 'ok' | 'throw' | 'hang' | 'no-id' = 'ok';
  stateDuring: (string | undefined)[] = [];
  readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }
  async sendMessage(jid: string, content: { text: string }, options?: { quoted: QuotedMessage }) {
    this.calls.push({ jid, text: content.text, quoted: options?.quoted });
    this.stateDuring.push((await row<{ state: string }>(this.db, 'SELECT state FROM outbox ORDER BY id DESC LIMIT 1'))?.state);
    if (this.mode === 'throw') throw new Error('socket closed while sending to 120363000000000001@g.us');
    if (this.mode === 'hang') return new Promise<never>(() => {});
    if (this.mode === 'no-id') return { key: {} };
    return { key: { id: `3EB0${String(this.calls.length).padStart(16, '0')}` } };
  }
}

let db: Db;
/** Sharma's and Mehta's real ids in the test running now (on Postgres ids are shared by every customer). */
let ids: { sharma: number; mehta: number };
let clock: ManualClock;
let sock: FakeSocket;
let on: boolean;
let open: boolean;
let configs: ClientConfig[];
let audits: Parameters<AuditFn>[0][];
let logLines: string[];
let deps: ChatDeps;

beforeEach(async () => {
  ({ db, ids } = await seeded());
  clock = manualClock(NOW);
  sock = new FakeSocket(db);
  on = true;
  open = true;
  configs = [SHARMA, MEHTA];
  audits = [];
  logLines = [];
  deps = {
    db,
    configs: () => configs,
    sendingOn: () => on,
    connected: () => open,
    // As the founder gateway: a socket only for an approved group while open.
    groupSocket: (groupId) => (open && configs.some((c) => c.groupId === groupId) ? sock : null),
    directory: { cachedGroups: () => [{ id: SHARMA.groupId, subject: 'Sharma x Studio' }] },
    audit: async (e) => { audits.push(e); },
    log: createLogger('debug', { write: (l: string) => void logLines.push(l) }),
    clock,
    sendTimeoutMs: 50,
  };
});

const send = (body: Record<string, unknown>, code = 'SHA') => chatSendHandler(deps, CTX, code, { uuid: uuid(1), text: 'Hello team', confirm: true, ...body });
const errorOf = (r: { body: unknown }) => (r.body as { error: { code: string; message: string } }).error;
const sent = (r: { body: unknown }) => r.body as { message: { uuid: string; state: string; text: string; quote: unknown }; replayed: boolean };
const outboxRows = () => rows<{ state: string; wa_id: string | null; error_code: string | null }>(db, 'SELECT * FROM outbox');

async function say(waId: string, o: { text?: string | null; fromMe?: boolean; ts?: string; jid?: string; media?: string } = {}): Promise<number> {
  await insertMessage(db, {
    waId, clientId: ids.sharma, senderJid: o.jid ?? '919812345678@s.whatsapp.net', senderNumber: o.fromMe ? null : '919812345678', senderName: null,
    fromMe: o.fromMe ?? false, ts: o.ts ?? '2026-10-19T07:00:00.000Z', text: o.text === undefined ? `text of ${waId}` : o.text, quotedWaId: null, mediaType: o.media ?? null,
  });
  return (await row<{ id: number }>(db, 'SELECT id FROM messages WHERE wa_id = ?', [waId]))!.id;
}

describe('sending from the dashboard', () => {
  it('sends the confirmed text to the client’s own group, once: claimed and logged as sending before WhatsApp is asked', async () => {
    const r = await send({});
    expect(r.status).toBe(200);
    expect(sent(r)).toMatchObject({ message: { uuid: uuid(1), state: 'sent', text: 'Hello team' }, replayed: false });
    expect(sock.calls).toEqual([{ jid: SHARMA.groupId, text: 'Hello team', quoted: undefined }]);
    expect(sock.stateDuring).toEqual(['sending']);
    expect(await outboxRows()).toMatchObject([{ state: 'sent', wa_id: '3EB00000000000000001', error_code: null }]);
    const asking = logLines.findIndex((l) => l.includes('dashboard send: asking WhatsApp'));
    expect(asking).toBeGreaterThan(-1);
    expect(logLines.findIndex((l) => l.includes('dashboard send: done'))).toBeGreaterThan(asking);
    // One audit line: the client, the length and the outcome. Never the text.
    expect(audits).toEqual([{ actor: CTX.actor, kind: 'ops', requestId: CTX.requestId, event: 'Message sent · Sharma Interiors (SHA)', detail: '10 characters' }]);
    expect(JSON.stringify(audits) + logLines.join('')).not.toContain('Hello team');
  });

  it('refuses while "Allow sending from the dashboard" is off: nothing claimed, nothing sent', async () => {
    on = false;
    const r = await send({});
    expect(r.status).toBe(409);
    expect(errorOf(r).code).toBe('sending_off');
    expect(sock.calls).toEqual([]);
    expect(await outboxRows()).toEqual([]);
  });

  it('without the dialog’s confirm nothing is sent', async () => {
    for (const confirm of [undefined, false, 'yes', 1]) {
      const r = await chatSendHandler(deps, CTX, 'SHA', { uuid: uuid(1), text: 'Hello', ...(confirm === undefined ? {} : { confirm }) });
      expect(r.status).toBe(400);
      expect(errorOf(r).code).toBe('not_confirmed');
    }
    expect(sock.calls).toEqual([]);
    expect(await outboxRows()).toEqual([]);
  });

  it('a replayed uuid gives the first message back and never sends again; reused for another text it is refused', async () => {
    await send({});
    clock.advance(10_000);
    const again = await send({});
    expect(again.status).toBe(200);
    expect(sent(again)).toMatchObject({ message: { state: 'sent' }, replayed: true });
    const other = await send({ text: 'Something else' });
    expect(other.status).toBe(409);
    expect(errorOf(other).code).toBe('uuid_reused');
    expect(sock.calls).toHaveLength(1);
    expect(audits).toHaveLength(1);
  });

  it('never takes a group from the browser: an extra field is refused, a group id as the code is not a client', async () => {
    for (const extra of [{ jid: '120363000000000002@g.us' }, { groupId: MEHTA.groupId }, { to: '919812345678@s.whatsapp.net' }]) {
      const r = await send(extra);
      expect(r.status).toBe(400);
      expect(errorOf(r).message).toBe('The message has a field that is not allowed.');
    }
    for (const code of ['120363000000000002@g.us', 'sha', 'SHA@g.us', '../MEH']) expect((await send({}, code)).status).toBe(404);
    expect(sock.calls).toEqual([]);
  });

  it('sends only to an approved, active client', async () => {
    configs = [MEHTA]; // Sharma's group is no longer in the allow-list
    expect((await send({})).status).toBe(404);
    configs = [SHARMA, MEHTA];
    await db.run("UPDATE clients SET active = 0 WHERE code = 'SHA'");
    expect((await send({})).status).toBe(404);
    expect(sock.calls).toEqual([]);
  });

  it('checks the text: not empty, at most 4096 characters', async () => {
    expect((await send({ text: '   \n ' })).status).toBe(400);
    expect((await send({ text: 'x'.repeat(4097) })).status).toBe(400);
    expect((await send({ text: 'x'.repeat(4096) })).status).toBe(200);
    expect(sock.calls).toHaveLength(1);
  });

  it('rate limits: 3 seconds between messages to the same group, 30 an hour in all', async () => {
    expect((await send({ uuid: uuid(1) })).status).toBe(200);
    clock.advance(2_000);
    const soon = await send({ uuid: uuid(2) });
    expect(soon.status).toBe(429);
    expect(errorOf(soon).code).toBe('rate_limited');
    // Another group is its own: no 3-second wait.
    expect((await send({ uuid: uuid(3) }, 'MEH')).status).toBe(200);
    clock.advance(1_000);
    expect((await send({ uuid: uuid(4) })).status).toBe(200);
    for (let i = 5; i < 5 + SEND_HOURLY_MAX - 3; i++) {
      clock.advance(3_000);
      expect((await send({ uuid: uuid(i) })).status, `message ${i}`).toBe(200);
    }
    clock.advance(3_000);
    const tooMany = await send({ uuid: uuid(99) });
    expect(tooMany.status).toBe(429);
    expect(errorOf(tooMany).message).toContain('At most 30 messages an hour');
    expect(sock.calls).toHaveLength(SEND_HOURLY_MAX);
    clock.advance(3_600_000);
    expect((await send({ uuid: uuid(100) })).status).toBe(200);
  });

  it('an unclear answer is unknown, never retried: an error, a timeout or no message id', async () => {
    for (const [n, mode, code] of [[1, 'throw', 'send_error'], [2, 'hang', 'timeout'], [3, 'no-id', 'no_message_id']] as const) {
      sock.mode = mode;
      clock.advance(5_000);
      const r = await send({ uuid: uuid(n) });
      expect(r.status).toBe(200);
      expect(sent(r).message.state).toBe('unknown');
      expect(await outboxByUuid(db, uuid(n))).toMatchObject({ state: 'unknown', errorCode: code });
      expect(audits.at(-1)).toMatchObject({ event: 'Message may have been sent (check WhatsApp) · Sharma Interiors (SHA)', detail: `10 characters · ${code}` });
    }
    sock.mode = 'ok';
    clock.advance(5_000);
    const replay = await send({ uuid: uuid(1) });
    expect(sent(replay)).toMatchObject({ message: { state: 'unknown' }, replayed: true });
    expect(sock.calls).toHaveLength(3);
    // No error text is kept or logged: it can hold the group's id.
    expect(logLines.join('')).not.toContain('@g.us');
  });

  it('WhatsApp not connected: failed, surely not sent', async () => {
    open = false;
    const r = await send({});
    expect(sent(r).message.state).toBe('failed');
    expect(await outboxByUuid(db, uuid(1))).toMatchObject({ state: 'failed', errorCode: 'whatsapp_not_connected' });
    expect(sock.calls).toEqual([]);
    expect(audits.at(-1)!.event).toBe('Message not sent · Sharma Interiors (SHA)');
  });

  it('a reply quotes the stored message by its row, only within this client', async () => {
    const id = await say('ABCDEF0123456789', { text: 'Can you send the quote?' });
    const r = await send({ replyTo: id, text: 'Sending it today' });
    expect(sent(r).message.quote).toEqual({ sender: 'Someone', text: 'Can you send the quote?', kind: 'text' });
    expect(sock.calls[0]!.quoted).toEqual({
      key: { remoteJid: SHARMA.groupId, id: 'ABCDEF0123456789', fromMe: false, participant: '919812345678@s.whatsapp.net' },
      message: { conversation: 'Can you send the quote?' },
    });
    await insertMessage(db, {
      waId: 'MEHTA00000000001', clientId: ids.mehta, senderJid: 'x@s.whatsapp.net', senderNumber: null, senderName: null, fromMe: false,
      ts: NOW, text: 'other client', quotedWaId: null, mediaType: null,
    });
    const otherId = (await row<{ id: number }>(db, "SELECT id FROM messages WHERE wa_id = 'MEHTA00000000001'"))!.id;
    clock.advance(5_000);
    const bad = await send({ uuid: uuid(2), replyTo: otherId });
    expect(bad.status).toBe(400);
    expect(sock.calls).toHaveLength(1);
  });

  it('the founder’s own copy coming back (fromMe) is stored once and shown once', async () => {
    await send({});
    const waId = (await outboxRows())[0]!.wa_id!;
    // Before it comes back the chat shows the dashboard's own row.
    const sha = (await getClientByCode(db, 'SHA'))!;
    expect((await chatPage(db, sha, clock.now())).outbox.map((o) => o.state)).toEqual(['sent']);
    const ingest = new Ingestor({ db, onNewMessages: () => {}, clock });
    const echo = normalizeMessage({
      key: { remoteJid: SHARMA.groupId, fromMe: true, id: waId }, message: { conversation: 'Hello team' }, messageTimestamp: Date.parse(NOW) / 1000,
    } as Parameters<typeof normalizeMessage>[0]);
    expect(echo).not.toBeNull();
    await ingest.handle(echo!);
    await ingest.handle(echo!); // Baileys' own event, then the phone's copy of the same message
    expect((await row<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM messages WHERE wa_id = ?', [waId]))!.n).toBe(1);
    const page = await chatPage(db, sha, clock.now());
    expect(page.outbox).toEqual([]);
    expect(page.messages.filter((m) => m.text === 'Hello team')).toEqual([expect.objectContaining({ mine: true, sender: 'Founder' })]);
  });

  it('a stop mid-send: claimed becomes failed, sending becomes unknown; neither is sent again', async () => {
    const a = await claimOutbox(db, { uuid: uuid(1), clientId: ids.sharma, text: 'a', replyTo: null, actor: CTX.actor, at: NOW });
    const b = await claimOutbox(db, { uuid: uuid(2), clientId: ids.sharma, text: 'b', replyTo: null, actor: CTX.actor, at: NOW });
    await markSending(db, b.id, NOW);
    expect(await settleInterrupted(db, NOW)).toEqual({ failed: 1, unknown: 1 });
    expect(await outboxByUuid(db, a.uuid)).toMatchObject({ state: 'failed', errorCode: 'interrupted_before_send' });
    expect(await outboxByUuid(db, b.uuid)).toMatchObject({ state: 'unknown', errorCode: 'interrupted' });
  });
});

describe('resending to a phone that could not read a message (getMessage)', () => {
  it('answers only for a message sent from the dashboard, in its own group, with just its text; nothing for any other message', async () => {
    const getMessage = retryMessage((waId, groupId) => sentTextFor(db, waId, groupId));
    await send({});
    const waId = (await outboxRows())[0]!.wa_id!;
    expect(await getMessage({ id: waId, remoteJid: SHARMA.groupId })).toEqual({ conversation: 'Hello team' });
    // A message the agent only read (stored, not in the outbox), the right id in another group, an unknown id, no id.
    const read = await say('READ000000000001', { text: 'a member wrote this' });
    const readWaId = (await row<{ w: string }>(db, 'SELECT wa_id AS w FROM messages WHERE id = ?', [read]))!.w;
    expect(await getMessage({ id: readWaId, remoteJid: SHARMA.groupId })).toBeUndefined();
    expect(await getMessage({ id: waId, remoteJid: MEHTA.groupId })).toBeUndefined();
    expect(await getMessage({ id: 'NOPE000000000000', remoteJid: SHARMA.groupId })).toBeUndefined();
    expect(await getMessage({ remoteJid: SHARMA.groupId })).toBeUndefined();
    // A message whose outcome is unknown or failed has no id of its own to answer for.
    sock.mode = 'throw';
    clock.advance(5_000);
    await send({ uuid: uuid(2) });
    expect((await outboxRows()).filter((r) => r.state === 'unknown')).toHaveLength(1);
    // Without the outbox lookup (the CLI's link step), getMessage answers nothing at all.
    expect(await retryMessage()({ id: waId, remoteJid: SHARMA.groupId })).toBeUndefined();
  });
});

describe('reading the chat', () => {
  const read = async (search: { before?: string; limit?: string } = {}, code = 'SHA') => await chatReadHandler(deps, CTX, code, search);
  const view = (r: { body: unknown }) => r.body as { messages: { id: number; text: string; mine: boolean; sender: string; kind: string; deleted: boolean; transcript: string | null; quote: unknown }[]; hasOlder: boolean; client: { groupName: string }; sendingOn: boolean };

  it('pages newest first with no phone number, JID or WhatsApp id; text as stored, lines kept', async () => {
    await upsertPerson(db, { clientId: ids.sharma, jid: '919812345678@s.whatsapp.net', number: '919812345678', name: 'Rahul +91 98123 45678', fromMe: false });
    await upsertPerson(db, { clientId: ids.sharma, jid: '919800000001@s.whatsapp.net', number: '919800000001', name: 'Neha', fromMe: false });
    for (let i = 0; i < 5; i++) await say(`MSG000000000000${i}`, { ts: `2026-10-19T07:0${i}:00.000Z`, text: `line one ${i}\nline two <b>x</b>`, jid: i % 2 ? '919800000001@s.whatsapp.net' : undefined });
    const first = await read({ limit: '2' });
    expect(first.status).toBe(200);
    const v = view(first);
    expect(v.messages.map((m) => m.text)).toEqual(['line one 4\nline two <b>x</b>', 'line one 3\nline two <b>x</b>']);
    expect(v.messages.map((m) => m.sender)).toEqual(['Someone', 'Neha']);
    expect(v.hasOlder).toBe(true);
    expect(v.client.groupName).toBe('Sharma x Studio');
    const older = view(await read({ before: String(v.messages[1]!.id), limit: '2' }));
    expect(older.messages.map((m) => m.text.slice(0, 10))).toEqual(['line one 2', 'line one 1']);
    const last = view(await read({ before: String(older.messages[1]!.id), limit: '2' }));
    expect(last.messages).toHaveLength(1);
    expect(last.hasOlder).toBe(false);
    expect(JSON.stringify([v, older, last])).not.toMatch(/@s\.whatsapp|@g\.us|9198|98123|MSG0000/);
  });

  it('a deleted message has no text; a voice note shows its transcript; a reply shows its quote', async () => {
    const gone = await say('GONE000000000001', { text: 'secret' });
    await db.run('UPDATE messages SET revoked = 1 WHERE id = ?', [gone]);
    const voice = await say('VOICE00000000001', { text: null, media: 'voice', ts: '2026-10-19T07:01:00.000Z' });
    await db.run("INSERT INTO media (message_id, client_id, kind, status, seconds, text_kind, text, created_at, updated_at) VALUES (?, ?, 'voice', 'done', 42, 'extract', 'Please call me', '2026-10-19T07:01:00.000Z', '2026-10-19T07:01:00.000Z')", [voice, ids.sharma]);
    await say('QUOTER0000000001', { ts: '2026-10-19T07:02:00.000Z', text: 'yes' });
    await db.run("UPDATE messages SET quoted_wa_id = 'VOICE00000000001' WHERE wa_id = 'QUOTER0000000001'");
    const [reply, note, deleted] = view(await read()).messages;
    expect(deleted).toMatchObject({ deleted: true, text: '' });
    expect(note).toMatchObject({ kind: 'voice', transcript: 'Please call me' });
    expect(reply!.quote).toEqual({ sender: 'Someone', text: '', kind: 'voice' });
    expect(JSON.stringify(view(await read()))).not.toContain('secret');
  });

  it('only an approved client, and whole numbers only', async () => {
    expect((await read({}, 'ZZZ')).status).toBe(404);
    expect((await read({}, '120363000000000001@g.us')).status).toBe(404);
    expect((await read({ before: '1; DROP TABLE messages' })).status).toBe(400);
    expect((await read({ limit: '-1' })).status).toBe(400);
    expect(view(await read()).sendingOn).toBe(true);
  });
});
