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
    return { ok: true, result: await extractPdfText(job.bytes, job) };
  } catch (e) {
    return { ok: false, code: e instanceof ParseError ? e.code : 'parse_failed' };
  }
}

parentPort?.postMessage(await run(workerData as ParseJob));
