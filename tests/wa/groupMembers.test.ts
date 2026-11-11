import type { GroupMetadata } from 'baileys';
import { describe, expect, it } from 'vitest';
import { memberTagged, membersOf, peopleOfMember, peopleTagged, replaceTags, tagOf, type GroupMember } from '../../src/wa/groupMembers.ts';

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

// Owner report, 11 Nov: a tag showed as a jumbled number. A tag uses the id the group uses (often the hidden-number one),
// while the agent keeps a person under the id they wrote from (often their phone number): only the member list links them.
describe('who a tag names', () => {
  const person = (jid: string, number: string | null, name: string | null) => ({ jid, number, name });
  const RAHUL = person(PN('919800000001'), '919800000001', 'Rahul');
  const SANA = person(LID('203333333333333'), null, 'Sana');
  const NONAME = person(PN('919800000004'), '919800000004', null);
  const people = [RAHUL, SANA, NONAME];
  const members: GroupMember[] = [
    { id: LID('201111111111111'), phoneNumber: PN('919800000001'), lid: LID('201111111111111'), admin: false }, // Rahul, tagged by his hidden id
    { id: LID('203333333333333'), phoneNumber: null, lid: LID('203333333333333'), admin: false }, // Sana: hidden number only
    { id: LID('207777777777777'), phoneNumber: PN('919800000007'), lid: LID('207777777777777'), admin: false }, // never wrote
  ];

  it('a hidden-number tag reaches the person who writes from their number, through the member list', () => {
    expect(peopleTagged('201111111111111', people, members)).toEqual([RAHUL]);
    expect(memberTagged('201111111111111', members)).toBe(members[0]);
  });

  it('without the member list, only the person’s own id or number matches', () => {
    expect(peopleTagged('201111111111111', people, null)).toEqual([]);
    expect(peopleTagged('919800000001', people, null)).toEqual([RAHUL]);
    expect(peopleTagged('203333333333333', people, null)).toEqual([SANA]);
  });

  it('a member who never wrote is found, with no person', () => {
    expect(peopleTagged('207777777777777', people, members)).toEqual([]);
    expect(memberTagged('207777777777777', members)?.phoneNumber).toBe(PN('919800000007'));
    expect(memberTagged('209999999999999', members)).toBeNull();
    expect(memberTagged('201111111111111', null)).toBeNull();
  });

  it('a member’s people: by the id the group uses, its phone-number id, its hidden-number id, then its number; each once', () => {
    const lidRow = person(LID('201111111111111'), null, null);
    const byNumber = person('rahul-elsewhere@s.whatsapp.net', '919800000001', 'R');
    expect(peopleOfMember(members[0]!, [byNumber, RAHUL, lidRow])).toEqual([lidRow, RAHUL, byNumber]);
    expect(peopleTagged('201111111111111', [byNumber, RAHUL, lidRow], members)).toEqual([lidRow, RAHUL, byNumber]);
  });
});

describe('replaceTags', () => {
  it('replaces each tag by what it names, and leaves look-alikes as they are', () => {
    expect(replaceTags('@201111111111111 and @919800000001, mail a@123456 or @1234', (t) => `<${t.slice(-2)}>`))
      .toBe('<11> and <01>, mail a@123456 or @1234');
  });
});
