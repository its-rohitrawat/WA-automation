import { beforeEach, describe, expect, it } from 'vitest';
import { chatPage, noteReadingPhoneChange } from '../../../src/control/chatQueries.ts';
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

/** The group's phone's own account, as Baileys gives it (with a device part). Its own stored messages have fromMe. */
const OWN = '919800000099:12@s.whatsapp.net';

/** Records each delete, and how many log lines there were when WhatsApp was asked; answers as told. */
class FakeDeleteSocket implements ChatDeleteSocket {
  user: ChatDeleteSocket['user'] = { id: OWN };
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

async function say(waId: string, o: { ts?: string; fromMe?: boolean; client?: ClientRow; sender?: string } = {}) {
  await insertMessage(db, {
    waId, clientId: (o.client ?? sharma).id, senderJid: o.sender ?? (o.fromMe ? 'self' : '919800000001@s.whatsapp.net'), senderNumber: null, senderName: null,
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

  it('no clear answer: hidden here, and the owner is told to check the phone; they can try again a minute later (final review, item 5)', async () => {
    await say('M1');
    sock.mode = 'throw';
    expect(stateOf(await del())).toEqual({ state: 'unknown', code: 'delete_error' });
    expect(await shown()).toEqual([]);
    expect(audits[0]!.event).toBe('Chat delete may not have reached the phone · Sharma Interiors (SHA)');
    const soon = await del(); // nothing new, still a minute apart
    expect(soon.status).toBe(429);
    expect(sock.calls).toHaveLength(1);
    clock.advance(60_000);
    sock.mode = 'ok';
    expect(stateOf(await del())).toEqual({ state: 'deleted', code: null }); // asked again, up to the same message
    expect(sock.calls.map((c) => c.mod.lastMessages[0]!.key.id)).toEqual(['M1', 'M1']);
    expect(stateOf(await del())).toEqual({ state: 'deleted', code: null }); // deleted, nothing new: not asked again
    expect(sock.calls).toHaveLength(2);
  });

  it('a delete that never finished (the service stopped) can be asked again once it counts as unknown', async () => {
    await say('M1');
    sock.mode = 'hang';
    const first = del();
    while (sock.calls.length === 0) await new Promise((r) => setTimeout(r, 1));
    clock.advance(90_000);
    sock.mode = 'ok';
    expect(stateOf(await del())).toEqual({ state: 'deleted', code: null });
    expect(sock.calls).toHaveLength(2);
    sock.release?.();
    await first;
  });

  it('the outcome cannot be recorded here: still answered and audited, and logged (final review, N2)', async () => {
    await say('M1');
    const real = db;
    // As the database failing just after WhatsApp answered: every write of the mark from then on fails.
    deps.db = new Proxy(real, {
      get(target, p) {
        const v = Reflect.get(target, p, target) as unknown;
        if (p === 'run') {
          return async (sql: string, params?: unknown) => {
            if (/\bkv\b/.test(sql) && sock.calls.length > 0) throw new Error(`disk I/O error ${SECRET}`);
            return (v as (s: string, x?: unknown) => Promise<unknown>).call(target, sql, params);
          };
        }
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const r = await del();
    expect(r.status).toBe(200);
    expect(stateOf(r)).toEqual({ state: 'deleted', code: null });
    expect(audits.map((a) => a.event)).toEqual(['Chat deleted · Sharma Interiors (SHA)']);
    expect(logLines.some((l) => l.includes('dashboard delete: its outcome could not be recorded') && l.includes('"outcome":"deleted"'))).toBe(true);
    expect(JSON.stringify(logLines)).not.toContain(SECRET);
    expect(await shown()).toEqual([]); // the mark stays "asking": still hidden
  });
});

describe('Delete chat: what shows after it (final review, item 1)', () => {
  it('a message stored after it shows and brings the chat back, even with an earlier WhatsApp time (written while offline)', async () => {
    await say('M1', { ts: '2026-10-19T07:00:00.000Z' });
    await say('M2', { ts: '2026-10-19T07:10:00.000Z' });
    await del();
    expect((await page()).cleared).toBe(true);
    await say('LATE', { ts: '2026-10-19T07:05:00.000Z' }); // sent before M2, stored after the press
    expect(await shown()).toEqual(['LATE']);
    expect((await page()).cleared).toBe(false);
    // It is something new: after a minute the chat can be deleted again, and LATE is hidden with it.
    clock.advance(60_000);
    expect(stateOf(await del())).toEqual({ state: 'deleted', code: null });
    expect(sock.calls).toHaveLength(2);
    expect(await shown()).toEqual([]);
  });

  it('history read later (older than everything the chat had at the press) stays hidden, and is nothing new', async () => {
    await say('M1', { ts: '2026-10-19T07:00:00.000Z' });
    await say('M2', { ts: '2026-10-19T07:10:00.000Z' });
    await del();
    await say('OLD', { ts: '2026-10-18T09:00:00.000Z' }); // as the 7-day backfill stores it: older than M1
    expect(await shown()).toEqual([]);
    expect((await page()).cleared).toBe(true);
    clock.advance(60_000);
    expect(stateOf(await del())).toEqual({ state: 'deleted', code: null });
    expect(sock.calls).toHaveLength(1); // nothing new: WhatsApp not asked again
  });
});

describe('Delete chat: the key as the group’s phone sees it (final review, item 2)', () => {
  it('the newest message is the phone’s own but was stored by another phone: asked with its own key, answered "check your phone"', async () => {
    await say('M1', { sender: '919800000099@s.whatsapp.net' }); // the phone's own number, stored as a member's
    expect(stateOf(await del())).toEqual({ state: 'unknown', code: 'check_phone' });
    expect(sock.calls[0]!.mod.lastMessages[0]!.key).toEqual({ remoteJid: SHARMA.groupId, id: 'M1', fromMe: true });
    expect(await shown()).toEqual([]);
    expect(audits[0]!.event).toBe('Chat delete may not have reached the phone · Sharma Interiors (SHA)');
    expect(audits[0]!.detail).toBe('hidden here · check_phone');
  });

  it('an own message stored before the group changed phone is not sure; one stored after the change is', async () => {
    await say('M1', { fromMe: true });
    await noteReadingPhoneChange(db, sharma.id); // the group moved to this phone after M1
    expect(stateOf(await del())).toEqual({ state: 'unknown', code: 'check_phone' });
    clock.advance(60_000);
    await say('M2', { fromMe: true, ts: '2026-10-19T08:00:00.000Z' });
    expect(stateOf(await del())).toEqual({ state: 'deleted', code: null });
    expect(sock.calls[1]!.mod.lastMessages[0]!.key).toEqual({ remoteJid: SHARMA.groupId, id: 'M2', fromMe: true });
  });

  it('without the phone’s own account the key cannot be checked: "check your phone"', async () => {
    await say('M1');
    sock.user = undefined;
    expect(stateOf(await del())).toEqual({ state: 'unknown', code: 'check_phone' });
  });
});
