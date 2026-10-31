import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// The pieces the SQL portability scans share (tests/store/pg: sumPortable, coalescePortable, minMaxPortable): the src
// files, a call's argument text, and the test for a comparison or a boolean at an argument's top level.

export const SRC = join(import.meta.dirname, '../../src');

/** Every .ts file under src, as a path relative to it with forward slashes. */
export function srcFiles(dir = SRC): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...srcFiles(p));
    else if (e.name.endsWith('.ts')) out.push(relative(SRC, p).split(sep).join('/'));
  }
  return out.sort();
}

/** A src file's text with its whole-line comments (// …, and the lines of a /** … *\/ block) blanked, lines kept. */
export function codeOf(path: string, text = readFileSync(join(SRC, path), 'utf8')): string {
  return text.split(/\r?\n/).map((l) => (/^\s*(\/\/|\/\*|\*)/.test(l) ? '' : l)).join('\n');
}

/** The text from `open` (just past a parenthesis) to its matching close, with quoted strings skipped. */
export function argument(text: string, open: number): string {
  let depth = 1;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      const end = text.indexOf(ch, i + 1);
      if (end < 0) break;
      i = end;
    } else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return text.slice(open, i);
  }
  return text.slice(open);
}

/** The argument with its quoted strings blanked and its nested parentheses collapsed: only the top level is left. */
export function topLevel(arg: string): string {
  let s = arg.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g, "''").replace(/->>?/g, ' ');
  // Innermost first, each to a mark with no parentheses, so the next pass reaches the level around it.
  for (let prev = ''; prev !== s; ) {
    prev = s;
    s = s.replace(/\([^()]*\)/g, ' _ ');
  }
  return s;
}

/** True for an expression that is a comparison or a boolean at its top level (not a CASE or a plain value). */
export function isBoolean(expr: string): boolean {
  if (/^\s*CASE\b/i.test(expr)) return false;
  return /<>|!=|<=|>=|=|<|>|\b(?:AND|OR|NOT|IS|IN|LIKE|ILIKE|BETWEEN|EXISTS)\b/i.test(topLevel(expr));
}

/** A call's arguments, split at its top-level commas (each one's own text, nested calls and strings kept). */
export function splitArguments(arg: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < arg.length; i++) {
    const ch = arg[i];
    if (ch === "'" || ch === '"') {
      const end = arg.indexOf(ch, i + 1);
      if (end < 0) break;
      i = end;
    } else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(arg.slice(from, i));
      from = i + 1;
    }
  }
  out.push(arg.slice(from));
  return out;
}

/** 1-based line of an index in a text. */
export const lineAt = (text: string, at: number): number => text.slice(0, at).split('\n').length;
