import { describe, expect, it } from 'vitest';
// Browser modules; their JSDoc types are checked by tsconfig.web.json, so the imports are untyped here.
// @ts-expect-error -- browser module (see above)
import { readPhones } from '../../src/web/public/contract.js';
// @ts-expect-error -- browser module (see above)
import { fixFor } from '../../src/web/public/views/connect.js';

// Connections' reading phones (lane C, change 7): the list the dashboard reads, and what "Fix now" does with several.

describe('readPhones', () => {
  it('reads each phone, keeps only phones 1 to 5 with a label, and never throws on a broken answer', () => {
    const r = readPhones({
      max: 5,
      phones: [
        { id: 1, label: 'Phone 1', state: 'active', number: '+91 •••• 1234', status: 'open', groups: 3 },
        { id: 2, label: 'Front desk', state: 'unlinked', number: null, status: null, groups: 1 },
        { id: 6, label: 'Too many', state: 'active' },
        { id: 3, label: '' },
        null,
      ],
    });
    expect(r.max).toBe(5);
    expect(r.phones).toEqual([
      { id: 1, label: 'Phone 1', state: 'active', number: '+91 •••• 1234', status: 'open', groups: 3 },
      { id: 2, label: 'Front desk', state: 'unlinked', number: null, status: null, groups: 1 },
    ]);
    const hostile = { toString: 1, valueOf: 1 };
    for (const bad of [null, undefined, 7, 'x', [], { phones: 'x' }, { phones: [hostile, { id: hostile, label: hostile }] }]) {
      expect(() => readPhones(bad)).not.toThrow();
      expect(readPhones(bad).phones).toEqual([]);
    }
    expect(readPhones(null).max).toBe(5);
  });
});

describe('Fix now on the WhatsApp part', () => {
  it('with several phones it opens Connections (each phone has its own Link); with one, the dialogs as before', () => {
    expect(fixFor({ key: 'whatsapp', state: 'warn', detail: '2 of 3 phones connected' })).toBeNull();
    expect(fixFor({ key: 'whatsapp', state: 'down', detail: '0 of 3 phones connected' })).toBeNull();
    expect(fixFor({ key: 'whatsapp', state: 'down', detail: 'Not linked' })).toBe('founder-link');
    expect(fixFor({ key: 'whatsapp', state: 'down', detail: 'Unlinked from the phone' })).toBe('founder');
    expect(fixFor({ key: 'whatsapp', state: 'down', detail: 'Disconnected' })).toBeNull();
  });
});
