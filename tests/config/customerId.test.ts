import { describe, expect, it } from 'vitest';
import { isCustomerId } from '../../src/config/customerId.ts';
import { FOUNDER_TENANT_ID } from '../../src/config/env.ts';

describe('isCustomerId: one rule for a customer id (isolation review F6)', () => {
  it('accepts a lower-case RFC 4122 UUID that is not the founder’s', () => {
    expect(isCustomerId('6f1c2e9a-3b4d-4c5e-8f60-718293a4b5c6')).toBe(true);
    expect(isCustomerId('1b2c3d4e-5f60-7a1b-bc2d-3e4f5a6b7c8d')).toBe(true); // version 7
  });

  it('refuses the founder’s id, upper case, other versions or variants, and anything else', () => {
    for (const id of [
      FOUNDER_TENANT_ID, '6F1C2E9A-3B4D-4C5E-8F60-718293A4B5C6', '6f1c2e9a-3b4d-0c5e-8f60-718293a4b5c6', '6f1c2e9a-3b4d-4c5e-7f60-718293a4b5c6',
      '', '..', 'tmp', '6f1c2e9a3b4d4c5e8f60718293a4b5c6', '6f1c2e9a-3b4d-4c5e-8f60-718293a4b5c6/..', ' 6f1c2e9a-3b4d-4c5e-8f60-718293a4b5c6',
    ]) expect(isCustomerId(id), id).toBe(false);
  });
});
