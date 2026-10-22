import { PRICES_CHECKED } from '../prices.ts';
import { formatClock } from '../segments.ts';
import { PROVIDER_IDS, type ProviderId, type SampleKind, type Segment } from '../types.ts';
import type { Outcome } from './ledger.ts';

export interface ReportInput {
  generatedAt: string;
  inrPerUsd: number;
  samples: readonly { id: string; kind: SampleKind; seconds: number }[];
  outcomes: readonly Outcome[];
  /** Slots that were sent without an answer arriving. */
  unknown: readonly { sampleId: string; provider: ProviderId }[];
}

/** Meeting timelines group segments into rows of this many seconds. */
const ROW_SECONDS = 60;

/** One Markdown table cell: a single line, with pipes escaped and HTML neutralised. */
export function cell(text: string): string {
  return text
    .replace(/\s*\r?\n\s*/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|')
    .trim();
}

const money = (usd: number): string => `$${usd.toFixed(usd < 1 ? 3 : 2)}`;
const said = (s: Segment): string => (s.speaker === null ? s.text : `**${s.speaker}:** ${s.text}`);

/** The owner's report: summary, blank score sheet, voice notes side by side, meeting timelines. */
export function buildReport(input: ReportInput): string {
  const providers = PROVIDER_IDS.filter((p) => input.outcomes.some((o) => o.provider === p) || input.unknown.some((u) => u.provider === p));
  const find = (sampleId: string, p: ProviderId): Outcome | undefined => input.outcomes.find((o) => o.sampleId === sampleId && o.provider === p);
  const kindOf = (sampleId: string): SampleKind | undefined => input.samples.find((s) => s.id === sampleId)?.kind;
  /** null when the slot is done; otherwise what to show instead of a result. */
  const status = (sampleId: string, p: ProviderId): string | null => {
    const o = find(sampleId, p);
    if (o?.status === 'done') return null;
    if (o?.status === 'failed') return `failed (${cell(o.error ?? 'error')})`;
    return input.unknown.some((u) => u.sampleId === sampleId && u.provider === p) ? "no answer: check the provider's dashboard" : 'not run';
  };

  const out: string[] = [
    '# STT bake-off report',
    '',
    `Generated ${input.generatedAt}. List prices checked ${PRICES_CHECKED}; Sarvam's rupee prices are converted at ₹${input.inrPerUsd} to $1.`,
    "Costs are list price × audio length. Compare them with each provider's dashboard after the run.",
    '',
    '> Private: this file contains client conversations. Keep it outside the repository and do not share it.',
    '',
    '## Summary',
    '',
    '| Provider | Files | Model | Done | Failed | No answer | Audio done | Cost | Cost per audio hour | Processing per audio minute |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const p of providers) {
    for (const kind of ['voice', 'meeting'] as const) {
      const mine = input.outcomes.filter((o) => o.provider === p && o.kind === kind);
      const done = mine.filter((o) => o.status === 'done');
      const noAnswer = input.unknown.filter((u) => u.provider === p && kindOf(u.sampleId) === kind).length;
      if (mine.length === 0 && noAnswer === 0) continue;
      const audio = done.reduce((t, o) => t + o.audioSeconds, 0);
      const cost = done.reduce((t, o) => t + o.costUsd, 0);
      const processing = done.reduce((t, o) => t + o.processingSeconds, 0);
      const models = [...new Set(mine.map((o) => o.model))].join(', ') || '–';
      const perHour = audio > 0 ? money((cost * 3600) / audio) : '–';
      const perMinute = audio > 0 ? `${((processing * 60) / audio).toFixed(1)} s` : '–';
      out.push(
        `| ${p} | ${kind === 'voice' ? 'voice notes' : 'meetings'} | ${models} | ${done.length} | ${mine.length - done.length} | ${noAnswer} | ${formatClock(audio)} | ${money(cost)} | ${perHour} | ${perMinute} |`,
      );
    }
  }

  out.push(
    '',
    '## Score sheet',
    '',
    'Fill this in by hand after reading the transcripts. 5 = names, numbers, dates, amounts and task words all right; 3 = the meaning is clear but there are several mistakes; 1 = unusable.',
    '',
    '| Provider | Hinglish accuracy, voice notes (1–5) | Hinglish accuracy, meetings (1–5) | Speaker separation, meetings (1–5) | Cost per audio hour | Notes |',
    '|---|---|---|---|---|---|',
    ...providers.map((p) => `| ${p} |  |  |  |  |  |`),
  );

  const voice = input.samples.filter((s) => s.kind === 'voice');
  if (voice.length > 0) out.push('', '## Voice notes');
  for (const s of voice) {
    out.push('', `### ${s.id} (${formatClock(s.seconds)})`, '', '| Provider | Processing | Cost | Transcript |', '|---|---|---|---|');
    for (const p of providers) {
      const o = find(s.id, p);
      const st = status(s.id, p);
      out.push(o && st === null ? `| ${p} | ${o.processingSeconds.toFixed(1)} s | ${money(o.costUsd)} | ${cell(o.segments.map(said).join(' '))} |` : `| ${p} | – | – | ${st} |`);
    }
  }

  const meetings = input.samples.filter((s) => s.kind === 'meeting');
  if (meetings.length > 0) out.push('', '## Meetings');
  for (const s of meetings) {
    out.push('', `### ${s.id} (${formatClock(s.seconds)})`, '', '| Provider | Speakers found | Segments | Processing | Cost |', '|---|---|---|---|---|');
    const finished: Outcome[] = [];
    for (const p of providers) {
      const o = find(s.id, p);
      const st = status(s.id, p);
      if (o && st === null) {
        finished.push(o);
        const speakers = new Set(o.segments.flatMap((x) => (x.speaker === null ? [] : [x.speaker]))).size;
        out.push(`| ${p} | ${speakers} | ${o.segments.length} | ${o.processingSeconds.toFixed(1)} s | ${money(o.costUsd)} |`);
      } else {
        out.push(`| ${p} | – | – | – | ${st} |`);
      }
    }
    if (finished.length === 0) continue;
    const last = Math.max(s.seconds, ...finished.flatMap((o) => o.segments.map((x) => x.start + 1)));
    out.push(
      '',
      `Timeline, one row per minute. Speaker labels are each provider's own; "p2:A" is speaker A in part 2 of a file sent in parts.`,
      '',
      `| Time | ${finished.map((o) => o.provider).join(' | ')} |`,
      `|---|${finished.map(() => '---|').join('')}`,
    );
    for (let t = 0; t < last; t += ROW_SECONDS) {
      const texts = finished.map((o) => cell(o.segments.filter((x) => x.start >= t && x.start < t + ROW_SECONDS).map(said).join(' ')));
      out.push(`| ${formatClock(t)} | ${texts.join(' | ')} |`);
    }
  }

  out.push('', 'Full transcripts, one line per segment: transcripts/<file>.<provider>.txt in this folder.', '');
  return out.join('\n');
}
