// Worker-thread entry: parses one untrusted file and posts one reply. The runner kills this thread on timeout.
import { parentPort, workerData } from 'node:worker_threads';
import { ParseError, type ParseJob, type ParseReply } from './types.ts';

async function run(job: ParseJob): Promise<ParseReply> {
  try {
    if (job.kind === 'docx') {
      const { extractDocxText } = await import('./docx.ts');
      return { ok: true, result: await extractDocxText(job.bytes, job) };
    }
    const { extractPdfText } = await import('./pdf.ts');
    // job.bytes is this worker's own copy (moved or cloned here by parseFile), so PDF.js may take it over.
    return { ok: true, result: await extractPdfText(job.bytes, job, { ownsBytes: true }) };
  } catch (e) {
    return { ok: false, code: e instanceof ParseError ? e.code : 'parse_failed' };
  }
}

parentPort?.postMessage(await run(workerData as ParseJob));
