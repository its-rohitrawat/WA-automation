// Test fixture for the parser runner: a parser that keeps allocating until its worker runs out of memory.
export {};
const kept: unknown[] = [];
for (;;) kept.push({ s: 'x'.repeat(64) + Math.random() });
