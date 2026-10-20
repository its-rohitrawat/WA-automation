import { describe, expect, it } from 'vitest';
import { findPeopleByNumber, listPeople, setRole, upsertPerson } from '../../src/store/people.ts';
import { seededDb } from '../helpers/db.ts';

describe('people repository', () => {
  it('adds people as unknown and the founder as team', () => {
    const db = seededDb();
    upsertPerson(db, { clientId: 1, jid: 'a@s.whatsapp.net', number: '911', name: 'Mr. Sharma', fromMe: false });
    upsertPerson(db, { clientId: 1, jid: 'self@founder', number: null, name: 'Founder', fromMe: true });
    expect(listPeople(db, 1).map((p) => [p.name, p.role, p.roleSetBy])).toEqual([
      ['Mr. Sharma', 'unknown', 'ai'],
      ['Founder', 'team', 'system'],
    ]);
  });

  it('keeps a known name when a later event has none', () => {
    const db = seededDb();
    upsertPerson(db, { clientId: 1, jid: 'a@s.whatsapp.net', number: '911', name: 'Mr. Sharma', fromMe: false });
    upsertPerson(db, { clientId: 1, jid: 'a@s.whatsapp.net', number: null, name: null, fromMe: false });
    expect(listPeople(db, 1)[0]).toMatchObject({ name: 'Mr. Sharma', number: '911' });
  });

  it('sets roles and finds people by number', () => {
    const db = seededDb();
    upsertPerson(db, { clientId: 1, jid: 'a@s.whatsapp.net', number: '911', name: 'Rahul', fromMe: false });
    setRole(db, 1, 'a@s.whatsapp.net', 'team', 'human');
    expect(listPeople(db, 1)[0]).toMatchObject({ role: 'team', roleSetBy: 'human' });
    expect(findPeopleByNumber(db, '911')).toHaveLength(1);
  });
});
