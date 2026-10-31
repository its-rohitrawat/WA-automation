// Counts the direct database calls per file (S1 inventory). Read-only: prints a table, changes nothing.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = 'src';
const rows: { file: string; prepare: number; tx: number; raw: number }[] = [];
for (const f of readdirSync(SRC, { recursive: true, encoding: 'utf8' })) {
  if (!f.endsWith('.ts')) continue;
  const text = readFileSync(join(SRC, f), 'utf8');
  const count = (re: RegExp) => (text.match(re) ?? []).length;
  const row = { file: f.replaceAll('\\', '/'), prepare: count(/\.prepare\(/g), tx: count(/\.transaction\(|\btx\(|\btxSync\(/g), raw: count(/\.raw\b/g) };
  if (row.prepare + row.tx + row.raw > 0) rows.push(row);
}
rows.sort((a, b) => b.prepare - a.prepare || a.file.localeCompare(b.file));
for (const r of rows) console.log(`${r.file}\tprepare=${r.prepare}\ttx=${r.tx}\traw=${r.raw}`);
console.log(`files=${rows.length} prepare=${rows.reduce((s, r) => s + r.prepare, 0)}`);
