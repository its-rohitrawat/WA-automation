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

/**
 * The string and template literals of a file's code, with where each starts: the SQL lives there, and TypeScript's own
 * `as` never does. A template's ${…} becomes a placeholder. Comments are left out.
 */
export function literals(code: string): { text: string; at: number }[] {
  const out: { text: string; at: number }[] = [];
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!;
    if (ch === '/' && code[i + 1] === '/') {
      i = code.indexOf('\n', i);
      if (i < 0) break;
    } else if (ch === '/' && code[i + 1] === '*') {
      i = code.indexOf('*/', i + 2) + 1;
      if (i <= 0) break;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      let text = '';
      let j = i + 1;
      for (; j < code.length && code[j] !== ch; j++) {
        if (code[j] === '\\') {
          text += code[j + 1] ?? '';
          j++;
        } else if (ch === '`' && code[j] === '$' && code[j + 1] === '{') {
          let depth = 1;
          for (j += 2; j < code.length && depth > 0; j++) {
            if (code[j] === '{') depth++;
            else if (code[j] === '}') depth--;
          }
          j--;
          text += ' _ ';
        } else text += code[j];
      }
      out.push({ text, at: i });
      i = j;
    }
  }
  return out;
}

/** Top-level clause words a SELECT column never crosses going back: an AS after them names a table, not a value. */
const CLAUSE = /^(?:FROM|JOIN|WHERE|ON|GROUP|ORDER|HAVING|LIMIT|UNION|USING|INTO|UPDATE|TABLE|VIEW|INDEX|WITH)$/i;
const START = /^(?:SELECT|DISTINCT|RETURNING)$/i;

/** Each SELECTed value named with AS (`<expression> AS name`), as its expression text. Table aliases are left out. */
export function selectedValues(sql: string): string[] {
  const out: string[] = [];
  const s = sql.replace(/'(?:[^']|'')*'/g, "''");
  for (const m of s.matchAll(/\bAS\s+"?[A-Za-z_]\w*"?/g)) {
    let depth = 0;
    let i = m.index! - 1;
    let start = 0;
    let isColumn = true;
    for (; i >= 0; i--) {
      const ch = s[i]!;
      if (ch === ')') depth++;
      else if (ch === '(') {
        if (depth === 0) {
          start = i + 1; // CAST(x AS text), or a sub-select's first column
          break;
        }
        depth--;
      } else if (depth === 0 && ch === ',') {
        start = i + 1;
        break;
      } else if (depth === 0 && /[A-Za-z]/.test(ch) && (i === 0 || !/\w/.test(s[i - 1]!))) {
        const word = /^[A-Za-z_]\w*/.exec(s.slice(i))![0];
        if (START.test(word)) {
          start = i + word.length;
          break;
        }
        if (CLAUSE.test(word)) {
          isColumn = false;
          break;
        }
      }
    }
    if (isColumn && i >= 0) out.push(s.slice(start, m.index!));
  }
  return out;
}

/** Each value assigned in an UPDATE's SET (`col = <expression>`), as its expression text. */
export function setValues(sql: string): string[] {
  const out: string[] = [];
  const s = sql.replace(/'(?:[^']|'')*'/g, "''");
  for (const m of s.matchAll(/\bSET\s+/g)) {
    let rest = s.slice(m.index! + m[0].length);
    // The SET list ends at the first top-level WHERE, FROM or RETURNING.
    const end = /\b(?:WHERE|FROM|RETURNING)\b/i;
    let depth = 0;
    let cut = rest.length;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '(') depth++;
      else if (rest[i] === ')') {
        if (depth === 0) {
          cut = i;
          break;
        }
        depth--;
      } else if (depth === 0 && end.test(rest.slice(i, i + 9)) && (i === 0 || !/\w/.test(rest[i - 1]!)) && end.exec(rest.slice(i))!.index === 0) {
        cut = i;
        break;
      }
    }
    rest = rest.slice(0, cut);
    for (const a of splitArguments(rest)) {
      const eq = /^\s*[A-Za-z_][\w.]*\s*=(?!=)/.exec(a);
      if (eq) out.push(a.slice(eq[0].length));
    }
  }
  return out;
}
