// Test fixture for the parser runner: a parser that prints to the console (as a library warning might), then replies.
import { parentPort } from 'node:worker_threads';

const NOISE = 'parser-console-noise-5d1c';
console.log(`${NOISE} log`);
console.warn(`${NOISE} warn`);
console.error(`${NOISE} error`);
process.stdout.write(`${NOISE} stdout\n`);
process.stderr.write(`${NOISE} stderr\n`);
// Reply a little later, so the console output is already on its way when the runner gets the answer.
setTimeout(() => parentPort?.postMessage({ ok: true, result: { text: 'replied', pageCount: null } }), 100);
