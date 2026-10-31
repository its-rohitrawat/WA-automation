import { describe, expect, it } from 'vitest';
import { findPeopleByNumber, listPeople, setRole, upsertPerson } from '../../src/store/people.ts';
import { seeded } from '../helpers/db.ts';

describe('people repository', () => {
  it('adds people as unknown and the founder as team', async () => {
    const { db, ids } = await seeded();
    await upsertPerson(db, { clientId: ids.sharma, jid: 'a@s.whatsapp.net', number: '911', name: 'Mr. Sharma', fromMe: false });
    await upsertPerson(db, { clientId: ids.sharma, jid: 'self@founder', number: null, name: 'Founder', fromMe: true });
    expect((await listPeople(db, ids.sharma)).map((p) => [p.name, p.role, p.roleSetBy])).toEqual([
      ['Mr. Sharma', 'unknown', 'ai'],
      ['Founder', 'team', 'system'],
    ]);
  });

  it('keeps a known name when a later event has none', async () => {
    const { db, ids } = await seeded();
    await upsertPerson(db, { clientId: ids.sharma, jid: 'a@s.whatsapp.net', number: '911', name: 'Mr. Sharma', fromMe: false });
    await upsertPerson(db, { clientId: ids.sharma, jid: 'a@s.whatsapp.net', number: null, name: null, fromMe: false });
    expect((await listPeople(db, ids.sharma))[0]).toMatchObject({ name: 'Mr. Sharma', number: '911' });
  });

  it('sets roles and finds people by number', async () => {
    const { db, ids } = await seeded();
    await upsertPerson(db, { clientId: ids.sharma, jid: 'a@s.whatsapp.net', number: '911', name: 'Rahul', fromMe: false });
    await setRole(db, ids.sharma, 'a@s.whatsapp.net', 'team', 'human');
    expect((await listPeople(db, ids.sharma))[0]).toMatchObject({ role: 'team', roleSetBy: 'human' });
    expect(await findPeopleByNumber(db, '911')).toHaveLength(1);
  });
});
