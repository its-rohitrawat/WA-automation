import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AudioError, Ffmpeg, findFfmpeg } from '../src/stt/audio.ts';
import { refusals } from '../src/stt/bakeoff/checks.ts';
import { KEY_NAMES, loadBakeoffEnv, type BakeoffEnv } from '../src/stt/bakeoff/env.ts';
import { checkRecordings, releaseRunLock, saveSourcePrint, sourcePrint, takeRunLock, type RunLock } from '../src/stt/bakeoff/guards.ts';
import { Ledger, LedgerError } from '../src/stt/bakeoff/ledger.ts';
import { buildPlan, formatPlan } from '../src/stt/bakeoff/plan.ts';
import { buildReport, buildScoreSheet, localTime } from '../src/stt/bakeoff/report.ts';
import { runPlan } from '../src/stt/bakeoff/runner.ts';
import { findSamples, insideGitRepo, type Sample } from '../src/stt/bakeoff/samples.ts';
import { ElevenLabsProvider } from '../src/stt/providers/elevenlabs.ts';
import { OpenAiProvider } from '../src/stt/providers/openai.ts';
import { SarvamProvider } from '../src/stt/providers/sarvam.ts';
import { segmentsToText } from '../src/stt/segments.ts';
import { PROVIDER_IDS, type AudioPart, type ProviderId, type SttProvider } from '../src/stt/types.ts';

const AFTER_STOP = 'Finished results are kept. Run the same command again to continue, or add --report-only to rebuild report.md.';

/** This run's own lock, once taken. It is removed only while the file still holds this run's token. */
let runLock: RunLock | null = null;
process.on('exit', () => {
  if (runLock === null) return;
  try {
    releaseRunLock(runLock);
  } catch {
    // Left behind: the next run says where it is and that it may be deleted.
  }
});

// A LedgerError names a local file only, so it is shown in full. Anything else shows its type and code only: messages
// can carry paths, keys or transcript text.
function fatal(err: unknown): void {
  if (err instanceof LedgerError) {
    process.stderr.write(`Stopped: ${err.message} (${err.code})\n${AFTER_STOP}\n`);
  } else {
    const code = (err as { code?: unknown } | null)?.code;
    process.stderr.write(`Stopped: ${err instanceof Error ? err.name : 'error'}${typeof code === 'string' || typeof code === 'number' ? ` (${code})` : ''}\n${AFTER_STOP}\n`);
  }
  process.exit(1);
}
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);
// Ctrl+C, Ctrl+Break or closing the window: leave through process.exit, so the lock file is removed.
for (const signal of ['SIGINT', 'SIGBREAK', 'SIGHUP'] as const) {
  process.on(signal, () => {
    process.stderr.write(`\nStopped${signal === 'SIGINT' ? ' (Ctrl+C)' : ''}. ${AFTER_STOP}\n`);
    process.exit(130);
  });
}

const USAGE = `STT bake-off (docs/STT-BAKEOFF.md). Without --yes this is a dry run: nothing is converted or sent.

  node scripts/stt-bakeoff.ts [options]

  --samples <dir>       folder with voice-notes\\ and meetings\\ (default STT_SAMPLES_DIR or C:\\stt-samples)
  --out <dir>           output folder (default <samples>\\bakeoff-out); always the same one: a new folder sends and pays for everything again
  --providers <list>    comma list of ${PROVIDER_IDS.join(', ')} (default all)
  --only <sample-id>    only this recording, by its id from the dry-run list; repeat for more
  --yes                 really convert and send
  --confirm-privacy     you completed the privacy checklist (required with --yes)
  --max-usd <n>         spending cap for this run in dollars (default 8)
  --retry-failed        send slots that failed before again
  --retry-unknown       retry slots that got no answer; free only where the dry run says "no new charge", otherwise sent and paid again
  --keep-remote         keep ElevenLabs' stored copy of each transcript (by default it is deleted once saved here)
  --report-only         rebuild report.md and the transcripts from saved results
`;

function stop(message: string): never {
  console.log(message);
  process.exit(1);
}

/** The options. A mistake prints the usage, never the argument itself: it could be a pasted key. */
function readOptions() {
  try {
    return parseArgs({
      options: {
        help: { type: 'boolean', short: 'h', default: false },
        samples: { type: 'string' },
        out: { type: 'string' },
        providers: { type: 'string', default: PROVIDER_IDS.join(',') },
        only: { type: 'string', multiple: true },
        yes: { type: 'boolean', default: false },
        'confirm-privacy': { type: 'boolean', default: false },
        'max-usd': { type: 'string', default: '8' },
        'retry-failed': { type: 'boolean', default: false },
        'retry-unknown': { type: 'boolean', default: false },
        'keep-remote': { type: 'boolean', default: false },
        'report-only': { type: 'boolean', default: false },
      },
    }).values;
  } catch {
    return stop(`Unknown or misspelt option (options start with two dashes, for example --yes).\n\n${USAGE}`);
  }
}
const values = readOptions();

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

/** The worktree's own .env, wherever the command is started from. Errors name settings, never their values. */
const ENV_FILE = fileURLToPath(new URL('../.env', import.meta.url));
function readSettings(): BakeoffEnv {
  try {
    return loadBakeoffEnv(ENV_FILE);
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    const why =
      typeof code === 'string' ? `could not be read (${code})`
      : e instanceof Error && e.message.startsWith('Invalid configuration in: ') ? e.message
      : 'has a setting the tool cannot use';
    return stop(`.env: ${why} (see docs/STT-BAKEOFF.md)`);
  }
}
const env = readSettings();

const samplesDir = resolve(values.samples ?? env.STT_SAMPLES_DIR ?? 'C:\\stt-samples');
const outDir = resolve(values.out ?? join(samplesDir, 'bakeoff-out'));
for (const [label, dir] of [['Samples folder', samplesDir], ['Output folder', outDir]] as const) {
  if (insideGitRepo(dir)) stop(`${label} ${dir} is inside a git repository. Recordings and transcripts must stay outside it.`);
}

const requested = values.providers.split(',').map((s) => s.trim()).filter((s) => s !== '');
const isProviderId = (s: string): s is ProviderId => (PROVIDER_IDS as readonly string[]).includes(s);
const providerIds: ProviderId[] = requested.filter(isProviderId);
if (providerIds.length === 0 || providerIds.length !== requested.length) stop(`--providers takes a comma list of: ${PROVIDER_IDS.join(', ')}`);
const maxUsd = Number(values['max-usd']);
if (!(maxUsd > 0)) stop('--max-usd must be a positive number of dollars.');

const exe = await findFfmpeg(env.FFMPEG_PATH);
if (!exe) stop('ffmpeg was not found. Set FFMPEG_PATH in .env (see docs/STT-BAKEOFF.md).');
const ffmpeg = new Ffmpeg(exe);

function listSamples(): Sample[] {
  try {
    return findSamples(samplesDir);
  } catch (e) {
    // Its message names the shared id only.
    if (e instanceof Error && (e as { code?: unknown }).code === 'duplicate_sample_id') return stop(e.message);
    throw e;
  }
}
/** Every recording in the folder: the report covers them all, whatever --only picks. */
const found = listSamples();
if (found.length === 0) stop(`No audio files found in ${join(samplesDir, 'voice-notes')} or ${join(samplesDir, 'meetings')}.`);

const only = values.only ?? [];
const foundIds = new Set(found.map((s) => s.id));
const strangers = only.filter((id) => !foundIds.has(id));
if (strangers.length > 0) {
  // An id-shaped value is shown so a typo can be spotted; anything else is not repeated.
  const lines = strangers.map((id) =>
    /^(voice|meeting)-[a-z0-9-]{1,60}$/.test(id) ? `No recording has the id ${id} (given to --only).` : 'A value given to --only is not a recording id.',
  );
  stop(`${[...new Set(lines)].join('\n')}\nUse an id from the dry-run list (run without --only to see it). Nothing was sent.`);
}
const samples: Sample[] = found.filter((s) => only.length === 0 || only.includes(s.id));

const ledger = new Ledger(outDir);
// Every unreadable recording is named at once, before anything is converted or sent.
const measured: { sample: Sample; seconds: number; preparedSeconds?: number }[] = [];
const unreadable: string[] = [];
for (const sample of samples) {
  try {
    measured.push({ sample, seconds: await ffmpeg.seconds(sample.path) });
  } catch {
    unreadable.push(sample.path);
  }
}
if (unreadable.length > 0) {
  stop(
    `These recordings could not be read: damaged, still downloading, or not audio. Move them out of the folder or replace them, then run again. Nothing was sent.\n` +
      unreadable.map((p) => `  ${p}`).join('\n'),
  );
}

// Every recording found is checked, in every mode, before any report or plan: a recording replaced under the same name
// must not get the old one's results, in report.md or in a send, nor a mix of both.
const preparedDir = join(outDir, 'prepared');
const { changed, prints } = checkRecordings(found, preparedDir);
if (changed.length > 0) {
  stop(
    changed
      .map((s) => `The recording ${s.path} changed after it was prepared or sent. Rename the new file (it then gets a new id), or move ${preparedDir} and ${join(outDir, 'results', s.id)} aside.`)
      .join('\n') + '\nNothing was sent.',
  );
}

/** Rebuilds report.md and the transcripts from saved results; writes scores.md only the first time. */
function writeReport(): { report: string; scores: string } {
  const outcomes = ledger.outcomes().filter((o) => foundIds.has(o.sampleId));
  mkdirSync(join(outDir, 'transcripts'), { recursive: true });
  for (const o of outcomes) {
    if (o.status === 'done') writeFileSync(join(outDir, 'transcripts', `${o.sampleId}.${o.provider}.txt`), segmentsToText(o.segments));
  }
  const unknown = found.flatMap((s) => PROVIDER_IDS.filter((p) => ledger.state(s.id, p) === 'unknown').map((p) => ({ sampleId: s.id, provider: p })));
  // Written once and never overwritten: it holds the owner's own scores.
  const scores = join(outDir, 'scores.md');
  try {
    writeFileSync(scores, buildScoreSheet(), { flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  // Lengths from this run's measurement, or else from a saved outcome, so --only never shrinks the report.
  const seconds = new Map(measured.map((m) => [m.sample.id, m.seconds] as const));
  const report = join(outDir, 'report.md');
  writeFileSync(report, buildReport({
    generatedAt: localTime(new Date()),
    inrPerUsd: env.INR_PER_USD,
    samples: found.map((s) => ({ id: s.id, kind: s.kind, seconds: seconds.get(s.id) ?? outcomes.find((o) => o.sampleId === s.id)?.audioSeconds ?? null })),
    outcomes,
    unknown,
  }));
  return { report, scores };
}

function printReportPaths(paths: { report: string; scores: string }): void {
  console.log(`Report: ${paths.report}`);
  console.log(`Scores: ${paths.scores}`);
}

if (values['report-only']) {
  printReportPaths(writeReport());
  process.exit(0);
}

function makeProvider(id: ProviderId): SttProvider {
  // An empty key is only possible in a dry run: refusals() stops a real run first.
  const apiKey = env[KEY_NAMES[id]] ?? '';
  switch (id) {
    case 'sarvam':
      return new SarvamProvider({ apiKey });
    case 'elevenlabs':
      return new ElevenLabsProvider({ apiKey });
    case 'openai':
      return new OpenAiProvider({ apiKey });
  }
}
const providers = new Map(providerIds.map((id) => [id, makeProvider(id)] as const));

// The runner cuts the prepared MP3, which runs a little longer than the original. Where one exists its length sets the
// part count, so a free resume is judged on the parts that will really be sent. One that cannot be measured leaves the
// original's length; a real run that needs it then stops when preparing it.
for (const m of measured) {
  const mp3 = join(preparedDir, `${m.sample.id}.mp3`);
  if (!existsSync(mp3)) continue;
  try {
    m.preparedSeconds = await ffmpeg.seconds(mp3);
  } catch {
    // See above.
  }
}

const items = buildPlan({
  samples: measured,
  providers: [...providers.values()],
  stateOf: (s, p) => ledger.state(s, p),
  canResume: (s, p, parts) => ledger.canResume(s, p, parts),
  retryFailed: values['retry-failed'],
  retryUnknown: values['retry-unknown'],
  inrPerUsd: env.INR_PER_USD,
});
console.log(`STT bake-off: ${samples.length} file(s), providers ${providerIds.join(', ')}. Output folder: ${outDir}\n`);
console.log(formatPlan(items));

if (!values.yes) {
  console.log('\nDry run: nothing was converted or sent. Add --yes --confirm-privacy to send.');
  process.exit(0);
}
const problems = refusals(items, env, { maxUsd, confirmedPrivacy: values['confirm-privacy'] });
if (problems.length > 0) stop(`\nNot sending:\n${problems.map((p) => `  - ${p}`).join('\n')}`);

// One run at a time per output folder: two runs could both send a slot that neither has finished.
runLock = takeRunLock(outDir, `STT bake-off run started ${localTime(new Date())} (process ${process.pid}).`);
if (runLock === null) stop(`Another run is using ${outDir}. If none is running, delete run.lock there.`);

// Local and free: one mono 16 kHz MP3 per sample that has something to send. Every recording was checked against its
// saved print above; the prints read then are saved beside the MP3s.
const toPrepare = measured.filter(({ sample }) => items.some((i) => i.sample.id === sample.id && i.action !== 'skip'));
const prepared = new Map<string, AudioPart>();
mkdirSync(preparedDir, { recursive: true });
for (const { sample } of toPrepare) {
  const mp3 = join(preparedDir, `${sample.id}.mp3`);
  console.log(`prepare  ${sample.id}`);
  try {
    await ffmpeg.toMp3(sample.path, mp3);
    saveSourcePrint(mp3, prints.get(sample.id) ?? sourcePrint(sample.path));
    prepared.set(sample.id, { path: mp3, seconds: await ffmpeg.seconds(mp3), offset: 0 });
  } catch (e) {
    const errno = (e as { code?: unknown } | null)?.code;
    const code = e instanceof AudioError ? e.code : typeof errno === 'string' ? errno : 'error';
    stop(`Could not convert ${sample.path} (${code}). Nothing was sent.`);
  }
}

const summary = await runPlan(items, {
  providers,
  ledger,
  inrPerUsd: env.INR_PER_USD,
  maxUsd,
  forgetRemote: !values['keep-remote'],
  log: (line) => console.log(line),
  partsFor: async (item, maxSeconds) => {
    const audio = prepared.get(item.sample.id);
    if (!audio) throw new Error(`No prepared audio for ${item.sample.id}`);
    return await ffmpeg.split(audio, join(preparedDir, `${item.sample.id}-parts-${maxSeconds}`), maxSeconds);
  },
});
const paths = writeReport();
const spent = `$${summary.spentUsd.toFixed(summary.spentUsd < 1 ? 3 : 2)}`;
console.log(
  `\nAbout ${spent} at list prices: ${summary.done} done, ${summary.failed} failed, ` +
    `${summary.unknown} without an answer, ${summary.skipped} skipped${summary.unsent > 0 ? `, ${summary.unsent} not sent (cap)` : ''}.`,
);
printReportPaths(paths);
