import { describe, expect, it } from 'vitest';
import { canonicalValue, tableChecksum } from '../../src/migrate/canonical.ts';

describe('canonical values', () => {
  it('gives one form per value, whichever engine returned it', () => {
    expect(canonicalValue(null)).toBe('N');
    expect(canonicalValue(undefined)).toBe('N');
    expect(canonicalValue(42)).toBe('n42');
    expect(canonicalValue(1.5)).toBe('n1.5');
    expect(canonicalValue(-0)).toBe('n0');
    expect(canonicalValue('a"b')).toBe('s"a\\"b"');
    expect(canonicalValue(Buffer.from([0, 255]))).toBe('b00ff');
    expect(canonicalValue(new Uint8Array([1]))).toBe('b01');
  });

  it('keeps text and numbers apart, and an empty string apart from NULL', () => {
    expect(canonicalValue('42')).not.toBe(canonicalValue(42));
    expect(canonicalValue('')).not.toBe(canonicalValue(null));
  });

  it('reads only the bytes of a view, not the whole buffer behind it', () => {
    const whole = Buffer.from([9, 1, 2, 9]);
    expect(canonicalValue(whole.subarray(1, 3))).toBe('b0102');
  });

  it('refuses a type neither engine returns here (a bigint, a boolean, an object)', () => {
    expect(() => canonicalValue(1n)).toThrow(/bigint/);
    expect(() => canonicalValue(true)).toThrow(/boolean/);
    expect(() => canonicalValue({})).toThrow(/object/);
  });
});

describe('tableChecksum', () => {
  const cols = ['id', 'name'];

  it('does not depend on row order or on extra columns', () => {
    const a = tableChecksum(cols, [{ id: 1, name: 'x' }, { id: 2, name: 'y' }]);
    const b = tableChecksum(cols, [{ id: 2, name: 'y', tenant_id: 'z' }, { id: 1, name: 'x' }]);
    expect(a).toEqual(b);
    expect(a.rows).toBe(2);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when one value changes, when a row is missing, and when a row is doubled', () => {
    const base = tableChecksum(cols, [{ id: 1, name: 'x' }, { id: 2, name: 'y' }]).sha256;
    expect(tableChecksum(cols, [{ id: 1, name: 'X' }, { id: 2, name: 'y' }]).sha256).not.toBe(base);
    expect(tableChecksum(cols, [{ id: 1, name: 'x' }]).sha256).not.toBe(base);
    expect(tableChecksum(cols, [{ id: 1, name: 'x' }, { id: 2, name: 'y' }, { id: 2, name: 'y' }]).sha256).not.toBe(base);
  });

  it('cannot be fooled by moving text across a column boundary', () => {
    const two = ['a', 'b'];
    expect(tableChecksum(two, [{ a: 'x', b: 'yz' }]).sha256).not.toBe(tableChecksum(two, [{ a: 'xy', b: 'z' }]).sha256);
  });

  it('an empty table has a checksum too', () => {
    expect(tableChecksum(cols, [])).toEqual({ rows: 0, sha256: tableChecksum(['other'], []).sha256 });
  });
});
