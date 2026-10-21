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
