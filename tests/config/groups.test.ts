import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PHASES, parseGroupsFile, watchGroupsFile } from '../../src/config/groups.ts';

const valid = (extra: object = {}) => JSON.stringify({ clients: [{ groupId: '120363000000000001@g.us', name: 'Sharma Interiors', code: 'SHA', ...extra }] });

describe('parseGroupsFile', () => {
  it('parses a client and fills defaults', () => {
    const [c] = parseGroupsFile(valid());
    expect(c).toEqual({ groupId: '120363000000000001@g.us', name: 'Sharma Interiors', code: 'SHA', phases: DEFAULT_PHASES, emailDomains: [], meetingKeywords: [] });
  });

  it('rejects a group id that is not a group', () => {
    expect(() => parseGroupsFile(valid({ groupId: '919800000000@s.whatsapp.net' }))).toThrowError(/groupId/);
  });

  it('rejects a bad code', () => {
    expect(() => parseGroupsFile(valid({ code: 'sh' }))).toThrowError(/code/);
  });

  it('rejects duplicate groups and codes', () => {
    const dupGroup = JSON.stringify({ clients: [
      { groupId: '120363000000000001@g.us', name: 'A', code: 'AAA' },
      { groupId: '120363000000000001@g.us', name: 'B', code: 'BBB' },
    ] });
    const dupCode = JSON.stringify({ clients: [
      { groupId: '120363000000000001@g.us', name: 'A', code: 'AAA' },
      { groupId: '120363000000000002@g.us', name: 'B', code: 'AAA' },
    ] });
    expect(() => parseGroupsFile(dupGroup)).toThrowError(/twice/);
    expect(() => parseGroupsFile(dupCode)).toThrowError(/twice/);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseGroupsFile('{nope')).toThrowError(/not valid JSON/);
  });
});

describe('watchGroupsFile', () => {
  it('calls back with the new list when the file changes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wa-groups-'));
    const file = join(dir, 'allowed-groups.json');
    writeFileSync(file, valid());
    const onChange = vi.fn();
    const stop = watchGroupsFile(file, onChange, () => {}, 20);
    await new Promise((r) => setTimeout(r, 60));
    writeFileSync(file, valid({ name: 'Sharma Interiors Pvt Ltd' }));
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 2000 });
    expect(onChange.mock.calls.at(-1)?.[0][0].name).toBe('Sharma Interiors Pvt Ltd');
    stop();
  });
});
