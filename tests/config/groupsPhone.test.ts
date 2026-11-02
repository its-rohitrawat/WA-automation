import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseGroupsFile } from '../../src/config/groups.ts';
import { applyToDocument, GroupChangeError } from '../../src/config/groupsWriter.ts';
import { phoneOfConfig } from '../../src/wa/phoneSet.ts';
import { testDb } from '../helpers/db.ts';

// A group's phone (lane C, change 7): an approved group names the phone it is read through. Missing means phone 1, so
// every file written before phones were numbered reads as before, and phone 1 is never written into the file.

const G1 = '120363111111111111@g.us';
const G2 = '120363222222222222@g.us';
const file = (clients: unknown[]) => JSON.stringify({ clients });

async function refusal(p: Promise<unknown>): Promise<GroupChangeError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof GroupChangeError) return e;
    throw e;
  }
  throw new Error('expected a refusal');
}

describe('a group’s phone', () => {
  it('is kept when given (2 to 5); missing reads as phone 1; anything else is refused', () => {
    const [a, b] = parseGroupsFile(file([{ groupId: G1, name: 'A', code: 'AAA' }, { groupId: G2, name: 'B', code: 'BBB', phone: 2 }]));
    expect(a!.phone).toBeUndefined();
    expect(phoneOfConfig(a!)).toBe(1);
    expect(b!.phone).toBe(2);
    for (const bad of [0, 6, 1.5, '2', null]) {
      expect(() => parseGroupsFile(file([{ groupId: G1, name: 'A', code: 'AAA', phone: bad }])), String(bad)).toThrow(/phone/);
    }
  });

  it('approving on phone 3 writes it; on phone 1 (or none) writes nothing; outside 1 to 5 is refused', async () => {
    const db = await testDb();
    const { text, result } = await applyToDocument(file([]), { approve: [{ groupId: G1, name: 'A', code: 'AAA', phone: 3 }, { groupId: G2, name: 'B', code: 'BBB', phone: 1 }] }, { db });
    const doc = JSON.parse(text) as { clients: Record<string, unknown>[] };
    expect(doc.clients[0]).toMatchObject({ groupId: G1, phone: 3 });
    expect('phone' in doc.clients[1]!).toBe(false);
    expect(result.configs.map(phoneOfConfig)).toEqual([3, 1]);
    for (const bad of [0, 6, 2.5]) {
      const e = await refusal(applyToDocument(file([]), { approve: [{ groupId: G1, name: 'A', code: 'AAA', phone: bad }] }, { db }));
      expect(e.field, String(bad)).toBe('phone');
    }
  });

  it('an edit moves a group to another phone (one edited line); back to phone 1 drops the field; others stay as written', async () => {
    const db = await testDb();
    const start = file([{ groupId: G1, name: 'A', code: 'AAA', meetingKeywords: ['alpha project'] }, { groupId: G2, name: 'B', code: 'BBB', custom: 'kept' }]);
    const moved = await applyToDocument(start, { edit: [{ groupId: G1, phone: 2 }] }, { db });
    expect(moved.result.edited.map((g) => g.groupId)).toEqual([G1]);
    const doc = JSON.parse(moved.text) as { clients: Record<string, unknown>[] };
    expect(doc.clients[0]).toEqual({ groupId: G1, name: 'A', code: 'AAA', meetingKeywords: ['alpha project'], phone: 2 });
    expect(doc.clients[1]).toEqual({ groupId: G2, name: 'B', code: 'BBB', custom: 'kept' }); // untouched, as written
    const back = await applyToDocument(moved.text, { edit: [{ groupId: G1, phone: 1 }] }, { db });
    expect('phone' in (JSON.parse(back.text) as { clients: Record<string, unknown>[] }).clients[0]!).toBe(false);
    const same = await applyToDocument(moved.text, { edit: [{ groupId: G1, phone: 2 }] }, { db });
    expect(same.differs).toBe(false); // already on phone 2: nothing to write
    expect(same.result.edited).toEqual([]);
  });

  it('rollback guard: the schema as it was on main still reads a file that names phones (it drops the field)', () => {
    // A copy of main's ClientSchema (d61bd9d): a plain z.object, so an unknown key is dropped, never refused.
    const MainClient = z.object({
      groupId: z.string().regex(/^[0-9-]+@g\.us$/), name: z.string().trim().min(1).max(80), code: z.string().regex(/^[A-Z]{3,4}$/),
      phases: z.array(z.string().trim().min(1)).min(1).optional(), emailDomains: z.array(z.string()).optional(),
      meetingKeywords: z.array(z.string().trim().min(3)).max(20).optional(),
    });
    const parsed = z.object({ clients: z.array(MainClient) }).safeParse(JSON.parse(file([{ groupId: G1, name: 'A', code: 'AAA', phone: 4 }])));
    expect(parsed.success).toBe(true);
    expect(parsed.data!.clients[0]).toEqual({ groupId: G1, name: 'A', code: 'AAA' });
  });
});
