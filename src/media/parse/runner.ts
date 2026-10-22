import { Worker, isMarkedAsUntransferable } from 'node:worker_threads';
import { MEDIA_LIMITS } from '../types.ts';
import { ParseError, type ParseJob, type ParseReply, type ParseResult } from './types.ts';

const WORKER = new URL('./worker.ts', import.meta.url);
/**
 * A hostile file can exhaust only its own worker. These limits cover the worker's V8 heap only; memory outside it
 * (ArrayBuffers) is watched by parseFile instead.
 */
const LIMITS = { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 64, stackSizeMb: 4 };
/** How often parseFile checks the worker's memory outside the V8 heap. */
const MEMORY_CHECK_MS = 50;

/**
 * The file bytes in memory the worker can take over, so they are never cloned (files are up to 50 MB).
 *
 * By default this is one private copy, and the caller's bytes stay intact. With transfer, a view that owns its whole
 * ArrayBuffer is handed over as it is, with no copy at all. A Buffer from Node's shared pool, or a view into a larger
 * buffer, shares its memory with other data and cannot be moved, so it is copied even then.
 */
function sendable(bytes: Uint8Array, transfer: boolean): Uint8Array<ArrayBuffer> {
  const buf = bytes.buffer;
  const owned = buf instanceof ArrayBuffer && !isMarkedAsUntransferable(buf) && bytes.byteOffset === 0 && bytes.byteLength === buf.byteLength;
  return transfer && owned ? (bytes as Uint8Array<ArrayBuffer>) : new Uint8Array(bytes);
}

/**
 * Parses one file in a fresh worker thread and kills it after timeoutMs, or as soon as its memory outside the V8 heap
 * passes MEDIA_LIMITS.maxParserExternalBytes ('parse_memory'). terminate() stops even a busy loop.
 * The worker's console output is discarded so parser warnings never reach the service log.
 *
 * The caller's bytes stay intact unless `transfer` is true. Then bytes that own their whole memory are moved to the
 * worker instead of copied, and the caller's view is empty (length 0) once this is called. Only a caller that never
 * reads the bytes again may pass `transfer`. Buffers from fs.promises.readFile, and large results of Buffer.concat,
 * own their memory.
 */
export function parseFile(job: ParseJob, o: { timeoutMs: number; workerUrl?: URL; transfer?: boolean }): Promise<ParseResult> {
  return new Promise<ParseResult>((resolve, reject) => {
    let worker: Worker;
    try {
      const bytes = sendable(job.bytes, o.transfer === true);
      worker = new Worker(o.workerUrl ?? WORKER, {
        workerData: { ...job, bytes },
        transferList: [bytes.buffer],
        resourceLimits: LIMITS,
        stdout: true,
        stderr: true,
      });
    } catch {
      // The bytes could not be handed to a worker, for example because they were already moved away (a detached
      // buffer). Still a ParseError, so the file is not retried.
      reject(new ParseError('parse_failed'));
      return;
    }
    worker.stdout.resume();
    worker.stderr.resume();
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(memoryCheck);
      fn();
      void worker.terminate();
    };
    const timer = setTimeout(() => finish(() => reject(new ParseError('parse_timeout'))), o.timeoutMs);
    // A parser also decodes into buffers outside the V8 heap, which resourceLimits do not cover: PDF.js inflates
    // compressed streams into growing Uint8Arrays, with no size cap. Deflate packs about 1,000:1, so a 200 KB PDF can
    // inflate to 200 MB and a 50 MB one to tens of gigabytes. The worker's external memory is checked here and the
    // worker is stopped over the cap. getHeapStatistics answers even while the worker is busy in a long synchronous loop.
    let checking = false;
    const memoryCheck = setInterval(() => {
      if (checking) return;
      checking = true;
      worker
        .getHeapStatistics()
        .then(
          (s) => {
            if (s.external_memory > MEDIA_LIMITS.maxParserExternalBytes) finish(() => reject(new ParseError('parse_memory')));
          },
          () => {}, // The worker is no longer running; its exit is handled below.
        )
        .finally(() => {
          checking = false;
        });
    }, MEMORY_CHECK_MS);
    worker.once('message', (m: unknown) => {
      const reply = m as ParseReply;
      finish(() => (reply.ok ? resolve(reply.result) : reject(new ParseError(reply.code))));
    });
    worker.once('error', (e: Error & { code?: string }) => finish(() => reject(new ParseError(e.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'parse_memory' : 'parse_failed'))));
    worker.once('exit', () => finish(() => reject(new ParseError('parse_failed'))));
  });
}
