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

async function setup() {
  const db = await seededDb();
  await createTask(
    db,
    {
      clientId: 1, side: 'us', title: 'Send the moodboard', category: 'design', priority: 'major', assignedTo: 'Ravi', askedBy: null, raisedOn: '2026-10-20',
      deadline: '2026-10-25', latestProgress: null, sourceQuote: QUOTE, sourceDate: '2026-10-20', sourceWaId: 'W1', origin: 'whatsapp',
    },
    '2026-10-20T05:00:00.000Z',
  );
  await insertMessage(db, {
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
    const { deps, src } = await setup();
    const before = await clientsListHandler(deps, CTX);
    expect(before.status).toBe(200);
    const cards = (before.body as { clients: { code: string; groupName: string; counts: unknown }[] }).clients;
    expect(cards.map((c) => c.code)).toEqual(['MEH', 'SHA']);
    expect(cards[1]).toMatchObject({ groupName: 'Sharma Interiors', counts: { open: 1, overdue: 1, review: 0, doneThisWeek: 0 } });
    expect(src.calls).toBe(0);

    await deps.directory.list();
    const after = ((await clientsListHandler(deps, CTX)).body as { clients: { code: string; groupName: string }[] }).clients;
    expect(after.find((c) => c.code === 'SHA')!.groupName).toBe('Sharma x Studio');
    expect(src.calls).toBe(1);
  });
});

describe('clientDetailHandler', () => {
  it('gives the client drawer; its counts match the card', async () => {
    const { deps } = await setup();
    const r = await clientDetailHandler(deps, CTX, 'SHA');
    expect(r.status).toBe(200);
    const d = (r.body as { client: { counts: unknown; openTasks: unknown[] } }).client;
    const card = ((await clientsListHandler(deps, CTX)).body as { clients: { code: string; counts: unknown }[] }).clients.find((c) => c.code === 'SHA')!;
    expect(d.counts).toEqual(card.counts);
    expect(d.openTasks).toEqual([{ code: 'SHA-001', title: 'Send the moodboard', assignedTo: 'Ravi', deadline: '2026-10-25', status: 'open', priority: 'major', sentiment: null }]);
  });

  it('sends moods, the task\'s and the client\'s, only while sentiment is switched on', async () => {
    const { deps } = await setup();
    const db = deps.db;
    db.raw.prepare("UPDATE tasks SET sentiment = 'frustrated' WHERE code = 'SHA-001'").run();
    db.raw.prepare("UPDATE clients SET sentiment = 'negative', sentiment_at = '2026-10-19T08:00:00.000Z' WHERE code = 'SHA'").run();
    const detail = async () => ((await clientDetailHandler(deps, CTX, 'SHA')).body as { client: { sentiment: unknown; openTasks: { sentiment: unknown }[] } }).client;
    expect((await detail()).sentiment).toBeNull();
    expect((await detail()).openTasks[0]!.sentiment).toBeNull();
    db.raw.prepare("INSERT INTO settings (k, v, updated_at, updated_by) VALUES ('sentimentEnabled', 'true', '2026-10-19T08:00:00.000Z', 'o')").run();
    expect((await detail()).sentiment).toEqual({ mood: 'negative', at: '2026-10-19T08:00:00.000Z' });
    expect((await detail()).openTasks[0]!.sentiment).toBe('frustrated');
  });

  it('an unknown or malformed code gives 404 not_found', async () => {
    const { deps } = await setup();
    for (const code of ['ZZZ', 'sha', '', 'SHA-001', "SHA' OR 1=1"]) {
      const r = await clientDetailHandler(deps, CTX, code);
      expect(r.status).toBe(404);
      expect((r.body as { error: { code: string } }).error.code).toBe('not_found');
    }
  });

  it('no response carries quotes, phone numbers or WhatsApp ids; message text only in the drawer latest messages', async () => {
    const { deps } = await setup();
    const list = await clientsListHandler(deps, CTX);
    const detail = await clientDetailHandler(deps, CTX, 'SHA');
    const all = JSON.stringify([list, detail, await clientDetailHandler(deps, CTX, 'MEH')]);
    for (const s of [QUOTE, '919800000001', '@s.whatsapp.net']) expect(all).not.toContain(s);
    expect(JSON.stringify(list)).not.toContain(MESSAGE);
    // The owner chose to see the group's last three messages in the drawer (28 Oct 2026): there, and nowhere else.
    const { activity, ...rest } = (detail.body as { client: { activity: { latest: { text: string }[] } } }).client;
    expect(activity.latest.map((m) => m.text)).toContain(MESSAGE);
    expect(JSON.stringify(rest)).not.toContain(MESSAGE);
  });
});
