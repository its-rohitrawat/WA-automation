const MAX = 31;

/** Keeps whole code points while staying within MAX UTF-16 units (what Excel and exceljs count). */
function cut(s: string, max = MAX): string {
  let out = '';
  for (const ch of s) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

const edge = (s: string) => s.replace(/^[\s']+|[\s']+$/g, '');

export function sanitizeSheetName(name: string): string {
  // "!" would break exceljs's internal-link detection, so it goes too.
  const spaced = name.replace(/[[\]:*?/\\!]/g, ' ').replace(/\s+/g, ' ');
  return edge(cut(spaced)) || 'Client';
}

/** Names are assigned in the order given (callers pass client-id order) so an existing suffix never moves. */
export function uniqueSheetNames(names: string[], reserved: string[] = ['Overview', 'History']): string[] {
  const used = new Set(reserved.map((r) => r.toLowerCase()));
  return names.map((n) => {
    const base = sanitizeSheetName(n);
    let candidate = base;
    for (let i = 2; used.has(candidate.toLowerCase()); i++) {
      const suffix = ` (${i})`;
      candidate = edge(cut(base, MAX - suffix.length)) + suffix;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  });
}
