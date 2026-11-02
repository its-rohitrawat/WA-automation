import { createHash } from 'node:crypto';

// The copy tool's checksum (S3): one canonical string per value, so a table read from SQLite and the same table read
// from Postgres give the same checksum. Numbers by their shortest round-trip form (int8 comes back as a number, S2 4.1),
// text as JSON, bytes as hex; each kind has its own first letter, so '42' and 42, or '' and NULL, never look alike.

const SEP = String.fromCharCode(31); // between columns: JSON text never contains a raw control character

export function canonicalValue(v: unknown): string {
  if (v === null || v === undefined) return 'N';
  if (typeof v === 'number') return `n${Object.is(v, -0) ? 0 : v}`;
  if (typeof v === 'string') return `s${JSON.stringify(v)}`;
  if (v instanceof Uint8Array) return `b${Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('hex')}`;
  throw new Error(`cannot compare a ${typeof v === 'object' ? 'object' : typeof v} value`);
}

export interface TableSum {
  rows: number;
  sha256: string;
}

/** The checksum of a table's rows over the given columns: each row a canonical line, the lines sorted, then SHA-256. */
export function tableChecksum(columns: readonly string[], rows: readonly Record<string, unknown>[]): TableSum {
  const lines = rows.map((r) => columns.map((c) => canonicalValue(r[c])).join(SEP));
  lines.sort();
  const h = createHash('sha256');
  for (const l of lines) h.update(l).update('\n');
  return { rows: rows.length, sha256: h.digest('hex') };
}
