import { describe, expect, it } from 'vitest';
// The browser's own module, checked by tsconfig.web.json, which this project's tsconfig does not include: the import is
// untyped here, as in tests/web/public.test.ts.
// @ts-expect-error -- browser module (see above)
import { readGroups } from '../../src/web/public/contract.js';

// The Groups answer's phone parts in the browser (more phones, November release): coerced defensively.

const KEY = 'a'.repeat(24);

describe('readGroups: phones', () => {
  it('reads the phones: ids 1 to 5 once each, in order; a label as given (shown with esc()), cut to 40, and whether unlinked', () => {
    const g = readGroups({
      phones: [
        { id: 2, label: 'Rahul <b>phone', state: 'active' }, { id: 1, label: 'Office', state: 'active' }, { id: 3, label: 'L'.repeat(60), state: 'unlinked' },
        { id: 2, label: 'twice' }, { id: 9, label: 'nine' }, { id: '4', label: 'text id' }, null,
      ],
    });
    expect(g.phones).toEqual([
      { id: 1, label: 'Office', unlinked: false }, { id: 2, label: 'Rahul <b>phone', unlinked: false }, { id: 3, label: 'L'.repeat(40), unlinked: true },
    ]);
    expect(readGroups({}).phones).toEqual([]);
    expect(readGroups({ phones: [{ id: 5, label: '' }] }).phones).toEqual([{ id: 5, label: 'Phone 5', unlinked: false }]);
  });

  it("reads a row's phone, the phones that see it, and the phone to read it through when its own is unlinked", () => {
    const [ok, off, odd] = readGroups({
      rows: [
        { key: KEY, name: 'A', approved: true, phone: 1, seenBy: [2, 1, 1, 9], phoneState: 'ok', readThrough: 2 },
        { key: 'b'.repeat(24), name: 'B', approved: true, phone: 3, seenBy: [2], phoneState: 'unlinked', readThrough: 2 },
        { key: 'c'.repeat(24), name: 'C', approved: false, phone: 'x', seenBy: ['1'], phoneState: 'unlinked', readThrough: 7 },
      ],
    }).rows;
    expect(ok.where).toEqual({ phone: 1, seenBy: [1, 2], unlinked: false, readThrough: null }); // readThrough only when unlinked
    expect(off.where).toEqual({ phone: 3, seenBy: [2], unlinked: true, readThrough: 2 });
    expect(odd.where).toEqual({ phone: null, seenBy: [], unlinked: true, readThrough: null });
  });

  it('an older agent sends no phone fields: the row has no phone part at all', () => {
    const [row] = readGroups({ rows: [{ key: KEY, name: 'A', approved: true }] }).rows;
    expect(row).not.toHaveProperty('where');
  });
});
