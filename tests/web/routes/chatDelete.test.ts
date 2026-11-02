import { beforeEach, describe, expect, it } from 'vitest';
import { chatPage } from '../../../src/control/chatQueries.ts';
import { getClientByCode, type ClientRow } from '../../../src/store/clients.ts';
import type { Db } from '../../../src/store/db.ts';
import { insertMessage } from '../../../src/store/messages.ts';
import { claimOutbox } from '../../../src/store/outbox.ts';
import { manualClock, type ManualClock } from '../../../src/util/clock.ts';
import { createLogger } from '../../../src/util/logger.ts';
import type { ChatDeleteSocket, LastMessage } from '../../../src/wa/chatDelete.ts';
import { chatDeleteHandler, type ChatDeps } from '../../../src/web/routes/chat.ts';
import type { AuditFn, OwnerContext } from '../../../src/web/routes/context.ts';
import { MEHTA, NOW, row, seeded, SHARMA } from '../../helpers/db.ts';

// Delete chat (November release, owner decision 2 Nov 2026): it deletes the chat on the founder's phone's WhatsApp and
// hides it in the dashboard; a new message brings it back; the saved messages and tasks stay, and the group stays
// approved. A fake socket only: nothing here reaches WhatsApp. Made-up numbers.

const CTX: OwnerContext = { actor: 'owner@example.com', sessionId: 'session-hash', requestId: 'a1b2c3d4e5f6' };
const SECRET = 'TEXT-never-in-a-log';

/** Records each delete, and how many log lines there were when WhatsApp was asked; answers as told. */
class FakeDeleteSocket implements ChatDeleteSocket {
  calls: { mod: { delete: true; lastMessages: LastMessage[] }; jid: string; logsBefore: number }[] = [];
  mode: 'ok' | 'throw' | 'hang' = 'ok';
  release: (() => void) | undefined;
  async chatModify(mod: { delete: true; lastMessages: LastMessage[] }, jid: string) {
    this.calls.push({ mod, jid, logsBefore: logLines.length });
    if (this.mode === 'throw') throw new Error(`could not change ${jid}`);
    if (this.mode === 'hang') await new Promise<void>((r) => (this.release = r));
  }
}

let db: Db;
let sharma: ClientRow;
let clock: ManualClock;
let sock: FakeDeleteSocket;
let open: boolean;
let audits: Parameters<AuditFn>[0][];
let logLines: string[];
let deps: ChatDeps;

beforeEach(async () => {
  ({ db } = await seeded());
  sharma = (await getClientByCode(db, 'SHA'))!;
  clock = manualClock(NOW);
  sock = new FakeDeleteSocket();
  open = true;
  audits = [];
  logLines = [];
  deps = {
    db,
    configs: () => [SHARMA, MEHTA],
    sendingOn: () => false, // Delete is not gated on the sending switch (coordinator, 2 Nov)
    connected: () => open,
    groupSocket: () => null,
    // As the founder gateway: a socket only for an approved group while open.
    chatDeleteSocket: (groupId) => (open && (groupId === SHARMA.groupId || groupId === MEHTA.groupId) ? sock : null),
    directory: { cachedGroups: () => [] },
    audit: async (e) => { audits.push(e); },
    log: createLogger('debug', { write: (l: string) => void logLines.push(l) }),
    clock,
    deleteTimeoutMs: 50,
  };
});

async function say(waId: string, o: { ts?: string; fromMe?: boolean; client?: ClientRow } = {}) {
  await insertMessage(db, {
    waId, clientId: (o.client ?? sharma).id, senderJid: o.fromMe ? '919800000099@s.whatsapp.net' : '919800000001@s.whatsapp.net', senderNumber: null, senderName: null,
    fromMe: o.fromMe ?? false, ts: o.ts ?? '2026-10-19T07:00:00.000Z', text: `${SECRET} ${waId}`, quotedWaId: null, mediaType: null,
  });
}
const del = (body: unknown = { confirm: true }, code = 'SHA') => chatDeleteHandler(deps, CTX, code, body);
const page = async () => chatPage(db, sharma, clock.now());
const shown = async () => (await page()).messages.map((m) => m.text.replace(`${SECRET} `, ''));
const errorOf = (r: { body: unknown }) => (r.body as { error: { code: string } }).error;
const stateOf = (r: { body: unknown }) => r.body as { state: string; code: string | null };

describe('Delete chat', () => {
  it('deletes the chat on WhatsApp up to its newest stored message, hides it here, and keeps every saved message', async () => {
    await say('M1', { ts: '2026-10-19T07:00:00.000Z' });
    await say('M2', { ts: '2026-10-19T07:05:30.500Z' });
    await say('M3', { ts: '2026-10-19T07:05:30.500Z', fromMe: true }); // same time: the later row is the newer
    const r = await del();
    expect(r.status).toBe(200);
    expect(stateOf(r)).toEqual({ state: 'deleted', code: null });
    expect(sock.calls).toHaveLength(1);
    expect(sock.calls[0]!.jid).toBe(SHARMA.groupId);
    expect(sock.calls[0]!.mod).toEqual({ delete: true, lastMessages: [{ key: { remoteJid: SHARMA.groupId, id: 'M3', fromMe: true }, messageTimestamp: Math.floor(Date.parse('2026-10-19T07:05:30.500Z') / 1000) }] });
    expect(await shown()).toEqual([]);
    expect((await page()).cleared).toBe(true);
    expect((await row<{ n: number }>(db, 'SELECT count(*) AS n FROM messages WHERE client_id = ?', [sharma.id]))!.n).toBe(3); // saved messages stay
    expect(audits).toEqual([{ actor: CTX.actor, kind: 'ops', requestId: CTX.requestId, event: 'Chat deleted · Sharma Interiors (SHA)', detail: 'on the phone and here; the saved messages stay' }]);
  });

  it('a new message in the group brings the chat back, with only what came after', async () => {
    await say('M1');
    await del();
    await say('M2', { ts: '2026-10-19T08:00:00.000Z' });
    expect(await shown()).toEqual(['M2']);
    expect((await page()).cleared).toBe(false);
  });

  it('hides the dashboard’s own messages sent before it too', async () => {
    await say('M1');
    await claimOutbox(db, { uuid: '00000000-0000-4000-8000-000000000001', clientId: sharma.id, text: 'sent from here', replyTo: null, actor: CTX.actor, at: clock.now().toISOString() });
    expect((await page()).outbox).toHaveLength(1);
    clock.advance(1_000);
    await del();
    expect((await page()).outbox).toEqual([]);
  });

  it('only this group: another client’s chat stays as it was', async () => {
    const mehta = (await getClientByCode(db, 'MEH'))!;
    await say('M1');
    await say('X1', { client: mehta });
    await del();
    expect((await chatPage(db, mehta, clock.now())).messages).toHaveLength(1);
  });

  it('a second delete with nothing new asks WhatsApp nothing; with something new, after a minute, it deletes again', async () => {
    await say('M1');
    await del();
    expect(stateOf(await del())).toEqual({ state: 'deleted', code: null });
    expect(sock.calls).toHaveLength(1);
    await say('M2', { ts: '2026-10-19T08:00:00.000Z' });
    const soon = await del();
    expect(soon.status).toBe(429); // one delete a minute per group: a guard against a double tap
    expect(errorOf(soon).code).toBe('rate_limited');
    clock.advance(60_000);
    expect(stateOf(await del())).toEqual({ state: 'deleted', code: null });
    expect(sock.calls).toHaveLength(2);
    expect(sock.calls[1]!.mod.lastMessages[0]!.key.id).toBe('M2');
  });

  it('two deletes at once ask WhatsApp once: the second is told one is in progress', async () => {
    await say('M1');
    sock.mode = 'hang';
    const first = del();
    while (sock.calls.length === 0) await new Promise((r) => setTimeout(r, 1));
    const second = await del();
    expect(second.status).toBe(409);
    expect(errorOf(second).code).toBe('delete_in_progress');
    sock.release?.();
    await first;
    expect(sock.calls).toHaveLength(1);
  });

  it('logs before WhatsApp is asked, and never a message’s text or a number', async () => {
    await say('M1');
    await del();
    const asking = logLines.findIndex((l) => l.includes('dashboard delete: asking WhatsApp'));
    expect(asking).toBeGreaterThan(-1);
    expect(sock.calls[0]!.logsBefore).toBeGreaterThan(asking);
    const said = JSON.stringify([audits, logLines]);
    expect(said).not.toContain(SECRET);
    expect(said).not.toMatch(/9198000000|@s\.whatsapp|@g\.us/);
  });
});

describe('Delete chat: when it does not run', () => {
  it('is refused without the confirm, for a client that is not approved here, and with no stored message', async () => {
    await say('M1');
    const cases: [unknown, string][] = [[{}, 'not_confirmed'], [{ confirm: false }, 'not_confirmed'], [null, 'not_confirmed'], [{ confirm: true, extra: 1 }, 'invalid']];
    for (const [body, code] of cases) expect(errorOf(await del(body)).code, JSON.stringify(body)).toBe(code);
    for (const code of ['ZZZ', 'sha', '']) expect((await del({ confirm: true }, code)).status).toBe(404);
    deps.configs = () => [MEHTA];
    expect((await del()).status).toBe(404);
    deps.configs = () => [SHARMA, MEHTA];
    const empty = await del({ confirm: true }, 'MEH');
    expect(empty.status).toBe(409);
    expect(errorOf(empty).code).toBe('nothing_to_delete');
    expect(sock.calls).toEqual([]);
  });

  it('without the delete wired in (until the per-phone wiring lands), it answers delete_unavailable and runs nothing', async () => {
    await say('M1');
    delete deps.chatDeleteSocket;
    const r = await del();
    expect(r.status).toBe(409);
    expect(errorOf(r).code).toBe('delete_unavailable');
    expect(await shown()).toEqual(['M1']);
    expect(audits).toEqual([]);
  });

  it('not connected: surely not done, nothing is hidden, and it can be tried again at once', async () => {
    await say('M1');
    open = false;
    expect(stateOf(await del())).toEqual({ state: 'failed', code: 'whatsapp_not_connected' });
    expect(await shown()).toEqual(['M1']);
    expect(audits[0]!.event).toBe('Chat not deleted · Sharma Interiors (SHA)');
    open = true;
    expect(stateOf(await del())).toEqual({ state: 'deleted', code: null });
  });

  it('no clear answer: hidden here, and the owner is told to check the phone; never asked again', async () => {
    await say('M1');
    sock.mode = 'throw';
    expect(stateOf(await del())).toEqual({ state: 'unknown', code: 'delete_error' });
    expect(await shown()).toEqual([]);
    expect(audits[0]!.event).toBe('Chat delete may not have reached the phone · Sharma Interiors (SHA)');
    expect(stateOf(await del())).toEqual({ state: 'unknown', code: 'delete_error' }); // nothing new: not asked again
    expect(sock.calls).toHaveLength(1);
  });
});
