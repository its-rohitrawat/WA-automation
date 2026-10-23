import type { Segment } from './types.ts';

export interface TimedWord {
  text: string;
  start: number;
  end: number;
  speaker: string | null;
}

/**
 * Groups word timings into readable segments. A new segment starts when the speaker changes, after a pause longer than
 * maxGapSeconds, or when the current one would grow past maxSegmentSeconds.
 */
export function wordsToSegments(words: readonly TimedWord[], maxGapSeconds = 1.5, maxSegmentSeconds = 30): Segment[] {
  const out: Segment[] = [];
  let cur: Segment | undefined;
  for (const w of words) {
    if (cur && w.speaker === cur.speaker && w.start - cur.end <= maxGapSeconds && w.end - cur.start <= maxSegmentSeconds) {
      // Providers can list words slightly out of order; the end must never move backwards past the start.
      cur.end = Math.max(cur.end, w.end);
      cur.text += ` ${w.text}`;
    } else {
      cur = { start: w.start, end: w.end, speaker: w.speaker, text: w.text };
      out.push(cur);
    }
  }
  return out;
}

/**
 * Joins the answers for a file sent in parts. Times move by each part's offset. Speaker labels are only valid inside
 * one answer, so with more than one part they get the part number ("p2:A") instead of being guessed across parts.
 */
export function mergeParts(parts: readonly { offset: number; segments: readonly Segment[] }[]): Segment[] {
  const many = parts.length > 1;
  return parts.flatMap((p, i) =>
    p.segments.map((s) => ({
      start: s.start + p.offset,
      end: s.end + p.offset,
      speaker: s.speaker === null ? null : many ? `p${i + 1}:${s.speaker}` : s.speaker,
      text: s.text,
    })),
  );
}

/** 75.4 -> "1:15", 3725 -> "1:02:05". Whole seconds, rounded down. */
export function formatClock(seconds: number): string {
  const t = Math.max(0, Math.floor(seconds));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** One line per segment, "[1:15] A: text", without the speaker part when there is none. */
export function segmentsToText(segments: readonly Segment[]): string {
  return segments.map((s) => `[${formatClock(s.start)}] ${s.speaker === null ? '' : `${s.speaker}: `}${s.text}\n`).join('');
}
