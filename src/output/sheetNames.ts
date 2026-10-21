const MAX = 31;

export function sanitizeSheetName(name: string): string {
  const cleaned = name
    .replace(/[[\]:*?/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^'+|'+$/g, '')
    .trim();
  return (cleaned || 'Client').slice(0, MAX).trim();
}

export function uniqueSheetNames(names: string[], reserved: string[] = ['Overview']): string[] {
  const used = new Set(reserved.map((r) => r.toLowerCase()));
  return names.map((n) => {
    const base = sanitizeSheetName(n);
    let candidate = base;
    for (let i = 2; used.has(candidate.toLowerCase()); i++) {
      const suffix = ` (${i})`;
      candidate = base.slice(0, MAX - suffix.length).trim() + suffix;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  });
}
