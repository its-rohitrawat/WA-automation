import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { proto, WAMessageStubType, type WAMessageUpdate } from 'baileys';
import { AllowList } from '../../src/wa/allowlist.ts';
import { openSessionDb, useEncryptedAuthState } from '../../src/wa/authState.ts';
import { WhatsAppGateway } from '../../src/wa/gateway.ts';
import type { NormalizedEvent } from '../../src/wa/normalize.ts';
import { OTHER_GROUP, SHARMA } from '../helpers/db.ts';
import { closeWith, FakeSocket, SEND_METHODS } from '../helpers/fakeSocket.ts';
import { RAHUL_LID, waText } from '../helpers/wa.ts';

const PERSONAL_CHAT = '919811111111@s.whatsapp.net';

function setup(allowIds: string[] = [SHARMA.groupId]) {
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
    saveCreds: auth.saveCreds,
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
