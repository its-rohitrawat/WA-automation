import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientConfig } from '../../../src/config/groups.ts';
import { syncClients } from '../../../src/store/clients.ts';
import type { Db } from '../../../src/store/db.ts';
import { upsertPerson } from '../../../src/store/people.ts';
import { manualClock } from '../../../src/util/clock.ts';
import { createLogger } from '../../../src/util/logger.ts';
import type { GroupMember } from '../../../src/wa/groupMembers.ts';
import { chatMembersHandler, type ChatDeps } from '../../../src/web/routes/chat.ts';
import type { OwnerContext } from '../../../src/web/routes/context.ts';
import { MEHTA, NOW, seeded, SHARMA, testDb } from '../../helpers/db.ts';

// Open chat's group info (November release, change 2): who is in the group, from WhatsApp's group data, named from the
// agent's own people. A fake members source only: nothing here reaches WhatsApp. Made-up numbers.

const CTX: OwnerContext = { actor: 'owner@example.com', sessionId: 'session-hash', requestId: 'a1b2c3d4e5f6' };
const PN = (n: string) => `${n}@s.whatsapp.net`;
const LID = (n: string) => `${n}@lid`;
const m = (id: string, o: { phoneNumber?: string | null; lid?: string | null; admin?: boolean } = {}): GroupMember => ({
  id, phoneNumber: o.phoneNumber !== undefined ? o.phoneNumber : id.endsWith('@s.whatsapp.net') ? id : null, lid: o.lid !== undefined ? o.lid : id.endsWith('@lid') ? id : null, admin: o.admin ?? false,
});
/** Another workspace's client: its code is in this workspace's approved list too, but its row is not in this workspace. */
const KAPOOR: ClientConfig = { ...SHARMA, groupId: '120363555555555555@g.us', name: 'Kapoor Design Studio', code: 'KAP' };

let db: Db;
let sharma: number;
let open: boolean;
let members: GroupMember[] | null;
let source: ReturnType<typeof vi.fn<(groupId: string) => Promise<GroupMember[] | null>>>;
let deps: ChatDeps;

beforeEach(async () => {
  let ids;
  ({ db, ids } = await seeded());
  sharma = ids.sharma;
  open = true;
  members = [];
  source = vi.fn(async (_groupId: string) => members);
  deps = {
    db,
    configs: () => [SHARMA, MEHTA, KAPOOR],
    sendingOn: () => false,
    connected: () => open,
    groupSocket: () => null,
    groupMembers: source,
    directory: { cachedGroups: () => [{ id: SHARMA.groupId, subject: 'Sharma x Studio' }] },
    audit: async () => {},
    log: createLogger('debug', { write: () => {} }),
    clock: manualClock(NOW),
  };
});

const read = (code = 'SHA') => chatMembersHandler(deps, CTX, code);
type View = { known: boolean; groupName: string; reason?: string; members: { name: string | null; number: string | null; tag: string; admin: boolean }[] };
const view = (r: { body: unknown }) => r.body as View;
const person = (jid: string, name: string | null, number: string | null = null) => upsertPerson(db, { clientId: sharma, jid, number, name, fromMe: false });

describe('the group info panel: its members', () => {
  it('names each member from the agent’s people, by its id, its hidden-number id or its number; else shows the number', async () => {
    await person(PN('919800000001'), 'Rahul');
    await person(LID('202222222222222'), 'Priya'); // known by the hidden-number id the group uses
    await person(PN('919800000003'), 'Anil'); // known by the phone-number id of a member the group lists by @lid
    await person('919800000004@c.us', 'Meera', '919800000004'); // known only by its number
    await person(PN('919800000005'), '+91 98000 00005'); // a "name" that is a number is no name
    members = [
      m(PN('919800000001'), { admin: true }),
      m(LID('202222222222222'), { phoneNumber: PN('919800000002') }),
      m(LID('203333333333333'), { phoneNumber: PN('919800000003') }),
      m(PN('919800000004')),
      m(PN('919800000005')),
      m(PN('447700900123')),
    ];
    const r = await read();
    expect(r.status).toBe(200);
    expect(view(r)).toEqual({
      known: true, groupName: 'Sharma x Studio',
      members: [
        { name: 'Rahul', number: '+91 98000 00001', tag: '919800000001', admin: true },
        { name: 'Anil', number: '+91 98000 00003', tag: '203333333333333', admin: false },
        { name: 'Meera', number: '+91 98000 00004', tag: '919800000004', admin: false },
        { name: 'Priya', number: '+91 98000 00002', tag: '202222222222222', admin: false },
        { name: null, number: '+447700900123', tag: '447700900123', admin: false },
        { name: null, number: '+91 98000 00005', tag: '919800000005', admin: false },
      ],
    });
    expect(source).toHaveBeenCalledWith(SHARMA.groupId);
  });

  it('a hidden-number member (@lid, no number) shows no number, never a guessed one, and tags by its @lid id', async () => {
    members = [m(LID('204444444444444'))];
    expect(view(await read()).members).toEqual([{ name: null, number: null, tag: '204444444444444', admin: false }]);
    await person(LID('204444444444444'), 'Sana');
    expect(view(await read()).members).toEqual([{ name: 'Sana', number: null, tag: '204444444444444', admin: false }]);
  });

  it('gives each member only a name, a shown number, its tag and whether it is an admin: never a WhatsApp id', async () => {
    members = [m(LID('202222222222222'), { phoneNumber: PN('919800000002'), admin: true }), m(LID('204444444444444'))];
    const body = view(await read());
    for (const x of body.members) expect(Object.keys(x).sort()).toEqual(['admin', 'name', 'number', 'tag']);
    expect(JSON.stringify(body)).not.toMatch(/@(s\.whatsapp\.net|lid|c\.us|g\.us)/);
  });

  it('says why when it cannot list them: WhatsApp not connected (nothing asked), or the read failed', async () => {
    open = false;
    expect(view(await read())).toEqual({ known: false, groupName: 'Sharma x Studio', reason: 'whatsapp_not_connected', members: [] });
    expect(source).not.toHaveBeenCalled();
    open = true;
    members = null;
    expect(view(await read())).toEqual({ known: false, groupName: 'Sharma x Studio', reason: 'members_unavailable', members: [] });
    delete deps.groupMembers;
    expect(view(await read())).toEqual({ known: false, groupName: 'Sharma x Studio', reason: 'members_unavailable', members: [] });
  });

  it('is only for this workspace’s approved clients: another workspace’s client, an unapproved one or a bad code is 404, and nothing is asked', async () => {
    const other = await testDb(); // another workspace (on Postgres: another customer)
    await syncClients(other, [KAPOOR]);
    for (const code of ['KAP', 'ZZZ', 'sha', '../SHA', '']) {
      const r = await read(code);
      expect(r.status, code).toBe(404);
    }
    deps.configs = () => [MEHTA];
    expect((await read('SHA')).status).toBe(404); // in this workspace, but not approved
    expect(source).not.toHaveBeenCalled();
  });
});
