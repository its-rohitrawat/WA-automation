import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseGroupsFile, type ClientConfig } from '../../src/config/groups.ts';
import { applyGroupChanges, GroupChangeError, type FileOps } from '../../src/config/groupsWriter.ts';
import { syncClients } from '../../src/store/clients.ts';
import { MEHTA as MEHTA_HELPER, SHARMA as SHARMA_HELPER, testDb } from '../helpers/db.ts';

// The shared test helpers use the example group id for Sharma, which the parser refuses on purpose; these tests write
// real files, so they use their own ids.
const SHARMA: ClientConfig = { ...SHARMA_HELPER, groupId: '120363777000000001@g.us' };
const MEHTA: ClientConfig = { ...MEHTA_HELPER, groupId: '120363777000000002@g.us' };
const DESAI = '120363777000000003@g.us';
const PATEL = '120363777000000004@g.us';

/** A database on the engine under test with Sharma and Mehta under this file's ids. */
async function seededDb() {
  const db = await testDb();
  await syncClients(db, [SHARMA, MEHTA]);
  return db;
}

/** The file as people write it today: Sharma with custom phases and keywords, Mehta plain. */
const ORIGINAL = {
  clients: [
    { groupId: SHARMA.groupId, name: 'Sharma Interiors', code: 'SHA', phases: ['Brief', 'Build'], meetingKeywords: ['sharma project'] },
    { groupId: MEHTA.groupId, name: 'Mehta Foods', code: 'MEH', emailDomains: ['mehtafoods.in'] },
  ],
};
const text = (o: unknown) => `${JSON.stringify(o, null, 2)}\n`;

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wa-groups-writer-'));
  file = join(dir, 'allowed-groups.json');
  writeFileSync(file, text(ORIGINAL));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const read = () => JSON.parse(readFileSync(file, 'utf8')) as typeof ORIGINAL & { clients: Record<string, unknown>[] };
const entryText = (all: string, groupId: string) => {
  const parsed = JSON.parse(all) as { clients: { groupId: string }[] };
  return JSON.stringify(parsed.clients.find((c) => c.groupId === groupId), null, 2);
};

describe('applyGroupChanges', () => {
  it('approve adds only the new entry; the others keep their exact content; the result names what changed', async () => {
    const db = await seededDb();
    const before = readFileSync(file, 'utf8');
    const r = await applyGroupChanges(file, { approve: [{ groupId: DESAI, name: 'Desai Foods', code: 'DES' }] }, { db });
    const after = readFileSync(file, 'utf8');
    expect(read().clients.at(-1)).toEqual({ groupId: DESAI, name: 'Desai Foods', code: 'DES' });
    for (const g of [SHARMA.groupId, MEHTA.groupId]) expect(entryText(after, g)).toBe(entryText(before, g));
    expect(after.startsWith(before.slice(0, before.indexOf(MEHTA.groupId)))).toBe(true);
    expect(after.endsWith('}\n')).toBe(true);
    expect(r.approved).toEqual([{ groupId: DESAI, name: 'Desai Foods', code: 'DES' }]);
    expect(r.configs.map((c) => c.code)).toEqual(['SHA', 'MEH', 'DES']);
  });

  it('approve keeps optional meeting fields, and leaves out empty ones', async () => {
    const db = await seededDb();
    await applyGroupChanges(file, {
      approve: [
        { groupId: DESAI, name: 'Desai Foods', code: 'DES', emailDomains: ['desai.in'], meetingKeywords: ['desai launch'] },
        { groupId: PATEL, name: 'Patel', code: 'PAT', emailDomains: [], meetingKeywords: [] },
      ],
    }, { db });
    expect(read().clients.slice(2)).toEqual([
      { groupId: DESAI, name: 'Desai Foods', code: 'DES', emailDomains: ['desai.in'], meetingKeywords: ['desai launch'] },
      { groupId: PATEL, name: 'Patel', code: 'PAT' },
    ]);
  });

  it('unapprove removes only that entry', async () => {
    const db = await seededDb();
    const before = readFileSync(file, 'utf8');
    const r = await applyGroupChanges(file, { unapprove: [MEHTA.groupId] }, { db });
    expect(read().clients.map((c) => c.groupId)).toEqual([SHARMA.groupId]);
    expect(entryText(readFileSync(file, 'utf8'), SHARMA.groupId)).toBe(entryText(before, SHARMA.groupId));
    expect(r.removed).toEqual([{ groupId: MEHTA.groupId, name: 'Mehta Foods', code: 'MEH' }]);
  });

  it('edit changes only the given fields of one entry; phases and other fields stay', async () => {
    const db = await seededDb();
    const r = await applyGroupChanges(file, { edit: [{ groupId: SHARMA.groupId, name: 'Sharma Interiors Pvt', emailDomains: ['sharma.in'] }] }, { db });
    expect(read().clients[0]).toEqual({
      groupId: SHARMA.groupId, name: 'Sharma Interiors Pvt', code: 'SHA', phases: ['Brief', 'Build'], meetingKeywords: ['sharma project'], emailDomains: ['sharma.in'],
    });
    expect(read().clients[1]).toEqual(ORIGINAL.clients[1]);
    expect(r.edited).toEqual([{ groupId: SHARMA.groupId, name: 'Sharma Interiors Pvt', code: 'SHA' }]);
    await applyGroupChanges(file, { edit: [{ groupId: SHARMA.groupId, meetingKeywords: [] }] }, { db });
    expect(read().clients[0]).not.toHaveProperty('meetingKeywords');
  });

  it('applies unapprove, then edit, then approve, in that order', async () => {
    const db = await openFreshDb();
    // Mehta's code freed in the file and never stored in the DB, so a new group may take it in the same save.
    await applyGroupChanges(file, { approve: [{ groupId: DESAI, name: 'Desai', code: 'MEH' }], unapprove: [MEHTA.groupId] }, { db });
    expect(read().clients.map((c) => c.code)).toEqual(['SHA', 'MEH']);
    expect(read().clients[1]!.groupId).toBe(DESAI);
  });

  it('keeps the previous file as .bak', async () => {
    const db = await seededDb();
    const before = readFileSync(file, 'utf8');
    await applyGroupChanges(file, { unapprove: [MEHTA.groupId] }, { db });
    expect(readFileSync(`${file}.bak`, 'utf8')).toBe(before);
    const second = readFileSync(file, 'utf8');
    await applyGroupChanges(file, { approve: [{ groupId: DESAI, name: 'Desai', code: 'DES' }] }, { db });
    expect(readFileSync(`${file}.bak`, 'utf8')).toBe(second);
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  it('a validation failure writes nothing: the file and .bak are untouched', async () => {
    const db = await seededDb();
    writeFileSync(`${file}.bak`, 'old backup');
    const before = readFileSync(file, 'utf8');
    const err = await applyGroupChanges(file, { approve: [{ groupId: DESAI, name: 'Desai', code: 'DES', meetingKeywords: ['c++'] }] }, { db })
      .then(unexpected, (e: unknown) => e as GroupChangeError);
    expect(err).toBeInstanceOf(GroupChangeError);
    expect(err.field).toBe('meetingKeywords');
    expect(err.message).not.toMatch(/allowed-groups\.json|clients\.\d/);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(readFileSync(`${file}.bak`, 'utf8')).toBe('old backup');
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  it('a failing rename leaves the original and .bak intact, removes the temporary files, and shows no path', async () => {
    const db = await seededDb();
    writeFileSync(`${file}.bak`, 'old backup');
    const before = readFileSync(file, 'utf8');
    const ops: Partial<FileOps> = { rename: (from) => { throw Object.assign(new Error(`EBUSY: rename '${from}'`), { code: 'EBUSY' }); } };
    const err = await applyGroupChanges(file, { unapprove: [MEHTA.groupId] }, { db, ops }).then(unexpected, (e: unknown) => e as GroupChangeError);
    expect(err).toMatchObject({ name: 'GroupChangeError', field: 'file', message: 'Could not save the groups file on the Mac. Nothing was changed.' });
    expect(err.message).not.toContain(dir);
    expect((err.cause as Error).message).toContain('EBUSY');
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(readFileSync(`${file}.bak`, 'utf8')).toBe('old backup');
    expect(existsSync(`${file}.tmp`)).toBe(false);
    expect(existsSync(`${file}.bak.tmp`)).toBe(false);
  });

  it('a failure on the final rename only: the original intact, .bak holds that same version', async () => {
    const db = await seededDb();
    const before = readFileSync(file, 'utf8');
    const ops: Partial<FileOps> = {
      rename: (from, to) => {
        if (to === file) throw new Error('EPERM');
        renameSync(from, to);
      },
    };
    await expect(applyGroupChanges(file, { unapprove: [MEHTA.groupId] }, { db, ops })).rejects.toBeInstanceOf(GroupChangeError);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(readFileSync(`${file}.bak`, 'utf8')).toBe(before);
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  it('a missing file is a GroupChangeError with no path in the message', async () => {
    rmSync(file);
    const err = await applyGroupChanges(file, { unapprove: [MEHTA.groupId] }, { db: await seededDb() }).then(unexpected, (e: unknown) => e as GroupChangeError);
    expect(err).toMatchObject({ name: 'GroupChangeError', field: 'file' });
    expect(err.message).not.toContain(dir);
  });

  it('an entry without a group id, name or code is refused as a file problem', async () => {
    writeFileSync(file, text({ clients: [null, ORIGINAL.clients[1]] }));
    await expect(applyGroupChanges(file, { unapprove: [MEHTA.groupId] }, { db: await seededDb() })).rejects.toMatchObject({ field: 'file' });
    writeFileSync(file, text({ clients: [{ groupId: SHARMA.groupId, name: 5, code: 'SHA' }] }));
    await expect(applyGroupChanges(file, { approve: [{ groupId: DESAI, name: 'D', code: 'DES' }] }, { db: await seededDb() })).rejects.toMatchObject({ field: 'file' });
  });

  it('the example group id is refused, with a dashboard message (no terminal advice), and nothing is written', async () => {
    const before = readFileSync(file, 'utf8');
    await expect(applyGroupChanges(file, { approve: [{ groupId: '120363000000000001@g.us', name: 'X', code: 'XYZ' }] }, { db: await seededDb() }))
      .rejects.toThrow('This is the example group id, not a real WhatsApp group.');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('edit runs after unapprove and before approve: editing a group removed or added in the same save is refused', async () => {
    const db = await seededDb();
    await expect(applyGroupChanges(file, { unapprove: [MEHTA.groupId], edit: [{ groupId: MEHTA.groupId, name: 'M' }] }, { db }))
      .rejects.toThrow('This group is not approved.');
    await expect(applyGroupChanges(file, { approve: [{ groupId: DESAI, name: 'Desai', code: 'DES' }], edit: [{ groupId: DESAI, name: 'D' }] }, { db }))
      .rejects.toThrow('This group is not approved.');
  });

  it('an edit that changes nothing gives no edited line; two edits of one group give one line with the final values', async () => {
    const db = await seededDb();
    const same = await applyGroupChanges(file, { edit: [{ groupId: MEHTA.groupId, name: 'Mehta Foods' }] }, { db });
    expect(same.edited).toEqual([]);
    const twice = await applyGroupChanges(file, { edit: [{ groupId: MEHTA.groupId, name: 'Mehta 1' }, { groupId: MEHTA.groupId, name: 'Mehta 2' }] }, { db });
    expect(twice.edited).toEqual([{ groupId: MEHTA.groupId, name: 'Mehta 2', code: 'MEH' }]);
  });

  it('a bad email domain names the field and the group in plain words', async () => {
    const err = await applyGroupChanges(file, { approve: [{ groupId: DESAI, name: 'Desai', code: 'DES', emailDomains: ['not a domain'] }] }, { db: await seededDb() })
      .then(unexpected, (e: unknown) => e as GroupChangeError);
    expect(err).toMatchObject({ name: 'GroupChangeError', field: 'emailDomains', groupId: DESAI });
    expect(err.message).toMatch(/^Email domain /);
    expect(err.message).not.toMatch(/emailDomains|clients\.\d/);
  });

  it('a list that is not a list of strings is a GroupChangeError, not a crash', async () => {
    await expect(applyGroupChanges(file, { edit: [{ groupId: MEHTA.groupId, emailDomains: 'mehta.in' as unknown as string[] }] }, { db: await seededDb() }))
      .rejects.toMatchObject({ name: 'GroupChangeError', field: 'emailDomains', groupId: MEHTA.groupId });
    await expect(applyGroupChanges(file, { approve: [{ groupId: DESAI, name: 'D', code: 'DES', meetingKeywords: [5] as unknown as string[] }] }, { db: await seededDb() }))
      .rejects.toMatchObject({ name: 'GroupChangeError', field: 'meetingKeywords' });
  });

  it('edits that end where they started change nothing: no edited line, and the file and .bak are not rewritten', async () => {
    const db = await seededDb();
    writeFileSync(`${file}.bak`, 'old backup');
    const before = readFileSync(file, 'utf8');
    const r = await applyGroupChanges(file, { edit: [{ groupId: MEHTA.groupId, name: 'Other' }, { groupId: MEHTA.groupId, name: 'Mehta Foods' }] }, { db });
    expect(r.edited).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(readFileSync(`${file}.bak`, 'utf8')).toBe('old backup');
  });

  it('trims the code, the name and list items, and drops blank list items', async () => {
    await applyGroupChanges(file, { approve: [{ groupId: DESAI, name: '  Desai  ', code: ' DES ', meetingKeywords: ['  desai launch ', '  '] }] }, { db: await seededDb() });
    expect(read().clients.at(-1)).toEqual({ groupId: DESAI, name: 'Desai', code: 'DES', meetingKeywords: ['desai launch'] });
  });

  describe('code rules', () => {
    it.each(['de', 'DESAI', 'D3S', 'des', 'DE S'])('refuses the code %j', async (code) => {
      await expect(applyGroupChanges(file, { approve: [{ groupId: DESAI, name: 'Desai', code }] }, { db: await seededDb() }))
        .rejects.toMatchObject({ name: 'GroupChangeError', field: 'code', groupId: DESAI });
    });

    it('refuses a code another group in the file has', async () => {
      await expect(applyGroupChanges(file, { approve: [{ groupId: DESAI, name: 'Desai', code: 'SHA' }] }, { db: await seededDb() }))
        .rejects.toThrow('Code SHA is already used by Sharma Interiors');
    });

    it('refuses a code two new groups both take', async () => {
      await expect(applyGroupChanges(file, {
        approve: [{ groupId: DESAI, name: 'Desai', code: 'DES' }, { groupId: PATEL, name: 'Patel', code: 'DES' }],
      }, { db: await seededDb() })).rejects.toThrow('Code DES is already used by Desai');
    });

    it('refuses a code a client in the database used, even an inactive one', async () => {
      const db = await seededDb();
      await syncClients(db, [SHARMA]); // Mehta inactive
      writeFileSync(file, text({ clients: [ORIGINAL.clients[0]] }));
      await expect(applyGroupChanges(file, { approve: [{ groupId: DESAI, name: 'Desai', code: 'MEH' }] }, { db }))
        .rejects.toThrow('Code MEH is already used by Mehta Foods');
    });

    it('re-approving a removed group must keep its stored code', async () => {
      const db = await seededDb();
      writeFileSync(file, text({ clients: [ORIGINAL.clients[0]] }));
      await expect(applyGroupChanges(file, { approve: [{ groupId: MEHTA.groupId, name: 'Mehta Foods', code: 'MEF' }] }, { db }))
        .rejects.toThrow('Client codes are permanent because task IDs use them. Keep code MEH for Mehta Foods.');
      await applyGroupChanges(file, { approve: [{ groupId: MEHTA.groupId, name: 'Mehta Foods', code: 'MEH' }] }, { db });
      expect(read().clients.map((c) => c.code)).toEqual(['SHA', 'MEH']);
    });

    it('refuses approving a group that is already approved, and changing an unknown group', async () => {
      const db = await seededDb();
      await expect(applyGroupChanges(file, { approve: [{ groupId: SHARMA.groupId, name: 'S', code: 'SHA' }] }, { db }))
        .rejects.toThrow('This group is already approved');
      await expect(applyGroupChanges(file, { unapprove: [DESAI] }, { db })).rejects.toThrow('This group is not approved');
      await expect(applyGroupChanges(file, { edit: [{ groupId: DESAI, name: 'X' }] }, { db })).rejects.toThrow('This group is not approved');
    });
  });

  it('refuses a name that is empty or too long, naming the field', async () => {
    const db = await seededDb();
    await expect(applyGroupChanges(file, { approve: [{ groupId: DESAI, name: '  ', code: 'DES' }] }, { db }))
      .rejects.toMatchObject({ field: 'name', message: 'Enter a client name (1 to 80 characters).' });
    await expect(applyGroupChanges(file, { edit: [{ groupId: SHARMA.groupId, name: 'x'.repeat(81) }] }, { db }))
      .rejects.toMatchObject({ field: 'name' });
  });

  it('reads a file saved with a byte-order mark', async () => {
    writeFileSync(file, `﻿${text(ORIGINAL)}`);
    await applyGroupChanges(file, { unapprove: [MEHTA.groupId] }, { db: await seededDb() });
    expect(parseGroupsFile(readFileSync(file, 'utf8')).map((c) => c.code)).toEqual(['SHA']);
  });

  it('a file that is not valid JSON is refused, and left as it is', async () => {
    writeFileSync(file, '{ "clients": [');
    await expect(applyGroupChanges(file, { unapprove: [MEHTA.groupId] }, { db: await seededDb() })).rejects.toBeInstanceOf(GroupChangeError);
    expect(readFileSync(file, 'utf8')).toBe('{ "clients": [');
  });

  it('concurrent calls run one after the other, in call order', async () => {
    const db = await seededDb();
    const a = applyGroupChanges(file, { approve: [{ groupId: DESAI, name: 'Desai', code: 'DES' }] }, { db });
    const b = applyGroupChanges(file, { approve: [{ groupId: PATEL, name: 'Patel', code: 'PAT' }] }, { db });
    const c = applyGroupChanges(file, { approve: [{ groupId: PATEL, name: 'Patel again', code: 'PAX' }] }, { db });
    await a;
    await b;
    await expect(c).rejects.toThrow('This group is already approved');
    expect(read().clients.map((x) => x.code)).toEqual(['SHA', 'MEH', 'DES', 'PAT']);
  });

  it('a failed call does not block the next one', async () => {
    const db = await seededDb();
    await expect(applyGroupChanges(file, { unapprove: [DESAI] }, { db })).rejects.toThrow();
    await applyGroupChanges(file, { unapprove: [MEHTA.groupId] }, { db });
    expect(read().clients).toHaveLength(1);
  });
});

async function openFreshDb() {
  const db = await seededDb();
  await db.run('DELETE FROM clients');
  return db;
}

function unexpected(): never {
  throw new Error('expected applyGroupChanges to fail');
}
