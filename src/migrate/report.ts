import type { CopyReport } from './copy.ts';

// What the copy and the export print: one line per table (names, counts, the first 12 characters of each checksum) and
// a verdict. Never a row's contents. For the counts and checksums, the left side is the source (SQLite for the copy,
// Postgres for the export) and the right side what was written and read back.

const short = (sha: string) => sha.slice(0, 12);

export function formatReport(r: CopyReport, kind: 'copy' | 'export'): string {
  const name = Math.max(...r.tables.map((t) => t.table.length), 0);
  const target = Math.max(...r.tables.map((t) => t.targetTable.length), 0);
  const count = Math.max(...r.tables.map((t) => String(t.source.rows).length), 0);
  const lines = r.tables.map((t) => {
    const head = `${t.table.padEnd(name)} -> ${t.targetTable.padEnd(target)}  ${String(t.source.rows).padStart(count)} rows  ${short(t.source.sha256)} ${t.match ? '=' : '!='} ${short(t.target.sha256)}`;
    if (t.match) return `${head}  OK`;
    return `${head}  MISMATCH${t.target.rows !== t.source.rows ? ` (${kind === 'copy' ? 'Postgres' : 'the new file'} has ${t.target.rows} rows)` : ''}`;
  });
  const bad = r.tables.filter((t) => !t.match);
  const which = `${bad.length} table${bad.length === 1 ? '' : 's'} (${bad.map((t) => t.table).join(', ')})`;
  if (kind === 'copy') {
    if (!r.ok) lines.push(`MISMATCH in ${which}: nothing was written. Send these lines to Claude.`);
    else if (!r.applied) lines.push('DRY RUN: every table matched. Nothing was written. Run again with --apply --backup-dir <a new folder>.');
    else lines.push(`APPLIED: every table matched, and the copy is committed. The checked backup is in ${r.backup}.`);
  } else if (!r.ok) {
    lines.push(`MISMATCH in ${which}: do not use these files. Use rollback A instead, and send these lines to Claude.`);
  } else {
    lines.push('EXPORTED: every table matched. The new SQLite files are ready; data/ was not touched.');
  }
  return lines.join('\n');
}
