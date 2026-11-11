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
import { chatReadHandler, chatSendHandler, type ChatDeps } from '../../../src/web/routes/chat.ts';
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
let source: ReturnType<typeof vi.fn<(groupId: string, o?: { fresh?: boolean }) => Promise<GroupMember[] | null>>>;
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
  source = vi.fn(async (_groupId: string, _o?: { fresh?: boolean }) => members);
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
    // Read fresh, not from the 5-minute keep: someone who just left is not tagged (final review, S2).
    expect(source).toHaveBeenCalledWith(SHARMA.groupId, { fresh: true });
    // The outbox keeps the text as sent.
    expect((await rows<{ text: string }>(db, 'SELECT text FROM outbox')).map((x) => x.text)).toEqual([text]);
  });

  it('a "@number" that is not a member now is refused before anything is claimed: it would go out as a number (final review, S2)', async () => {
    for (const [n, text] of [[1, 'call @919811111111 tomorrow'], [2, '@919800000001 and @919811111111 please check']] as const) {
      const r = await send(text, n);
      expect(r.status, text).toBe(409);
      expect(errorOf(r).code).toBe('tag_not_member');
      expect(JSON.stringify(r.body)).not.toContain('919811111111');
    }
    expect(sock.calls).toEqual([]);
    expect(await rows(db, 'SELECT id FROM outbox')).toEqual([]);
    // Once they are in the group again (a fresh read sees them), the same text is sent, tagged.
    members = [...members!, { id: '919811111111@s.whatsapp.net', phoneNumber: '919811111111@s.whatsapp.net', lid: null, admin: false }];
    expect((await send('call @919811111111 tomorrow', 3)).status).toBe(200);
    expect(sock.calls[0]!.content).toEqual({ text: 'call @919811111111 tomorrow', mentions: ['919811111111@s.whatsapp.net'] });
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

// Owner report, 11 Nov: tags showed as jumbled numbers. A tag uses the id the group uses (here the hidden-number one),
// while Rahul is known by the number he writes from: the group's member list links the two.
describe('tags named through the group’s members', () => {
  const RAHUL_HIDDEN = '201111111111111@lid';
  const NEW_HIDDEN = '207777777777777@lid';
  const tagged = async (text: string) => {
    await insertMessage(db, {
      waId: 'M9', clientId: sharma, senderJid: '919800000009@s.whatsapp.net', senderNumber: '919800000009', senderName: null, fromMe: false,
      ts: '2026-10-19T07:00:00.000Z', text, quotedWaId: null, mediaType: null,
    });
  };
  beforeEach(async () => {
    await upsertPerson(db, { clientId: sharma, jid: PN1, number: '919800000001', name: 'Rahul', fromMe: false });
    members = [
      { id: RAHUL_HIDDEN, phoneNumber: PN1, lid: RAHUL_HIDDEN, admin: false },
      { id: NEW_HIDDEN, phoneNumber: '919800000007@s.whatsapp.net', lid: NEW_HIDDEN, admin: false }, // has never written
      { id: HIDDEN, phoneNumber: null, lid: HIDDEN, admin: false }, // hidden number, never wrote
    ];
  });
  const sha = async () => (await getClientByCode(db, 'SHA'))!;

  it('a hidden-number tag names the person who writes from their number; a member never seen shows the number WhatsApp gives', async () => {
    await tagged('@201111111111111 @207777777777777 @203333333333333 @209999999999999 please check');
    const page = await chatPage(db, await sha(), new Date(NOW), { members: () => source(SHARMA.groupId) });
    // Sana's number is hidden and someone not in the group is not known: both are left out (the chat says "@member").
    expect(page.names).toEqual({ '201111111111111': 'Rahul', '207777777777777': '+91 98000 00007' });
  });

  it('asks WhatsApp only when the agent’s people do not name every tag', async () => {
    await tagged('@919800000001 hi');
    expect((await chatPage(db, await sha(), new Date(NOW), { members: () => source(SHARMA.groupId) })).names).toEqual({ '919800000001': 'Rahul' });
    expect(source).not.toHaveBeenCalled();
  });

  it('the chat page reads the members while the group’s phone is open, and names by its people alone otherwise', async () => {
    await tagged('@201111111111111 please check');
    const read = await chatReadHandler(deps, CTX, 'SHA', {});
    expect((read.body as { names: Record<string, string> }).names).toEqual({ '201111111111111': 'Rahul' });
    expect(source).toHaveBeenCalledWith(SHARMA.groupId);
    source.mockClear();
    deps.connected = () => false;
    const offline = await chatReadHandler(deps, CTX, 'SHA', {});
    expect((offline.body as { names: Record<string, string> }).names).toEqual({});
    expect(source).not.toHaveBeenCalled();
  });
});
