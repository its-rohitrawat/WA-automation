import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AllowList } from '../../src/wa/allowlist.ts';
import { openSessionDb, useEncryptedAuthState } from '../../src/wa/authState.ts';
import { WhatsAppGateway } from '../../src/wa/gateway.ts';
import { SwitchableGateway } from '../../src/wa/switchableGateway.ts';
import { SHARMA } from '../helpers/db.ts';
import { FakeSocket } from '../helpers/fakeSocket.ts';
import { waText } from '../helpers/wa.ts';

// SaaS S1.10: the ingest awaits the database, so a gateway hands events over one after another, in arrival order: each
// handler's promise is awaited before the next event. A synchronous handler still gets each event at once.

async function setup() {
  const sockets: FakeSocket[] = [];
  const auth = await useEncryptedAuthState(openSessionDb(':memory:'), randomBytes(32));
  const gw = new WhatsAppGateway({
    allow: new AllowList([SHARMA.groupId]),
    factory: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    auth: auth.state,
    saveCreds: auth.saveCreds,
    scheduler: () => ({ cancel: () => {} }),
  });
  gw.start();
  return { gw, sock: sockets[0]! };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('event order (S1.10)', () => {
  it('hands one gateway\'s events over one after another, in arrival order, even when each handler awaits', async () => {
    const { gw, sock } = await setup();
    const seen: string[] = [];
    gw.onEvent(async (e) => {
      if (e.kind !== 'message') return;
      await sleep(e.waId === 'A' ? 20 : 0); // the first is the slowest
      seen.push(e.waId);
    });
    sock.emit('messages.upsert', { type: 'notify', messages: [waText('A', 'one'), waText('B', 'two')] });
    sock.emit('messages.upsert', { type: 'notify', messages: [waText('C', 'three')] }); // a later batch waits too
    await gw.idle();
    expect(seen).toEqual(['A', 'B', 'C']);
  });

  it('gives a synchronous handler each event at once', async () => {
    const { gw, sock } = await setup();
    const seen: string[] = [];
    gw.onEvent((e) => {
      if (e.kind === 'message') seen.push(e.waId);
    });
    sock.emit('messages.upsert', { type: 'notify', messages: [waText('A', 'one'), waText('B', 'two')] });
    expect(seen).toEqual(['A', 'B']);
  });

  it('counts a handler that rejects as a failed event, and goes on with the next one', async () => {
    const { gw, sock } = await setup();
    const seen: string[] = [];
    gw.onEvent(async (e) => {
      if (e.kind !== 'message') return;
      await sleep(0);
      if (e.waId === 'A') throw new Error('ingest failed');
      seen.push(e.waId);
    });
    sock.emit('messages.upsert', { type: 'notify', messages: [waText('A', 'one'), waText('B', 'two')] });
    await gw.idle();
    expect(seen).toEqual(['B']);
    expect(gw.failedCount()).toBe(1);
  });

  it('keeps the order through a SwitchableGateway, and idle() waits for its gateway', async () => {
    const { gw, sock } = await setup();
    const sw = new SwitchableGateway({ inner: gw });
    const seen: string[] = [];
    sw.onEvent(async (e) => {
      if (e.kind !== 'message') return;
      await sleep(e.waId === 'A' ? 20 : 0);
      seen.push(e.waId);
    });
    sock.emit('messages.upsert', { type: 'notify', messages: [waText('A', 'one'), waText('B', 'two'), waText('C', 'three')] });
    await sw.idle();
    expect(seen).toEqual(['A', 'B', 'C']);
  });
});
