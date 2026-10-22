// Test fixture for the parser runner: a parser that prints several MB (as a library warning in a loop might) and waits
// until its output has been taken, then replies. A worker's output is taken only as fast as the runner reads it, so a
// runner that never reads it leaves this parser waiting until the time limit.
import { parentPort } from 'node:worker_threads';

const NOISE = 'parser-flood-noise '.repeat(220_000); // about 4 MB, far more than any stream buffer holds
const flushed = (stream: NodeJS.WriteStream): Promise<void> =>
  new Promise((resolve, reject) => stream.write(NOISE, (e) => (e ? reject(e) : resolve())));
await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
parentPort?.postMessage({ ok: true, result: { text: 'replied after flushing', pageCount: null } });
