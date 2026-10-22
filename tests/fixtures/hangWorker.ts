// Test fixture for the parser runner: a parser that never finishes, so the runner's timeout has to stop it.
// When the job carries `beats` (an Int32Array on a SharedArrayBuffer), every loop adds 1 to it, so a test can see
// whether the thread really stopped.
import { workerData } from 'node:worker_threads';

const beats = (workerData as { beats?: Int32Array }).beats;
for (;;) {
  if (beats) Atomics.add(beats, 0, 1);
}
