// Test fixture for the parser runner: replies with the memory limits this worker thread was started with.
import { parentPort, resourceLimits } from 'node:worker_threads';

parentPort?.postMessage({ ok: true, result: { text: JSON.stringify(resourceLimits), pageCount: null } });
