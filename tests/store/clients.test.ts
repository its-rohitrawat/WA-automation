import { describe, expect, it } from 'vitest';
import { getClient, getClientByCode, getClientByGroupId, listClients, nextTaskCode, setPhase, setStatus, syncClients } from '../../src/store/clients.ts';
import { getKv, setKv } from '../../src/store/kv.ts';
import { MEHTA, NOW, SHARMA, seededDb } from '../helpers/db.ts';

describe('clients repository', () => {
  it('syncs clients from config', () => {
    const db = seededDb();
    expect(listClients(db).map((c) => c.code)).toEqual(['MEH', 'SHA']);
    expect(getClientByGroupId(db, SHARMA.groupId)).toMatchObject({
      id: 1, code: 'SHA', name: 'Sharma Interiors', phases: SHARMA.phases, currentPhase: null, phaseLocked: false, active: true,
    });
  });

  it('marks removed clients inactive but keeps their rows', () => {
    const db = seededDb();
    syncClients(db, [SHARMA]);
    expect(getClientByCode(db, 'MEH')?.active).toBe(false);
    expect(listClients(db).map((c) => c.code)).toEqual(['SHA']);
    expect(listClients(db, false)).toHaveLength(2);
  });

  it('updates a renamed client in place', () => {
    const db = seededDb();
    syncClients(db, [{ ...SHARMA, name: 'Sharma Interiors Pvt Ltd' }]);
    expect(getClient(db, 1).name).toBe('Sharma Interiors Pvt Ltd');
  });

  it('refuses to change a client code and writes nothing', () => {
    const db = seededDb();
    expect(() => syncClients(db, [{ ...SHARMA, code: 'SHX' }])).toThrow(/permanent/);
    expect(getClient(db, 1).code).toBe('SHA');
    expect(getClientByCode(db, 'MEH')?.active).toBe(true);
  });

  it('refuses to reuse the code of an inactive client for a new group', () => {
    const db = seededDb();
    syncClients(db, [SHARMA]);
    const fresh = { ...MEHTA, groupId: '120363000000000003@g.us' };
    expect(() => syncClients(db, [SHARMA, fresh])).toThrow(/already used/);
  });

  it('reactivates a removed client re-added with the same code', () => {
    const db = seededDb();
    syncClients(db, [SHARMA]);
    syncClients(db, [SHARMA, MEHTA]);
    expect(getClientByCode(db, 'MEH')?.active).toBe(true);
  });

  it('issues task codes per client', () => {
    const db = seededDb();
    expect(nextTaskCode(db, 1)).toBe('SHA-001');
    expect(nextTaskCode(db, 1)).toBe('SHA-002');
    expect(nextTaskCode(db, 2)).toBe('MEH-001');
  });

  it('sets phase and status', () => {
    const db = seededDb();
    setPhase(db, 1, 'Design', 'human');
    expect(getClient(db, 1)).toMatchObject({ currentPhase: 'Design', phaseLocked: true });
    setPhase(db, 1, 'Development', 'ai');
    expect(getClient(db, 1).phaseLocked).toBe(false);
    setStatus(db, 1, 'Homepage approved', NOW);
    expect(getClient(db, 1)).toMatchObject({ statusText: 'Homepage approved', statusUpdatedAt: NOW });
  });

  it('stores key/value pairs', () => {
    const db = seededDb();
    setKv(db, 'a', '1');
    setKv(db, 'a', '2');
    expect(getKv(db, 'a')).toBe('2');
    expect(getKv(db, 'missing')).toBeUndefined();
  });
});
