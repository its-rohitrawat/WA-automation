import { Worker, isMarkedAsUntransferable } from 'node:worker_threads';
import { ParseError, type ParseJob, type ParseReply, type ParseResult } from './types.ts';

const WORKER = new URL('./worker.ts', import.meta.url);
/** A hostile file can exhaust only its own worker. */
const LIMITS = { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 64, stackSizeMb: 4 };

/**
 * The file bytes as a view that owns its whole ArrayBuffer, so the worker can take that memory without a copy (files
 * are up to 50 MB). A Buffer from Node's shared pool, or a view into a larger buffer, shares its memory with other
 * data and cannot be moved, so it is copied once and the copy is moved.
 */
function movable(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const buf = bytes.buffer;
  const owned = buf instanceof ArrayBuffer && !isMarkedAsUntransferable(buf) && bytes.byteOffset === 0 && bytes.byteLength === buf.byteLength;
  return owned ? (bytes as Uint8Array<ArrayBuffer>) : new Uint8Array(bytes);
}

/**
 * Parses one file in a fresh worker thread and kills it after timeoutMs. terminate() stops even a busy loop.
 * The worker's console output is discarded so parser warnings never reach the service log.
 *
 * The bytes are moved to the worker, not copied: when job.bytes owns its whole memory, the caller's view is empty
 * (length 0) once this is called. A caller that still needs the bytes afterwards must pass a copy.
 */
export function parseFile(job: ParseJob, o: { timeoutMs: number; workerUrl?: URL }): Promise<ParseResult> {
  return new Promise<ParseResult>((resolve, reject) => {
    const bytes = movable(job.bytes);
    const worker = new Worker(o.workerUrl ?? WORKER, {
      workerData: { ...job, bytes },
      transferList: [bytes.buffer],
      resourceLimits: LIMITS,
      stdout: true,
      stderr: true,
    });
    worker.stdout.resume();
    worker.stderr.resume();
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      void worker.terminate();
    };
    const timer = setTimeout(() => finish(() => reject(new ParseError('parse_timeout'))), o.timeoutMs);
    worker.once('message', (m: unknown) => {
      const reply = m as ParseReply;
      finish(() => (reply.ok ? resolve(reply.result) : reject(new ParseError(reply.code))));
    });
    worker.once('error', (e: Error & { code?: string }) => finish(() => reject(new ParseError(e.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'parse_memory' : 'parse_failed'))));
    worker.once('exit', () => finish(() => reject(new ParseError('parse_failed'))));
  });
}
