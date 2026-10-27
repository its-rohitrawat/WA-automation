import { describe, expect, it } from 'vitest';
import { sanitizeSheetName, uniqueSheetNames } from '../../src/output/sheetNames.ts';

describe('sheet names', () => {
  it("removes characters Excel forbids and keeps 31 characters", () => {
    expect(sanitizeSheetName('Sharma/Interiors: [Phase 2]?')).toBe('Sharma Interiors Phase 2');
    expect(sanitizeSheetName('A very long client name that goes on and on')).toBe('A very long client name that go');
    expect(sanitizeSheetName("'''")).toBe('Client');
  });

  it('makes names unique, case-insensitively, and avoids Overview', () => {
    expect(uniqueSheetNames(['Overview', 'Mehta', 'mehta'])).toEqual(['Overview (2)', 'Mehta', 'mehta (2)']);
  });
});

describe('sheet names, round 2', () => {
  it('never ends in an apostrophe after the 31-character cut', () => {
    const n = sanitizeSheetName("Sharma & Sons Interior Design' Studio");
    expect(n).toBe('Sharma & Sons Interior Design');
    expect(n.length).toBeLessThanOrEqual(31);
  });

  it('does not split an emoji and stays within 31 UTF-16 units', () => {
    const n = sanitizeSheetName(`${'a'.repeat(30)}😀`);
    expect(n).toBe('a'.repeat(30));
    expect(sanitizeSheetName(`${'a'.repeat(29)}😀`)).toBe(`${'a'.repeat(29)}😀`);
    expect(sanitizeSheetName(`${'a'.repeat(29)}😀`).length).toBe(31);
  });

  it('strips ! and returns Client when only forbidden characters remain', () => {
    expect(sanitizeSheetName('Yahoo! Studio')).toBe('Yahoo Studio');
    expect(sanitizeSheetName(':/\\?*[]!')).toBe('Client');
    expect(sanitizeSheetName('A\\B')).not.toContain('\\');
  });

  it('reserves History as well as Overview, case-insensitively', () => {
    const out = uniqueSheetNames(['History', 'history']);
    expect(out.map((s) => s.toLowerCase())).not.toContain('history');
    expect(new Set(out.map((s) => s.toLowerCase())).size).toBe(2);
  });

  it('reserves Today, the summary tab, case-insensitively', () => {
    expect(uniqueSheetNames(['Today', 'TODAY'])).toEqual(['Today (2)', 'TODAY (3)']);
  });

  it('keeps suffixed names within 31 units and without a trailing apostrophe', () => {
    const long = "x".repeat(28) + "'' z";
    const out = uniqueSheetNames([long, long]);
    for (const s of out) {
      expect(s.length).toBeLessThanOrEqual(31);
      expect(s.endsWith("'")).toBe(false);
    }
    expect(out[0]).not.toBe(out[1]);
  });

  it('gives earlier names stable suffixes when a later name collides', () => {
    expect(uniqueSheetNames(['Acme', 'acme'])).toEqual(['Acme', 'acme (2)']);
    expect(uniqueSheetNames(['Acme', 'acme', 'ACME']).slice(0, 2)).toEqual(['Acme', 'acme (2)']);
  });
});
