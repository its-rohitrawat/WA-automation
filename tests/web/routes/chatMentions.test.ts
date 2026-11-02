import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chatPage } from '../../../src/control/chatQueries.ts';
import { getClientByCode } from '../../../src/store/clients.ts';
import type { Db } from '../../../src/store/db.ts';
import { insertMessage } from '../../../src/store/messages.ts';
import { upsertPerson } from '../../../src/store/people.ts';
import { manualClock } from '../../../src/util/clock.ts';
import { createLogger } from '../../../src/util/logger.ts';
import type { GroupMember } from '../../../src/wa/groupMembers.ts';
import type { GroupSendSocket, QuotedMessage } from '../../../src/wa/groupSend.ts';
import { chatSendHandler, type ChatDeps } from '../../../src/web/routes/chat.ts';
import type { AuditFn, OwnerContext } from '../../../src/web/routes/context.ts';
import { MEHTA, NOW, rows, seeded, SHARMA } from '../../helpers/db.ts';

// Tagging (November release, change 2): "@<digits>" in a confirmed message names a member; the sent message tags exactly
// the group's members named so. A fake socket and a fake members source: nothing here reaches WhatsApp. Made-up numbers.

const CTX: OwnerContext = { actor: 'owner@example.com', sessionId: 'session-hash', requestId: 'a1b2c3d4e5f6' };
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PN1 = '919800000001@s.whatsapp.net';
const HIDDEN = '203333333333333@lid';

class FakeSocket implements GroupSendSocket {
  calls: { jid: string; content: { text: string; mentions?: string[] }; quoted: QuotedMessage | undefined }[] = [];
  async sendMessage(jid: string, content: { text: string; mentions?: string[] }, options?: { quoted: QuotedMessage }) {
    this.calls.push({ jid, content, quoted: options?.quoted });
    return { key: { id: `3EB0${String(this.calls.length).padStart(16, '0')}` } };
  }
}

let db: Db;
let sharma: number;
let sock: FakeSocket;
let members: GroupMember[] | null;
let source: ReturnType<typeof vi.fn<(groupId: string) => Promise<GroupMember[] | null>>>;
let audits: Parameters<AuditFn>[0][];
let logLines: string[];
let deps: ChatDeps;

beforeEach(async () => {
  let ids;
  ({ db, ids } = await seeded());
  sharma = ids.sharma;
  sock = new FakeSocket();
  members = [
    { id: PN1, phoneNumber: PN1, lid: null, admin: true },
    { id: HIDDEN, phoneNumber: null, lid: HIDDEN, admin: false },
  ];
  source = vi.fn(async (_groupId: string) => members);
  audits = [];
  logLines = [];
  deps = {
    db,
    configs: () => [SHARMA, MEHTA],
    sendingOn: () => true,
    connected: () => true,
    groupSocket: (groupId) => (groupId === SHARMA.groupId || groupId === MEHTA.groupId ? sock : null),
    groupMembers: source,
    directory: { cachedGroups: () => [] },
    audit: async (e) => { audits.push(e); },
    log: createLogger('debug', { write: (l: string) => void logLines.push(l) }),
    clock: manualClock(NOW),
    sendTimeoutMs: 50,
  };
});

const send = (text: string, n = 1) => chatSendHandler(deps, CTX, 'SHA', { uuid: uuid(n), text, confirm: true });
const errorOf = (r: { body: unknown }) => (r.body as { error: { code: string } }).error;

describe('sending with tags', () => {
  it('tags exactly the members the text names, by the id the group uses (a hidden-number member by its @lid id)', async () => {
    const text = '@919800000001 and @203333333333333 please check';
    const r = await send(text);
    expect(r.status).toBe(200);
    expect(sock.calls).toEqual([{ jid: SHARMA.groupId, content: { text, mentions: [PN1, HIDDEN] }, quoted: undefined }]);
    expect(source).toHaveBeenCalledWith(SHARMA.groupId);
    // The outbox keeps the text as sent.
    expect((await rows<{ text: string }>(db, 'SELECT text FROM outbox')).map((x) => x.text)).toEqual([text]);
  });

  it('a "@number" that is not a member stays plain text: no tag', async () => {
    await send('call @919811111111 tomorrow');
    expect(sock.calls[0]!.content).toEqual({ text: 'call @919811111111 tomorrow' });
  });

  it('a message without tags reads no members and is sent as before', async () => {
    await send('Hello team');
    expect(source).not.toHaveBeenCalled();
    expect(sock.calls[0]!.content).toEqual({ text: 'Hello team' });
  });

  it('when the members cannot be read, a tagged message is refused before anything is claimed or sent', async () => {
    members = null;
    const r = await send('@919800000001 please check');
    expect(r.status).toBe(409);
    expect(errorOf(r).code).toBe('mentions_unavailable');
    deps.connected = () => false;
    expect(errorOf(await send('@919800000001 please check', 2)).code).toBe('mentions_unavailable');
    delete deps.groupMembers;
    deps.connected = () => true;
    expect(errorOf(await send('@919800000001 please check', 3)).code).toBe('mentions_unavailable');
    expect(sock.calls).toEqual([]);
    expect(await rows(db, 'SELECT id FROM outbox')).toEqual([]);
  });

  it('every send rule stays: the switch, the confirm and the limits come before the members are read', async () => {
    deps.sendingOn = () => false;
    expect(errorOf(await send('@919800000001 hi')).code).toBe('sending_off');
    deps.sendingOn = () => true;
    const unconfirmed = await chatSendHandler(deps, CTX, 'SHA', { uuid: uuid(4), text: '@919800000001 hi' });
    expect(errorOf(unconfirmed).code).toBe('not_confirmed');
    expect(source).not.toHaveBeenCalled();
    await send('@919800000001 first', 5);
    expect(errorOf(await send('@919800000001 too soon', 6)).code).toBe('rate_limited');
    expect(sock.calls).toHaveLength(1);
  });

  it('logs and audits the number of tags, never a number or a tag', async () => {
    await send('@919800000001 and @203333333333333 please check');
    expect(audits[0]!.detail).toContain('2 tagged');
    const said = JSON.stringify([audits, logLines]);
    expect(said).not.toMatch(/9198000000|20333333333|@s\.whatsapp|@lid/);
  });
});

describe('tags shown in the chat', () => {
  it('names each tag on the page that the agent knows; an unknown one, or a "name" that is a number, is left out', async () => {
    await upsertPerson(db, { clientId: sharma, jid: PN1, number: '919800000001', name: 'Rahul', fromMe: false });
    await upsertPerson(db, { clientId: sharma, jid: HIDDEN, number: null, name: 'Sana', fromMe: false });
    await upsertPerson(db, { clientId: sharma, jid: '919800000005@s.whatsapp.net', number: '919800000005', name: '+91 98000 00005', fromMe: false });
    await insertMessage(db, {
      waId: 'M1', clientId: sharma, senderJid: '919800000009@s.whatsapp.net', senderNumber: '919800000009', senderName: null, fromMe: false,
      ts: '2026-10-19T07:00:00.000Z', text: '@919800000001 @203333333333333 @919800000005 @919822222222 see this', quotedWaId: null, mediaType: null,
    });
    const sha = (await getClientByCode(db, 'SHA'))!;
    const page = await chatPage(db, sha, new Date(NOW));
    expect(page.names).toEqual({ '919800000001': 'Rahul', '203333333333333': 'Sana' });
  });

  it('names only from this client’s own people', async () => {
    const mehta = (await getClientByCode(db, 'MEH'))!;
    await upsertPerson(db, { clientId: mehta.id, jid: PN1, number: '919800000001', name: 'Rahul at Mehta', fromMe: false });
    await insertMessage(db, {
      waId: 'M2', clientId: sharma, senderJid: '919800000009@s.whatsapp.net', senderNumber: '919800000009', senderName: null, fromMe: false,
      ts: '2026-10-19T07:00:00.000Z', text: '@919800000001 hi', quotedWaId: null, mediaType: null,
    });
    const page = await chatPage(db, (await getClientByCode(db, 'SHA'))!, new Date(NOW));
    expect(page.names).toEqual({});
  });
});
