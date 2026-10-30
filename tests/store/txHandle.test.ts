import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAst } from 'vite';
import { describe, expect, it } from 'vitest';

// Inside db.tx(async (q) => …), a database call must use q. On the async engine a call on the outer handle inside the
// transaction throws TxMisuseError (or, on Postgres, would run outside the transaction and outside its tenant lock).
// This test finds every function in src that is async and takes a Sql as its first parameter (a store call), and fails
// when such a call inside a transaction callback is given anything other than that callback's handle. Functions whose
// first parameter is a Db and that take the transaction as a later, optional q (the corrections, applyTaskAction) are
// not store calls in this sense, so their deliberate (db, …, q) calls are not flagged. The parser is vite's (vitest's
// own dependency).

type Node = { type: string; start: number; end: number; parent?: Node; [k: string]: unknown };
const SRC = join(import.meta.dirname, '../../src');
const FN = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

function walk(node: Node, parent: Node | undefined, visit: (n: Node) => void): void {
  node.parent = parent;
  visit(node);
  for (const [k, v] of Object.entries(node)) {
    if (k === 'parent') continue;
    if (Array.isArray(v)) for (const c of v) { if (c && typeof (c as Node).type === 'string') walk(c as Node, node, visit); }
    else if (v && typeof (v as Node).type === 'string') walk(v as Node, node, visit);
  }
}

const parse = (text: string, file: string) => parseAst(text, { lang: 'ts' }, file) as unknown as Node;

/** Names of async functions whose first parameter is typed Sql. */
function storeCalls(text: string, file: string): string[] {
  const out: string[] = [];
  walk(parse(text, file), undefined, (n) => {
    const fn = n.type === 'FunctionDeclaration' ? n
      : n.type === 'VariableDeclarator' && FN.has((n.init as Node | null)?.type ?? '') ? (n.init as Node) : null;
    if (!fn || !fn.async) return;
    const first = (fn.params as Node[])[0] as (Node & { typeAnnotation?: { typeAnnotation?: Node } }) | undefined;
    const type = first?.typeAnnotation?.typeAnnotation;
    if (!type || text.slice(type.start, type.end) !== 'Sql') return;
    const id = (n.type === 'FunctionDeclaration' ? n.id : n.id) as { name?: string } | null;
    if (id?.name) out.push(id.name);
  });
  return out;
}

/** Calls to `names` inside a .tx(async (h) => …) callback whose first argument is not h, as `file:line name(arg, …)`. */
function outerHandleCalls(text: string, file: string, names: ReadonlySet<string>): string[] {
  const out: string[] = [];
  walk(parse(text, file), undefined, (n) => {
    const callee = n.callee as Node & { name?: string } | undefined;
    if (n.type !== 'CallExpression' || callee?.type !== 'Identifier' || !names.has(callee.name!)) return;
    for (let p = n.parent; p; p = p.parent) {
      if (!FN.has(p.type)) continue;
      const call = p.parent;
      const isTx = call?.type === 'CallExpression' && (call.arguments as Node[])[0] === p
        && (call.callee as Node).type === 'MemberExpression' && ((call.callee as Node).property as { name?: string }).name === 'tx';
      if (!isTx) continue;
      const handle = ((p.params as Node[])[0] as { name?: string } | undefined)?.name;
      const arg = (n.arguments as Node[])[0];
      const first = arg ? text.slice(arg.start, arg.end) : '';
      if (handle && first !== handle) out.push(`${file}:${text.slice(0, n.start).split('\n').length} ${callee.name}(${first}, …)`);
      break;
    }
  });
  return out;
}

const files = readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts')).map((f) => f.replaceAll('\\', '/'));
const sources = new Map(files.map((f) => [f, readFileSync(join(SRC, f), 'utf8')]));

describe('database calls inside a transaction use its handle', () => {
  it('finds the store calls (the check is not empty)', () => {
    const names = new Set([...sources].flatMap(([f, t]) => storeCalls(t, f)));
    for (const n of ['getKv', 'setKv', 'createTask', 'insertMessage', 'getMeeting', 'syncClients']) expect(names.has(n), n).toBe(true);
  });

  it('flags a call on the outer handle inside a transaction, and accepts one on the handle', () => {
    const snippet = `async function getKv(db: Sql, k: string) {}
async function f(db: Db) {
  await db.tx(async (q) => { await getKv(db, 'a'); await getKv(q, 'b'); });
}`;
    expect(outerHandleCalls(snippet, 'x.ts', new Set(storeCalls(snippet, 'x.ts')))).toEqual(['x.ts:3 getKv(db, …)']);
  });

  it('no store call in src gets the outer handle inside a transaction', () => {
    const names = new Set([...sources].flatMap(([f, t]) => storeCalls(t, f)));
    expect([...sources].flatMap(([f, t]) => outerHandleCalls(t, f, names))).toEqual([]);
  });
});
