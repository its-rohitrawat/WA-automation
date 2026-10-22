// Test fixture for the parser runner: replies with whether this worker thread can see the parent's environment
// variables (the probe variable a test sets, and how many variables it has in all). Never their values.
import { parentPort } from 'node:worker_threads';

const seen = { probe: process.env.PARSER_ENV_PROBE !== undefined, count: Object.keys(process.env).length };
parentPort?.postMessage({ ok: true, result: { text: JSON.stringify(seen), pageCount: null } });
