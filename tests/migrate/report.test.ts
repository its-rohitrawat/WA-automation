import { describe, expect, it } from 'vitest';
import type { CopyReport } from '../../src/migrate/copy.ts';
import { formatReport } from '../../src/migrate/report.ts';

const sum = (rows: number, sha: string) => ({ rows, sha256: sha.repeat(64 / sha.length) });
const t = (table: string, targetTable: string, a: [number, string], b: [number, string]) => ({
  table, targetTable, source: sum(...a), target: sum(...b), match: a[0] === b[0] && a[1] === b[1],
});

describe('the copy report', () => {
  it('one line per table with counts and short checksums, then the dry-run verdict', () => {
    const r: CopyReport = { ok: true, applied: false, backup: null, tables: [t('tracker:clients', 'clients', [2, 'ab'], [2, 'ab']), t('session:auth', 'wa_auth', [913, 'cd'], [913, 'cd'])] };
    expect(formatReport(r, 'copy').split('\n')).toEqual([
      'tracker:clients -> clients    2 rows  abababababab = abababababab  OK',
      'session:auth    -> wa_auth  913 rows  cdcdcdcdcdcd = cdcdcdcdcdcd  OK',
      'DRY RUN: every table matched. Nothing was written. Run again with --apply --backup-dir <a new folder>.',
    ]);
  });

  it('applied, with the backup folder', () => {
    const r: CopyReport = { ok: true, applied: true, backup: '/opt/wa-agent-db/copy-backup-1', tables: [t('tracker:clients', 'clients', [2, 'ab'], [2, 'ab'])] };
    expect(formatReport(r, 'copy').split('\n').at(-1)).toBe('APPLIED: every table matched, and the copy is committed. The checked backup is in /opt/wa-agent-db/copy-backup-1.');
  });

  it('a mismatch names the tables and says nothing was written', () => {
    const r: CopyReport = { ok: false, applied: false, backup: null, tables: [t('tracker:tasks', 'tasks', [3, 'ab'], [3, 'ef']), t('tracker:kv', 'kv', [1, 'ab'], [0, 'cd'])] };
    const lines = formatReport(r, 'copy').split('\n');
    expect(lines[0]).toBe('tracker:tasks -> tasks  3 rows  abababababab != efefefefefef  MISMATCH');
    expect(lines[1]).toBe('tracker:kv    -> kv     1 rows  abababababab != cdcdcdcdcdcd  MISMATCH (Postgres has 0 rows)');
    expect(lines.at(-1)).toBe('MISMATCH in 2 tables (tracker:tasks, tracker:kv): nothing was written. Send these lines to Claude.');
  });

  it('the export back speaks of new SQLite files', () => {
    const ok: CopyReport = { ok: true, applied: true, backup: null, tables: [t('tracker:clients', 'clients', [2, 'ab'], [2, 'ab'])] };
    expect(formatReport(ok, 'export').split('\n').at(-1)).toBe('EXPORTED: every table matched. The new SQLite files are ready; data/ was not touched.');
    const bad: CopyReport = { ...ok, ok: false, tables: [t('tracker:clients', 'clients', [2, 'ab'], [1, 'cd'])] };
    expect(formatReport(bad, 'export').split('\n').at(-1)).toBe('MISMATCH in 1 table (tracker:clients): do not use these files. Use rollback A instead, and send these lines to Claude.');
  });
});
