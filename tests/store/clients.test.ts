import { describe, expect, it } from 'vitest';
import { getClient, getClientByCode, getClientByGroupId, listClients, nextTaskCode, setPhase, setStatus, syncClients } from '../../src/store/clients.ts';
import { getKv, setKv } from '../../src/store/kv.ts';
import { MEHTA, NOW, SHARMA, seededDb } from '../helpers/db.ts';

describe('clients repository', () => {
  it('syncs clients from config', async () => {
    const db = await seededDb();
    expect((await listClients(db)).map((c) => c.code)).toEqual(['MEH', 'SHA']);
    expect(await getClientByGroupId(db, SHARMA.groupId)).toMatchObject({
      id: 1, code: 'SHA', name: 'Sharma Interiors', phases: SHARMA.phases, currentPhase: null, phaseLocked: false, active: true,
    });
  });

  it('marks removed clients inactive but keeps their rows', async () => {
    const db = await seededDb();
    await syncClients(db, [SHARMA]);
    expect((await getClientByCode(db, 'MEH'))?.active).toBe(false);
    expect((await listClients(db)).map((c) => c.code)).toEqual(['SHA']);
    expect(await listClients(db, false)).toHaveLength(2);
  });

  it('updates a renamed client in place', async () => {
    const db = await seededDb();
    await syncClients(db, [{ ...SHARMA, name: 'Sharma Interiors Pvt Ltd' }]);
    expect((await getClient(db, 1)).name).toBe('Sharma Interiors Pvt Ltd');
  });

  it('refuses to change a client code and writes nothing', async () => {
    const db = await seededDb();
    await expect(syncClients(db, [{ ...SHARMA, code: 'SHX' }])).rejects.toThrow(/permanent/);
    expect((await getClient(db, 1)).code).toBe('SHA');
    expect((await getClientByCode(db, 'MEH'))?.active).toBe(true);
  });

  it('refuses to reuse the code of an inactive client for a new group', async () => {
    const db = await seededDb();
    await syncClients(db, [SHARMA]);
    const fresh = { ...MEHTA, groupId: '120363000000000003@g.us' };
    await expect(syncClients(db, [SHARMA, fresh])).rejects.toThrow(/already used/);
  });

  it('reactivates a removed client re-added with the same code', async () => {
    const db = await seededDb();
    await syncClients(db, [SHARMA]);
    await syncClients(db, [SHARMA, MEHTA]);
    expect((await getClientByCode(db, 'MEH'))?.active).toBe(true);
  });

  it('issues task codes per client', async () => {
    const db = await seededDb();
    expect(await nextTaskCode(db, 1)).toBe('SHA-001');
    expect(await nextTaskCode(db, 1)).toBe('SHA-002');
    expect(await nextTaskCode(db, 2)).toBe('MEH-001');
  });

  it('sets phase and status', async () => {
    const db = await seededDb();
    await setPhase(db, 1, 'Design', 'human');
    expect(await getClient(db, 1)).toMatchObject({ currentPhase: 'Design', phaseLocked: true });
    await setPhase(db, 1, 'Development', 'ai');
    expect((await getClient(db, 1)).phaseLocked).toBe(false);
    await setStatus(db, 1, 'Homepage approved', NOW);
    expect(await getClient(db, 1)).toMatchObject({ statusText: 'Homepage approved', statusUpdatedAt: NOW });
  });

  it('stores key/value pairs', async () => {
    const db = await seededDb();
    setKv(db, 'a', '1');
    setKv(db, 'a', '2');
    expect(getKv(db, 'a')).toBe('2');
    expect(getKv(db, 'missing')).toBeUndefined();
  });
});
