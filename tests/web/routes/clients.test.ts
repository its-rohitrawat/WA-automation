import { describe, expect, it } from 'vitest';
import { GroupDirectory, type GroupSource } from '../../../src/control/groups.ts';
import { insertMessage } from '../../../src/store/messages.ts';
import { createTask } from '../../../src/store/tasks.ts';
import { manualClock } from '../../../src/util/clock.ts';
import type { GatewayState } from '../../../src/wa/gateway.ts';
import { clientDetailHandler, clientsListHandler, type ClientsDeps } from '../../../src/web/routes/clients.ts';
import type { OwnerContext } from '../../../src/web/routes/context.ts';
import { seededDb, SHARMA } from '../../helpers/db.ts';

const CTX: OwnerContext = { actor: 'owner@example.com', sessionId: 'session-hash', requestId: 'a1b2c3d4e5f6' };
const MESSAGE = 'MESSAGE-TEXT-never-sent';
const QUOTE = 'QUOTE-TEXT-never-sent';

class FakeSource implements GroupSource {
  state: GatewayState = 'open';
  calls = 0;
  status() {
    return { state: this.state };
  }
  async listGroups() {
    this.calls++;
    return [{ id: SHARMA.groupId, subject: 'Sharma x Studio' }];
  }
}

function setup() {
  const db = seededDb();
  createTask(
    db,
    {
      clientId: 1, side: 'us', title: 'Send the moodboard', category: 'design', priority: 'high', assignedTo: 'Ravi', askedBy: null, raisedOn: '2026-10-20',
      deadline: '2026-10-25', latestProgress: null, sourceQuote: QUOTE, sourceDate: '2026-10-20', sourceWaId: 'W1', origin: 'whatsapp',
    },
    '2026-10-20T05:00:00.000Z',
  );
  insertMessage(db, {
    waId: 'M1', clientId: 1, senderJid: '919800000001@s.whatsapp.net', senderNumber: '919800000001', senderName: 'Sender', fromMe: false,
    ts: '2026-10-27T05:00:00.000Z', text: MESSAGE, quotedWaId: null, mediaType: null,
  });
  const src = new FakeSource();
  const clock = manualClock('2026-10-27T08:00:00.000Z');
  const deps: ClientsDeps = { db, directory: new GroupDirectory({ gateway: src, clock }), clock };
  return { db, src, deps };
}

describe('clientsListHandler', () => {
  it('lists the active clients with their counts; the group name comes from the last list without asking WhatsApp', async () => {
    const { deps, src } = setup();
    const before = clientsListHandler(deps, CTX);
    expect(before.status).toBe(200);
    const cards = (before.body as { clients: { code: string; groupName: string; counts: unknown }[] }).clients;
    expect(cards.map((c) => c.code)).toEqual(['MEH', 'SHA']);
    expect(cards[1]).toMatchObject({ groupName: 'Sharma Interiors', counts: { open: 1, overdue: 1, review: 0, doneThisWeek: 0 } });
    expect(src.calls).toBe(0);

    await deps.directory.list();
    const after = (clientsListHandler(deps, CTX).body as { clients: { code: string; groupName: string }[] }).clients;
    expect(after.find((c) => c.code === 'SHA')!.groupName).toBe('Sharma x Studio');
    expect(src.calls).toBe(1);
  });
});

describe('clientDetailHandler', () => {
  it('gives the client drawer; its counts match the card', () => {
    const { deps } = setup();
    const r = clientDetailHandler(deps, CTX, 'SHA');
    expect(r.status).toBe(200);
    const d = (r.body as { client: { counts: unknown; openTasks: unknown[] } }).client;
    const card = (clientsListHandler(deps, CTX).body as { clients: { code: string; counts: unknown }[] }).clients.find((c) => c.code === 'SHA')!;
    expect(d.counts).toEqual(card.counts);
    expect(d.openTasks).toEqual([{ code: 'SHA-001', title: 'Send the moodboard', assignedTo: 'Ravi', deadline: '2026-10-25', status: 'open' }]);
  });

  it('an unknown or malformed code gives 404 not_found', () => {
    const { deps } = setup();
    for (const code of ['ZZZ', 'sha', '', 'SHA-001', "SHA' OR 1=1"]) {
      const r = clientDetailHandler(deps, CTX, code);
      expect(r.status).toBe(404);
      expect((r.body as { error: { code: string } }).error.code).toBe('not_found');
    }
  });

  it('no response carries message text, quotes or phone numbers', () => {
    const { deps } = setup();
    const all = JSON.stringify([clientsListHandler(deps, CTX), clientDetailHandler(deps, CTX, 'SHA'), clientDetailHandler(deps, CTX, 'MEH')]);
    for (const s of [MESSAGE, QUOTE, '919800000001']) expect(all).not.toContain(s);
  });
});
