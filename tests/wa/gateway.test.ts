import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { proto, WAMessageStubType, type WAMessageUpdate } from 'baileys';
import { AllowList } from '../../src/wa/allowlist.ts';
import { openSessionDb, useEncryptedAuthState } from '../../src/wa/authState.ts';
import { WhatsAppGateway } from '../../src/wa/gateway.ts';
import type { NormalizedEvent } from '../../src/wa/normalize.ts';
import { OTHER_GROUP, SHARMA } from '../helpers/db.ts';
import { closeWith, FakeSocket, SEND_METHODS } from '../helpers/fakeSocket.ts';
import { RAHUL_LID, waText } from '../helpers/wa.ts';

const PERSONAL_CHAT = '919811111111@s.whatsapp.net';

function setup(allowIds: string[] = [SHARMA.groupId], saveCreds?: () => Promise<void>) {
  const sockets: FakeSocket[] = [];
  const scheduled: { fn: () => void; ms: number }[] = [];
  const qr: string[] = [];
  const auth = useEncryptedAuthState(openSessionDb(':memory:'), randomBytes(32));
  const gw = new WhatsAppGateway({
    allow: new AllowList(allowIds),
    factory: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    auth: auth.state,
    saveCreds: saveCreds ?? auth.saveCreds,
    scheduler: (fn, ms) => {
      scheduled.push({ fn, ms });
      return { cancel: () => {} };
    },
    onQr: (q) => qr.push(q),
  });
  const events: NormalizedEvent[] = [];
  gw.onEvent((e) => events.push(e));
  gw.start();
  return { gw, sockets, sock: sockets[0]!, scheduled, events, qr };
}

describe('WhatsAppGateway privacy', () => {
  it('passes through messages from allowed groups', () => {
    const { sock, events } = setup();
    sock.emit('messages.upsert', { type: 'notify', messages: [waText('m1', 'hello')] });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'message', waId: 'm1' });
  });

  it('drops other groups and personal chats before reading them', () => {
    const { gw, sock, events } = setup();
    sock.emit('messages.upsert', {
      type: 'notify',
      messages: [waText('x1', 'secret family plan', { group: OTHER_GROUP }), waText('p1', 'personal', { group: PERSONAL_CHAT })],
    });
    expect(events).toEqual([]);
    expect(gw.droppedCount()).toBe(2);
  });

  it('applies the allow-list to history sync, edits, revokes and reactions', () => {
    const { sock, events } = setup();
    sock.emit('messaging-history.set', { chats: [], contacts: [], isLatest: true, messages: [waText('h1', 'old allowed'), waText('h2', 'old other', { group: OTHER_GROUP })] });
    sock.emit('messages.update', [
      { key: { remoteJid: OTHER_GROUP, id: 'x1' }, update: { message: { editedMessage: { message: { conversation: 'edited' } } } } } as WAMessageUpdate,
      { key: { remoteJid: OTHER_GROUP, id: 'x2' }, update: { messageStubType: WAMessageStubType.REVOKE } } as WAMessageUpdate,
    ]);
    sock.emit('messages.reaction', [
      { key: { remoteJid: OTHER_GROUP, id: 'x1' }, reaction: { key: { remoteJid: OTHER_GROUP, participant: RAHUL_LID } as proto.IMessageKey, text: '✅' } },
    ]);
    expect(events.map((e) => (e.kind === 'message' ? e.waId : e.kind))).toEqual(['h1']);
  });

  it('never calls a send-type socket method', () => {
    const { sock } = setup();
    sock.emit('connection.update', { connection: 'open' });
    sock.emit('messages.upsert', { type: 'notify', messages: [waText('m1', 'hello'), waText('x1', 'other', { group: OTHER_GROUP })] });
    for (const name of SEND_METHODS) expect(sock[name]).not.toHaveBeenCalled();
  });

  it('exposes no send-type methods', () => {
    const names = Object.getOwnPropertyNames(WhatsAppGateway.prototype);
    expect(names.filter((n) => /send|read|presence|react|receipt|chatmodify|delete/i.test(n))).toEqual([]);
  });
});

describe('WhatsAppGateway connection', () => {
  it('reports QR codes and the open state', () => {
    const { gw, sock, qr } = setup();
    sock.emit('connection.update', { qr: 'QR-1' });
    sock.emit('connection.update', { connection: 'open' });
    expect(qr).toEqual(['QR-1']);
    expect(gw.status().state).toBe('open');
  });

  it('reconnects with backoff after an ordinary disconnect', () => {
    const { gw, sock, sockets, scheduled } = setup();
    closeWith(sock, 428);
    expect(gw.status()).toMatchObject({ state: 'closed', lastErrorCode: 428 });
    expect(scheduled[0]!.ms).toBeGreaterThanOrEqual(4_000);
    scheduled[0]!.fn();
    expect(sockets).toHaveLength(2);
  });

  it('reconnects at once when WhatsApp asks for a restart after linking', () => {
    const { sock, scheduled } = setup();
    closeWith(sock, 515);
    expect(scheduled[0]!.ms).toBe(0);
  });

  it('stops when WhatsApp logs the device out', () => {
    const { gw, sock, scheduled } = setup();
    closeWith(sock, 401);
    expect(gw.status().state).toBe('logged_out');
    expect(scheduled).toEqual([]);
  });

  it('lists group names only while connected', async () => {
    const { gw, sock } = setup();
    await expect(gw.listGroups()).rejects.toThrowError(/not connected/);
    sock.emit('connection.update', { connection: 'open' });
    expect((await gw.listGroups()).map((g) => g.subject)).toEqual(['Family', 'Sharma Interiors x Studio']);
  });
});

describe('WhatsAppGateway lifecycle hardening', () => {
  it('does not reconnect when stop() is called from a status listener', () => {
    const { gw, sock, sockets, scheduled } = setup();
    gw.onStatus((st) => {
      if (st.state === 'closed') void gw.stop();
    });
    closeWith(sock, 428);
    expect(sockets).toHaveLength(1);
    expect(scheduled).toEqual([]);
    expect(gw.status().state).toBe('stopped');
  });

  it('start() twice creates one socket', () => {
    const { gw, sockets } = setup();
    gw.start();
    expect(sockets).toHaveLength(1);
  });

  it('reconnects at once for the first 515 only', () => {
    const { sock, sockets, scheduled } = setup();
    closeWith(sock, 515);
    expect(scheduled[0]!.ms).toBe(0);
    scheduled[0]!.fn();
    closeWith(sockets[1]!, 515);
    expect(scheduled[1]!.ms).toBeGreaterThanOrEqual(4_000);
  });

  it('keeps delivering the rest of a batch when a listener throws', () => {
    const { gw, sock } = setup();
    const seen: string[] = [];
    gw.onEvent((e) => {
      if (e.kind !== 'message') return;
      if (e.waId === 'a1') throw new Error('boom');
      seen.push(e.waId);
    });
    sock.emit('messages.upsert', { type: 'notify', messages: [waText('a1', 'one'), waText('a2', 'two')] });
    expect(seen).toEqual(['a2']);
    expect(gw.failedCount()).toBe(1);
  });

  it('survives a rejecting saveCreds and counts the failure', async () => {
    const { gw, sock } = setup([SHARMA.groupId], () => Promise.reject(new Error('disk')));
    expect(() => sock.emit('creds.update', {})).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(gw.status().credsSaveFailures).toBe(1);
  });

  it.each([
    [440, 'replaced'],
    [403, 'forbidden'],
  ])('treats %i as terminal (%s) with no reconnect', (code, state) => {
    const { gw, sock, scheduled } = setup();
    closeWith(sock, code);
    expect(gw.status().state).toBe(state);
    expect(scheduled).toEqual([]);
  });

  it('keeps the last error code while reconnecting', () => {
    const { gw, sock, scheduled } = setup();
    closeWith(sock, 428);
    scheduled[0]!.fn();
    expect(gw.status()).toMatchObject({ state: 'connecting', lastErrorCode: 428 });
  });

  it('emits nothing after stop()', async () => {
    const { gw, sock, events } = setup();
    await gw.stop();
    sock.emit('messages.upsert', { type: 'notify', messages: [waText('m1', 'hello')] });
    expect(events).toEqual([]);
  });

  it('resets backoff only after the connection stayed open', () => {
    const { sock, sockets, scheduled } = setup();
    closeWith(sock, 428);
    scheduled[0]!.fn();
    sockets[1]!.emit('connection.update', { connection: 'open' });
    expect(scheduled[1]!.ms).toBe(60_000);
    closeWith(sockets[1]!, 428); // dropped before 60 s: keeps backing off
    expect(scheduled[2]!.ms).toBeGreaterThanOrEqual(8_000);
  });
});

describe('WhatsAppGateway allowed non-message events', () => {
  it('passes edits, revokes and reactions from an allowed group', () => {
    const { gw, sock, events } = setup();
    sock.emit('messages.update', [
      { key: { remoteJid: SHARMA.groupId, id: 'e1' }, update: { message: { editedMessage: { message: { conversation: 'edited' } } } } } as WAMessageUpdate,
      { key: { remoteJid: SHARMA.groupId, id: 'r1' }, update: { messageStubType: WAMessageStubType.REVOKE } } as WAMessageUpdate,
    ]);
    sock.emit('messages.reaction', [
      { key: { remoteJid: SHARMA.groupId, id: 'e1' }, reaction: { key: { remoteJid: SHARMA.groupId, participant: RAHUL_LID } as proto.IMessageKey, text: '👍' } },
    ]);
    expect(events.map((e) => e.kind)).toEqual(['edit', 'revoke', 'reaction']);
    expect(gw.droppedCount()).toBe(0);
  });

  it('drops a non-allowed message without reading its content', () => {
    const { gw, sock, events } = setup();
    const getter = vi.fn(() => {
      throw new Error('content was read');
    });
    const msg = { key: { remoteJid: OTHER_GROUP, id: 'x1', fromMe: false } } as ReturnType<typeof waText>;
    Object.defineProperty(msg, 'message', { get: getter, enumerable: true });
    sock.emit('messages.upsert', { type: 'notify', messages: [msg] });
    expect(getter).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(gw.droppedCount()).toBe(1);
  });
});

describe('WhatsAppGateway restart throttling and re-entrancy', () => {
  it('throttles a 515 that follows each open', () => {
    const { sock, sockets, scheduled } = setup();
    sock.emit('connection.update', { connection: 'open' });
    closeWith(sock, 515);
    const first = scheduled.find((s) => s.ms !== 60_000)!;
    expect(first.ms).toBe(0);
    first.fn();
    sockets[1]!.emit('connection.update', { connection: 'open' });
    closeWith(sockets[1]!, 515);
    expect(scheduled[scheduled.length - 1]!.ms).toBeGreaterThanOrEqual(4_000);
  });

  it('allows an immediate restart again after the stable period', () => {
    const { sock, sockets, scheduled } = setup();
    sock.emit('connection.update', { connection: 'open' });
    scheduled[0]!.fn(); // stable timer fires
    closeWith(sock, 515);
    expect(scheduled[scheduled.length - 1]!.ms).toBe(0);
    expect(sockets).toHaveLength(1);
  });

  it('leaves one live socket when a listener calls start() re-entrantly', async () => {
    const { gw, sock, sockets, scheduled } = setup();
    gw.onStatus((st) => {
      if (st.state === 'closed' || st.state === 'connecting') gw.start();
    });
    closeWith(sock, 428);
    expect(sockets).toHaveLength(2);
    expect(scheduled).toEqual([]);
    await gw.stop();
    expect(sockets.map((s) => s.end.mock.calls.length)).toEqual([0, 1]);
  });

  it('re-emits status when saving credentials fails', async () => {
    const { gw, sock } = setup([SHARMA.groupId], () => Promise.reject(new Error('disk')));
    const counts: number[] = [];
    gw.onStatus((st) => counts.push(st.credsSaveFailures));
    sock.emit('creds.update', {});
    await Promise.resolve();
    await Promise.resolve();
    expect(counts).toEqual([1]);
  });
});
