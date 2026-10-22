import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Ffmpeg, findFfmpeg } from '../src/stt/audio.ts';
import { refusals } from '../src/stt/bakeoff/checks.ts';
import { KEY_NAMES, loadBakeoffEnv } from '../src/stt/bakeoff/env.ts';
import { Ledger } from '../src/stt/bakeoff/ledger.ts';
import { buildPlan, formatPlan } from '../src/stt/bakeoff/plan.ts';
import { buildReport, buildScoreSheet, localTime } from '../src/stt/bakeoff/report.ts';
import { runPlan } from '../src/stt/bakeoff/runner.ts';
import { findSamples, insideGitRepo, type Sample } from '../src/stt/bakeoff/samples.ts';
import { ElevenLabsProvider } from '../src/stt/providers/elevenlabs.ts';
import { OpenAiProvider } from '../src/stt/providers/openai.ts';
import { SarvamProvider } from '../src/stt/providers/sarvam.ts';
import { segmentsToText } from '../src/stt/segments.ts';
import { PROVIDER_IDS, type AudioPart, type ProviderId, type SttProvider } from '../src/stt/types.ts';

// The error's type and code only: messages can carry paths, keys or transcript text.
function fatal(err: unknown): void {
  const code = (err as { code?: unknown } | null)?.code;
  process.stderr.write(`Stopped: ${err instanceof Error ? err.name : 'error'}${typeof code === 'string' || typeof code === 'number' ? ` (${code})` : ''}\n`);
  process.exit(1);
}
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);

const USAGE = `STT bake-off (docs/STT-BAKEOFF.md). Without --yes this is a dry run: nothing is converted or sent.

  node scripts/stt-bakeoff.ts [options]

  --samples <dir>       folder with voice-notes\\ and meetings\\ (default STT_SAMPLES_DIR or C:\\stt-samples)
  --out <dir>           output folder (default <samples>\\bakeoff-out)
  --providers <list>    comma list of ${PROVIDER_IDS.join(', ')} (default all)
  --only <sample-id>    only this sample; repeat for more
  --yes                 really convert and send
  --confirm-privacy     you completed the privacy checklist (required with --yes)
  --max-usd <n>         spending cap for this run in dollars (default 8)
  --retry-failed        send slots that failed before again
  --retry-unknown       retry slots that got no answer (Sarvam waits on the saved job; others send again)
  --report-only         rebuild report.md and the transcripts from saved results
`;

const { values } = parseArgs({
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
    'report-only': { type: 'boolean', default: false },
  },
});

function stop(message: string): never {
  console.log(message);
  process.exit(1);
}

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const env = loadBakeoffEnv();
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

const only = values.only ?? [];
const samples: Sample[] = findSamples(samplesDir).filter((s) => only.length === 0 || only.includes(s.id));
if (samples.length === 0) {
  stop(`No audio files found in ${join(samplesDir, 'voice-notes')} or ${join(samplesDir, 'meetings')}${only.length > 0 ? ' matching --only' : ''}.`);
}

const ledger = new Ledger(outDir);
const measured: { sample: Sample; seconds: number }[] = [];
for (const sample of samples) measured.push({ sample, seconds: await ffmpeg.seconds(sample.path) });

function writeReport(): string {
  const ids = new Set(samples.map((s) => s.id));
  const outcomes = ledger.outcomes().filter((o) => ids.has(o.sampleId));
  mkdirSync(join(outDir, 'transcripts'), { recursive: true });
  for (const o of outcomes) {
    if (o.status === 'done') writeFileSync(join(outDir, 'transcripts', `${o.sampleId}.${o.provider}.txt`), segmentsToText(o.segments));
  }
  const unknown = samples.flatMap((s) => PROVIDER_IDS.filter((p) => ledger.state(s.id, p) === 'unknown').map((p) => ({ sampleId: s.id, provider: p })));
  // Written once and never overwritten: it holds the owner's own scores.
  try {
    writeFileSync(join(outDir, 'scores.md'), buildScoreSheet(), { flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  const path = join(outDir, 'report.md');
  writeFileSync(path, buildReport({
    generatedAt: localTime(new Date()),
    inrPerUsd: env.INR_PER_USD,
    samples: measured.map((m) => ({ id: m.sample.id, kind: m.sample.kind, seconds: m.seconds })),
    outcomes,
    unknown,
  }));
  return path;
}

if (values['report-only']) {
  console.log(`Report: ${writeReport()}`);
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

// Local and free: one mono 16 kHz MP3 per sample that has something to send.
const prepared = new Map<string, AudioPart>();
mkdirSync(join(outDir, 'prepared'), { recursive: true });
for (const { sample } of measured) {
  if (!items.some((i) => i.sample.id === sample.id && i.action !== 'skip')) continue;
  const path = join(outDir, 'prepared', `${sample.id}.mp3`);
  console.log(`prepare  ${sample.id}`);
  await ffmpeg.toMp3(sample.path, path);
  prepared.set(sample.id, { path, seconds: await ffmpeg.seconds(path), offset: 0 });
}

const summary = await runPlan(items, {
  providers,
  ledger,
  inrPerUsd: env.INR_PER_USD,
  maxUsd,
  forgetRemote: true,
  log: (line) => console.log(line),
  partsFor: async (item, maxSeconds) => {
    const audio = prepared.get(item.sample.id);
    if (!audio) throw new Error(`No prepared audio for ${item.sample.id}`);
    return await ffmpeg.split(audio, join(outDir, 'prepared', `${item.sample.id}-parts-${maxSeconds}`), maxSeconds);
  },
});
const reportPath = writeReport();
console.log(
  `\nAbout $${summary.spentUsd.toFixed(2)} at list prices: ${summary.done} done, ${summary.failed} failed, ` +
    `${summary.unknown} without an answer, ${summary.skipped} skipped${summary.stoppedAtCap ? ', stopped at the spending cap' : ''}.`,
);
console.log(`Report: ${reportPath}`);
