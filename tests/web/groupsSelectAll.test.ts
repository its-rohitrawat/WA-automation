import { describe, expect, it } from 'vitest';
// Browser module; its JSDoc types are checked by tsconfig.web.json, so the import is untyped here.
// @ts-expect-error -- browser module (see above)
import { selectAllState } from '../../src/web/public/views/groups.js';

describe('Manage groups: Select all (November release, change 9)', () => {
  it('none ticked: empty, with how many groups can be ticked', () => {
    expect(selectAllState(0, 12)).toEqual({ checked: false, indeterminate: false, count: '12 groups' });
    expect(selectAllState(0, 1)).toEqual({ checked: false, indeterminate: false, count: '1 group' });
  });

  it('some ticked: the mixed state, with "3 of 12 selected"', () => {
    expect(selectAllState(3, 12)).toEqual({ checked: false, indeterminate: true, count: '3 of 12 selected' });
  });

  it('all ticked: checked, with "All 12 selected"', () => {
    expect(selectAllState(12, 12)).toEqual({ checked: true, indeterminate: false, count: 'All 12 selected' });
    expect(selectAllState(1, 1)).toEqual({ checked: true, indeterminate: false, count: 'Selected' });
  });

  it('never claims more than there are, and copes with nothing to tick', () => {
    expect(selectAllState(15, 12)).toEqual({ checked: true, indeterminate: false, count: 'All 12 selected' });
    expect(selectAllState(0, 0)).toEqual({ checked: false, indeterminate: false, count: '0 groups' });
  });
});
