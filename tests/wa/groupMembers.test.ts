import type { GroupMetadata } from 'baileys';
import { describe, expect, it } from 'vitest';
import { membersOf, tagOf } from '../../src/wa/groupMembers.ts';

// Who is in a group, from WhatsApp's group data (November release, change 2). Made-up ids only.

const PN = (n: string) => `${n}@s.whatsapp.net`;
const LID = (n: string) => `${n}@lid`;
const meta = (participants: unknown[]) => ({ participants }) as unknown as Pick<GroupMetadata, 'participants'>;

describe('membersOf', () => {
  it('keeps each member by the id WhatsApp uses in the group, with its number when WhatsApp gives one', () => {
    expect(membersOf(meta([
      { id: PN('919800000001'), lid: LID('201111111111111'), admin: 'superadmin' },
      { id: LID('202222222222222'), phoneNumber: PN('919800000002'), admin: 'admin' },
      { id: PN('919800000003'), admin: null },
    ]))).toEqual([
      { id: PN('919800000001'), phoneNumber: PN('919800000001'), lid: LID('201111111111111'), admin: true },
      { id: LID('202222222222222'), phoneNumber: PN('919800000002'), lid: LID('202222222222222'), admin: true },
      { id: PN('919800000003'), phoneNumber: PN('919800000003'), lid: null, admin: false },
    ]);
  });

  it('a hidden-number member (@lid with no number) keeps its @lid id and no number: never a guessed one', () => {
    expect(membersOf(meta([{ id: LID('203333333333333') }]))).toEqual([
      { id: LID('203333333333333'), phoneNumber: null, lid: LID('203333333333333'), admin: false },
    ]);
    // A number that is not a phone-number id is not taken as one.
    expect(membersOf(meta([{ id: LID('203333333333333'), phoneNumber: LID('204444444444444') }]))[0]!.phoneNumber).toBeNull();
  });

  it('skips ids that are not a person (a group, a newsletter, junk) and keeps a member once', () => {
    expect(membersOf(meta([
      { id: '120363000000000001@g.us' }, { id: '123@newsletter' }, { id: '' }, { id: 42 }, {}, null,
      { id: PN('919800000001') }, { id: PN('919800000001'), admin: 'admin' },
    ])).map((m) => m.id)).toEqual([PN('919800000001')]);
    expect(membersOf(undefined)).toEqual([]);
    expect(membersOf(meta(undefined as unknown as unknown[]))).toEqual([]);
  });

  it('drops a device part from an id', () => {
    expect(membersOf(meta([{ id: '919800000001:7@s.whatsapp.net' }]))[0]!.id).toBe(PN('919800000001'));
  });
});

describe('tagOf', () => {
  it('is the digits after "@" that tag the member in a message: the user part of the id WhatsApp uses', () => {
    expect(tagOf(PN('919800000001'))).toBe('919800000001');
    expect(tagOf(LID('201111111111111'))).toBe('201111111111111');
    expect(tagOf('919800000001:7@s.whatsapp.net')).toBe('919800000001');
  });
});
