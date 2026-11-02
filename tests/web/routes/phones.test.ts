import { describe, expect, it, vi } from 'vitest';
import { ControlError } from '../../../src/control/errors.ts';
import type { OwnerContext } from '../../../src/web/routes/context.ts';
import { PhoneRoutes, type PhoneRoutesDeps, type PhoneRow } from '../../../src/web/routes/whatsapp.ts';

// The phone routes (lane C, change 7): list, add, rename, unlink, remove. The body and the phone number in the URL are
// checked here; the phone list's own refusals (ControlError) come back as the dashboard's errors, with their fixed text.

const owner: OwnerContext = { actor: 'owner@studio.in', sessionId: 'session-a', requestId: 'aaaaaaaaaaaa' };
const ROWS: PhoneRow[] = [
  { id: 1, label: 'Phone 1', state: 'active', number: '…0001', status: 'open', groups: 3, accountName: 'Rohit Rawat' },
  { id: 2, label: 'Front desk', state: 'unlinked', number: null, status: null, groups: 1, accountName: null },
];
const entry = (id: 1 | 2 | 3, label = `Phone ${id}`) => ({ id, label, state: 'active' as const, addedAt: null });

function setup(over: Partial<PhoneRoutesDeps> = {}) {
  const d: PhoneRoutesDeps = {
    list: () => ROWS,
    add: vi.fn(async (label: unknown) => entry(3, String(label))),
    rename: vi.fn(async (id, label) => entry(id as 1 | 2 | 3, String(label))),
    unlink: vi.fn(async (id) => ({ phone: { ...entry(id as 1 | 2 | 3), state: 'unlinked' as const }, loggedOut: true })),
    remove: vi.fn(async (id) => entry(id as 1 | 2 | 3)),
    ...over,
  };
  return { d, routes: new PhoneRoutes(d) };
}

describe('the phone routes', () => {
  it('list gives each phone (number masked) and the limit', () => {
    expect(setup().routes.list()).toEqual({ status: 200, body: { phones: ROWS, max: 5 } });
  });

  it('add and rename take a label; the list’s refusals keep their status, text and field', async () => {
    const { d, routes } = setup({
      rename: async () => {
        throw new ControlError(422, 'Another phone already has that name.', 'label');
      },
    });
    expect(await routes.add(owner, { label: 'Sales' })).toMatchObject({ status: 200, body: { phone: { id: 3, label: 'Sales' } } });
    expect(d.add).toHaveBeenCalledWith('Sales', owner.actor);
    expect(await routes.add(owner, { label: 'x', extra: 1 })).toMatchObject({ status: 400 });
    expect(await routes.rename(owner, '2', { label: 'Phone 1' })).toEqual({
      status: 422, body: { error: { code: 'invalid', message: 'Another phone already has that name.', field: 'label' } },
    });
  });

  it('unlink needs confirm: true and a phone from 1 to 5; it says whether WhatsApp was told', async () => {
    const { d, routes } = setup();
    for (const [id, body] of [['2', {}], ['2', { confirm: 'yes' }], ['0', { confirm: true }], ['6', { confirm: true }], ['two', { confirm: true }], ['1.5', { confirm: true }]] as const) {
      expect(await routes.unlink(owner, id, body), `${id} ${JSON.stringify(body)}`).toMatchObject({ status: 400 });
    }
    expect(d.unlink).not.toHaveBeenCalled();
    expect(await routes.unlink(owner, '2', { confirm: true })).toMatchObject({ status: 200, body: { phone: { id: 2, state: 'unlinked' }, loggedOut: true } });
    expect(d.unlink).toHaveBeenCalledWith(2, owner.actor);
  });

  it('a phone in the address is one digit from 1 to 5, as written: no hex, exponent, sign, padding or leading zero', async () => {
    const { d, routes } = setup();
    for (const id of ['0x2', '2e0', '02', ' 2', '2 ', '+2', '2.0', '', 2]) {
      expect(await routes.unlink(owner, id, { confirm: true }), JSON.stringify(id)).toMatchObject({ status: 400 });
      expect(await routes.remove(owner, id, { confirm: true }), JSON.stringify(id)).toMatchObject({ status: 400 });
      expect(await routes.rename(owner, id, { label: 'Office' }), JSON.stringify(id)).toMatchObject({ status: 400 });
    }
    expect(d.unlink).not.toHaveBeenCalled();
    expect(d.remove).not.toHaveBeenCalled();
    expect(d.rename).not.toHaveBeenCalled();
    for (const id of ['1', '5']) expect(await routes.rename(owner, id, { label: 'Office' }), id).toMatchObject({ status: 200 });
  });

  it('remove of phone 1, or of an unknown phone, is refused as the list says; other errors go on to the server', async () => {
    const refused = setup({
      remove: async (id) => {
        throw id === 1 ? new ControlError(409, 'Phone 1 cannot be removed. Unlink it instead.') : new ControlError(404, 'There is no such phone.');
      },
    });
    expect(await refused.routes.remove(owner, '1', { confirm: true })).toMatchObject({ status: 409, body: { error: { code: 'conflict' } } });
    expect(await refused.routes.remove(owner, '4', { confirm: true })).toMatchObject({ status: 404 });
    const broken = setup({
      unlink: async () => {
        throw new Error('database down');
      },
    });
    await expect(broken.routes.unlink(owner, '2', { confirm: true })).rejects.toThrow('database down');
  });
});
