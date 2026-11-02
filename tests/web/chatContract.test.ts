import { describe, expect, it } from 'vitest';
// The browser's own module, checked by tsconfig.web.json, which this project's tsconfig does not include: the import is
// untyped here, as in tests/web/public.test.ts.
// @ts-expect-error -- browser module (see above)
import { readChat, readDeleteResult, readMembers } from '../../src/web/public/contract.js';

describe('Delete chat in the browser', () => {
  it('reads the outcome, and anything odd as unknown (it may have been done: never "deleted" by guess)', () => {
    expect(readDeleteResult({ state: 'deleted', code: null })).toEqual({ state: 'deleted', code: null });
    expect(readDeleteResult({ state: 'failed', code: 'whatsapp_not_connected' })).toEqual({ state: 'failed', code: 'whatsapp_not_connected' });
    expect(readDeleteResult({ state: 'gone', code: '<b>' })).toEqual({ state: 'unknown', code: null });
    expect(readDeleteResult(null)).toEqual({ state: 'unknown', code: null });
  });

  it('a chat page says when it is empty because the owner deleted it', () => {
    expect(readChat({ cleared: true }).cleared).toBe(true);
    expect(readChat({ cleared: 'yes' }).cleared).toBe(false);
    expect(readChat({}).cleared).toBe(false);
  });
});

describe('readChat: the names of the tags on the page (tagging)', () => {
  it('keeps a name for each tag the agent knows; anything else is dropped', () => {
    const r = readChat({ names: { '919800000001': 'Rahul', '203333333333333': 'Sana', 'abc': 'Bad key', '919800000002': '', '919800000003': 42, '1234': 'Too short' } });
    expect(r.names).toEqual({ '919800000001': 'Rahul', '203333333333333': 'Sana' });
    expect(readChat({}).names).toEqual({});
    expect(readChat({ names: ['Rahul'] }).names).toEqual({});
  });

  it('a name is cut to 80 characters, and a key like __proto__ is never taken', () => {
    const r = readChat({ names: JSON.parse('{"__proto__": "x", "919800000001": "' + 'N'.repeat(200) + '"}') });
    expect(Object.keys(r.names)).toEqual(['919800000001']);
    expect(r.names['919800000001'].length).toBe(80);
  });
});

// The browser's reading of the group info panel's answer (November release, change 2): coerced defensively, so a
// missing or odd field becomes an empty value and the panel never breaks or shows a WhatsApp id.

describe('readMembers', () => {
  it('keeps each member’s name, shown number, tag and admin flag', () => {
    expect(readMembers({
      known: true, groupName: 'Sharma x Studio',
      members: [
        { name: 'Rahul', number: '+91 98000 00001', tag: '919800000001', admin: true },
        { name: null, number: null, tag: '204444444444444', admin: false },
      ],
    })).toEqual({
      known: true, groupName: 'Sharma x Studio', reason: 'members_unavailable',
      members: [
        { name: 'Rahul', number: '+91 98000 00001', tag: '919800000001', admin: true },
        { name: null, number: null, tag: '204444444444444', admin: false },
      ],
    });
  });

  it('drops a member without a usable tag, and anything that is not a shown number', () => {
    const r = readMembers({
      known: true,
      members: [
        { name: 'Bad tag', tag: '919800000001@s.whatsapp.net' }, { name: 'No tag' }, null, 'x',
        { name: 'Id as number', number: '203333333333333@lid', tag: '203333333333333' },
        { name: 'Script as number', number: '<img src=x>', tag: '919800000009', admin: 'yes' },
      ],
    });
    expect(r.members).toEqual([
      { name: 'Id as number', number: null, tag: '203333333333333', admin: false },
      { name: 'Script as number', number: null, tag: '919800000009', admin: false },
    ]);
  });

  it('reads an unknown answer as nothing known, and a long name or group name cut', () => {
    expect(readMembers(null)).toEqual({ known: false, groupName: '', reason: 'members_unavailable', members: [] });
    expect(readMembers({ known: false, reason: 'whatsapp_not_connected' }).reason).toBe('whatsapp_not_connected');
    const long = readMembers({ known: true, groupName: 'G'.repeat(500), members: [{ name: 'N'.repeat(500), tag: '919800000001' }] });
    expect(long.groupName.length).toBeLessThanOrEqual(121);
    expect(long.members[0]!.name!.length).toBeLessThanOrEqual(81);
  });
});
