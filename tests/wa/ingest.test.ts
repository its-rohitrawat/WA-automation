import { describe, expect, it, vi } from 'vitest';
import { syncClients } from '../../src/store/clients.ts';
import { listUnprocessed, reactionsFor } from '../../src/store/messages.ts';
import { listPeople } from '../../src/store/people.ts';
import { Ingestor } from '../../src/wa/ingest.ts';
import type { NormalizedEvent } from '../../src/wa/normalize.ts';
import { MEHTA, OTHER_GROUP, row, seeded, SHARMA } from '../helpers/db.ts';
import { RAHUL_PN, SHARMA_PN } from '../helpers/wa.ts';

const ts = new Date('2026-10-10T08:00:00Z');
const message = (o: Partial<Extract<NormalizedEvent, { kind: 'message' }>> = {}): NormalizedEvent => ({
  kind: 'message', groupId: SHARMA.groupId, waId: 'm1', senderJid: SHARMA_PN, senderNumber: '919800000001', senderName: 'Mr. Sharma',
  fromMe: false, ts, text: 'hello', quotedWaId: null, mediaType: null, ...o,
});

async function setup() {
  const { db, ids } = await seeded();
  const onNew = vi.fn();
  return { db, ids, onNew, ing: new Ingestor({ db, onNewMessages: onNew }) };
}

describe('Ingestor', () => {
  it('stores a new message, records the sender and signals once', async () => {
    const { db, ids, onNew, ing } = await setup();
    await ing.handle(message());
    await ing.handle(message());
    expect(await listUnprocessed(db, ids.sharma)).toHaveLength(1);
    expect((await listPeople(db, ids.sharma))[0]).toMatchObject({ jid: SHARMA_PN, name: 'Mr. Sharma', role: 'unknown' });
    expect(onNew).toHaveBeenCalledTimes(1);
    expect(onNew).toHaveBeenCalledWith(ids.sharma);
  });

  it('ignores groups that are not configured clients', async () => {
    const { db, onNew, ing } = await setup();
    await ing.handle(message({ groupId: OTHER_GROUP }));
    expect(await row(db, 'SELECT COUNT(*) AS n FROM messages')).toEqual({ n: 0 });
    expect(onNew).not.toHaveBeenCalled();
  });

  it('ignores clients that were removed from the allow-list', async () => {
    const { db, ing } = await setup();
    await syncClients(db, [MEHTA]);
    await ing.handle(message());
    expect(await row(db, 'SELECT COUNT(*) AS n FROM messages')).toEqual({ n: 0 });
  });

  it('applies edits, reactions and revokes', async () => {
    const { db, ids, onNew, ing } = await setup();
    await ing.handle(message());
    onNew.mockClear();
    await ing.handle({ kind: 'edit', groupId: SHARMA.groupId, waId: 'm1', text: 'hello again', ts });
    expect(onNew).toHaveBeenCalledTimes(1);
    await ing.handle({ kind: 'reaction', groupId: SHARMA.groupId, targetWaId: 'm1', reactorJid: RAHUL_PN, fromMe: false, emoji: '✅', ts });
    expect(await reactionsFor(db, ids.sharma, ['m1'])).toHaveLength(1);
    expect(onNew).toHaveBeenCalledTimes(2);
    await ing.handle({ kind: 'revoke', groupId: SHARMA.groupId, waId: 'm1', ts });
    expect(await listUnprocessed(db, ids.sharma)).toHaveLength(0);
  });
});
