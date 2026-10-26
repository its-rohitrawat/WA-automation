import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PHASES, GROUPS_FILE_MISSING_MESSAGE, loadGroupsFile, parseGroupsFile, watchGroupsFile } from '../../src/config/groups.ts';

const valid = (extra: object = {}) => JSON.stringify({ clients: [{ groupId: '120363000000000011@g.us', name: 'Sharma Interiors', code: 'SHA', ...extra }] });

describe('parseGroupsFile', () => {
  it('parses a client and fills defaults', () => {
    const [c] = parseGroupsFile(valid());
    expect(c).toEqual({ groupId: '120363000000000011@g.us', name: 'Sharma Interiors', code: 'SHA', phases: DEFAULT_PHASES, emailDomains: [], meetingKeywords: [] });
  });

  it('rejects a group id that is not a group', () => {
    expect(() => parseGroupsFile(valid({ groupId: '919800000000@s.whatsapp.net' }))).toThrowError(/groupId/);
  });

  it('rejects a bad code', () => {
    expect(() => parseGroupsFile(valid({ code: 'sh' }))).toThrowError(/code/);
  });

  it('rejects duplicate groups and codes', () => {
    const dupGroup = JSON.stringify({ clients: [
      { groupId: '120363000000000011@g.us', name: 'A', code: 'AAA' },
      { groupId: '120363000000000011@g.us', name: 'B', code: 'BBB' },
    ] });
    const dupCode = JSON.stringify({ clients: [
      { groupId: '120363000000000011@g.us', name: 'A', code: 'AAA' },
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

describe('example allow-list', () => {
  it('rejects the example group so it cannot become a real client', () => {
    const example = readFileSync('config/allowed-groups.example.json', 'utf8');
    expect(() => parseGroupsFile(example)).toThrowError(/still contains the example group/);
  });

  it('accepts an empty list so list-groups can run first', () => {
    expect(parseGroupsFile('{ "clients": [] }')).toEqual([]);
  });

  it('gives a friendly message when the file is missing', () => {
    expect(() => loadGroupsFile(join(tmpdir(), 'no-such-dir-xyz', 'groups.json'))).toThrowError(GROUPS_FILE_MISSING_MESSAGE);
  });
});

describe('meeting matching rules', () => {
  it('lower-cases and trims emailDomains', () => {
    const [c] = parseGroupsFile(valid({ emailDomains: [' SharmaInteriors.EXAMPLE ', 'sharma.co.example'] }));
    expect(c!.emailDomains).toEqual(['sharmainteriors.example', 'sharma.co.example']);
  });

  it('refuses an emailDomains entry that is not a domain, naming where it is', () => {
    for (const d of ['sharma', 'ops@sharma.example', '', 'https://sharma.example']) {
      expect(() => parseGroupsFile(valid({ emailDomains: ['sharma.example', d] }))).toThrowError(/clients\.0\.emailDomains\.1 must look like a domain/);
    }
  });

  it('refuses public mail domains, which would match everyone', () => {
    expect(() => parseGroupsFile(valid({ emailDomains: ['Gmail.com'] }))).toThrowError(/emailDomains\.0 must not be a public mail domain/);
    expect(() => parseGroupsFile(valid({ emailDomains: ['yahoo.co.in'] }))).toThrowError(/public mail domain/);
  });

  it('trims meetingKeywords and keeps them otherwise as written', () => {
    const [c] = parseGroupsFile(valid({ meetingKeywords: ['  Sharma ', 'Kitchen Fit-out'] }));
    expect(c!.meetingKeywords).toEqual(['Sharma', 'Kitchen Fit-out']);
  });

  it('refuses empty or short meetingKeywords', () => {
    for (const k of ['', '   ', 'ab', ' ab ']) {
      expect(() => parseGroupsFile(valid({ meetingKeywords: ['Sharma', k] }))).toThrowError(/meetingKeywords\.1 must be at least 3 characters/);
    }
    expect(parseGroupsFile(valid({ meetingKeywords: ['abc'] }))[0]!.meetingKeywords).toEqual(['abc']);
  });

  it('refuses a meetingKeyword with fewer than 3 characters once punctuation is removed, naming the client code', () => {
    for (const k of ['c++', 'a-b', '...', 'ab\u200b\u200b']) {
      expect(() => parseGroupsFile(valid({ meetingKeywords: ['Sharma', k] }))).toThrowError(/client SHA has a meeting keyword with fewer than 3 letters/);
    }
    expect(parseGroupsFile(valid({ meetingKeywords: ['R&D team'] }))[0]!.meetingKeywords).toEqual(['R&D team']);
  });

  it('allows at most 20 meetingKeywords per client', () => {
    const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`);
    expect(parseGroupsFile(valid({ meetingKeywords: words(20) }))[0]!.meetingKeywords).toHaveLength(20);
    expect(() => parseGroupsFile(valid({ meetingKeywords: words(21) }))).toThrowError(/meetingKeywords at most 20 per client/);
  });
});
