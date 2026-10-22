import { PRICES_CHECKED } from '../prices.ts';
import { formatClock } from '../segments.ts';
import { PROVIDER_IDS, type ProviderId, type SampleKind, type Segment } from '../types.ts';
import type { Outcome } from './ledger.ts';

export interface ReportInput {
  /** When the report was made, already written for the owner (see localTime). */
  generatedAt: string;
  inrPerUsd: number;
  /** seconds is null when the recording was neither measured in this run nor has a saved outcome. */
  samples: readonly { id: string; kind: SampleKind; seconds: number | null }[];
  outcomes: readonly Outcome[];
  /** Slots that were sent without an answer arriving. */
  unknown: readonly { sampleId: string; provider: ProviderId }[];
}

/** Meeting timelines group segments into rows of this many seconds. */
const ROW_SECONDS = 60;
/** Rows a timeline may have beyond the recording's own length, for times a provider puts past the end. */
const EXTRA_ROWS = 5;

/** One Markdown table cell: a single line, with pipes escaped and HTML neutralised. */
export function cell(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|')
    .trim();
}

/** "2026-10-22 15:30 UTC+05:30": the owner's local time. offsetMinutes is east of UTC, as the PC's clock has it by default. */
export function localTime(at: Date, offsetMinutes = -at.getTimezoneOffset()): string {
  const local = new Date(at.getTime() + offsetMinutes * 60_000);
  const two = (n: number): string => String(n).padStart(2, '0');
  const off = Math.abs(offsetMinutes);
  return (
    `${local.getUTCFullYear()}-${two(local.getUTCMonth() + 1)}-${two(local.getUTCDate())} ${two(local.getUTCHours())}:${two(local.getUTCMinutes())} ` +
    `UTC${offsetMinutes < 0 ? '-' : '+'}${two(Math.floor(off / 60))}:${two(off % 60)}`
  );
}

const money = (usd: number): string => `$${usd.toFixed(usd < 1 ? 3 : 2)}`;
const said = (s: Segment): string => (s.speaker === null ? s.text : `**${s.speaker}:** ${s.text}`);

/** The owner's score sheet, written once as scores.md and never overwritten, so scores survive a rebuilt report. */
export function buildScoreSheet(): string {
  return [
    '# STT bake-off score sheet',
    '',
    'Fill this in by hand after reading the transcripts in report.md. 5 = names, numbers, dates, amounts and task words all right; 3 = the meaning is clear but there are several mistakes; 1 = unusable.',
    "Copy the cost per audio hour from the report's Summary.",
    '',
    'This file is never overwritten, so your scores stay when report.md is rebuilt. Keep it private, like the report.',
    '',
    '| Provider | Hinglish accuracy, voice notes (1–5) | Hinglish accuracy, meetings (1–5) | Speaker separation, meetings (1–5) | Cost per audio hour | Notes |',
    '|---|---|---|---|---|---|',
    ...PROVIDER_IDS.map((p) => `| ${p} |  |  |  |  |  |`),
    '',
  ].join('\n');
}

/** The owner's report: summary, voice notes side by side, meeting timelines. Rebuilt from saved results on every run. */
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
  const heading = (s: ReportInput['samples'][number]): string => `### ${s.id}${s.seconds === null ? '' : ` (${formatClock(s.seconds)})`}`;

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
  ];
  if (providers.length === 0) {
    out.push('No results yet.');
  } else {
    out.push(
      '| Provider | Recordings | Model | Done | Failed | No answer | Audio done | Cost | Cost per audio hour | Processing per audio minute |',
      '|---|---|---|---|---|---|---|---|---|---|',
    );
  }
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

  out.push('', 'Score in scores.md in this folder. It is never overwritten; report.md is rebuilt on every run.');
  if (providers.length === 0) {
    out.push('');
    return out.join('\n');
  }

  const voice = input.samples.filter((s) => s.kind === 'voice');
  if (voice.length > 0) out.push('', '## Voice notes');
  for (const s of voice) {
    out.push('', heading(s), '', '| Provider | Processing | Cost | Transcript |', '|---|---|---|---|');
    for (const p of providers) {
      const o = find(s.id, p);
      const st = status(s.id, p);
      out.push(o && st === null ? `| ${p} | ${o.processingSeconds.toFixed(1)} s | ${money(o.costUsd)} | ${cell(o.segments.map(said).join(' '))} |` : `| ${p} | – | – | ${st} |`);
    }
  }

  const meetings = input.samples.filter((s) => s.kind === 'meeting');
  if (meetings.length > 0) out.push('', '## Meetings');
  for (const s of meetings) {
    out.push('', heading(s), '', '| Provider | Speakers found | Segments | Processing | Cost |', '|---|---|---|---|---|');
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
    out.push(
      '',
      `Timeline, one row per minute. Speaker labels are each provider's own; "p2:A" is speaker A in part 2 of a file sent in parts.`,
      ...(finished.some((o) => o.provider === 'openai') ? ['OpenAI meetings are sent in parts of up to 5 minutes; words at a cut can be lost.'] : []),
      '',
      `| Time | ${finished.map((o) => o.provider).join(' | ')} |`,
      `|---|${finished.map(() => '---|').join('')}`,
    );
    for (const [r, texts] of timeline(s.seconds ?? Math.max(0, ...finished.map((o) => o.audioSeconds)), finished).entries()) {
      out.push(`| ${formatClock(r * ROW_SECONDS)} | ${texts.join(' | ')} |`);
    }
  }

  out.push('', 'Full transcripts, one line per segment: transcripts/<file>.<provider>.txt in this folder.', '');
  return out.join('\n');
}

/**
 * One row per minute of the recording, plus room for times a provider puts past the end, and at most EXTRA_ROWS more:
 * a wild time can never make the report huge. Times before the start go in the first row, times after the last row in
 * the last one. Each cell holds that minute's turns, one per line: the <br> is added here, never taken from a transcript.
 */
function timeline(seconds: number, finished: readonly Outcome[]): string[][] {
  const latest = finished.reduce((m, o) => o.segments.reduce((mm, x) => Math.max(mm, x.start + 1), m), seconds);
  const rows = Math.max(1, Math.min(Math.ceil(seconds / ROW_SECONDS) + EXTRA_ROWS, Math.ceil(latest / ROW_SECONDS)));
  const rowOf = (start: number): number => Math.min(rows - 1, Math.max(0, Math.floor(start / ROW_SECONDS) || 0));
  const columns = finished.map((o) => {
    const cells: string[][] = Array.from({ length: rows }, () => []);
    for (const x of o.segments) {
      const text = cell(said(x));
      if (text !== '') cells[rowOf(x.start)]!.push(text);
    }
    return cells.map((turns) => turns.join('<br>'));
  });
  return Array.from({ length: rows }, (_, r) => columns.map((c) => c[r]!));
}
