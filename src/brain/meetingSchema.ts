import { z } from 'zod';
import { isIsoDate } from '../util/time.ts';

/**
 * Longest texts (in characters) and longest lists in a summary. Structured output does not accept string lengths or item
 * counts, so the system prompt states them and validateSummary enforces them.
 */
export const MEETING_LIMITS = {
  whatHappened: 1_500,
  conclusion: 1_500,
  /** A discussion summary, a decision, an action item's task, an open question. */
  text: 600,
  topic: 200,
  owner: 100,
  discussion: 20,
  decisions: 30,
  actionItems: 40,
  openQuestions: 15,
} as const;

const SIDE = ['us', 'client'] as const;

export const MeetingDiscussionWireSchema = z.object({ topic: z.string(), summary: z.string() });
export const MeetingDecisionWireSchema = z.object({ text: z.string(), segmentIds: z.array(z.string()).min(1) });
export const MeetingActionWireSchema = z.object({
  side: z.enum(SIDE),
  task: z.string(),
  owner: z.string(),
  deadline: z.string(),
  segmentIds: z.array(z.string()).min(1),
});
export const MeetingSpeakerWireSchema = z.object({ label: z.string(), name: z.string() });

/** What Claude returns for a meeting. Flat, no unions: "" means "not set". */
export const MeetingWireSchema = z.object({
  whatHappened: z.string(),
  discussion: z.array(MeetingDiscussionWireSchema),
  decisions: z.array(MeetingDecisionWireSchema),
  actionItems: z.array(MeetingActionWireSchema),
  openQuestions: z.array(z.string()),
  conclusion: z.string(),
  speakers: z.array(MeetingSpeakerWireSchema),
});

/** JSON schema sent as output_config.format.schema. Built by zod so `enum` is kept. */
export const MEETING_SUMMARY_JSON_SCHEMA: Record<string, unknown> = (() => {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(MeetingWireSchema) as Record<string, unknown>;
  return schema;
})();

/** A validated summary: texts trimmed and capped, segment ids that exist, names only from the allowed list. */
export interface MeetingSummary {
  whatHappened: string;
  discussion: { topic: string; summary: string }[];
  decisions: { text: string; segmentIds: string[] }[];
  actionItems: {
    side: (typeof SIDE)[number];
    task: string;
    owner: string | null;
    /** YYYY-MM-DD. */
    deadline: string | null;
    segmentIds: string[];
  }[];
  openQuestions: string[];
  conclusion: string;
  /** Labels as the transcript shows them (speakerLabel); name null when the label stays unnamed. */
  speakers: { label: string; name: string | null }[];
}

/** Trimmed and cut to at most `max` code points, so an emoji is never split in half. */
const clip = (s: string, max: number): string => [...s.trim()].slice(0, max).join('').trimEnd();
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Checks a model's summary against the prompt it was given. Invalid items are dropped one by one and counted, never fatal:
 * - decisions and action items keep only segment ids in `segmentIds` ("S12" and "12" read as "s12") and are dropped
 *   when none is left;
 * - a deadline is kept only as a real YYYY-MM-DD date;
 * - texts are trimmed and capped, and lists cut at MEETING_LIMITS; an item with no text is dropped;
 * - a speaker's label must be one of `labels`, once; a name not in `allowedNames` (trimmed, without case) becomes null,
 *   and an allowed name is written as listed.
 * A part of the wrong type counts as one dropped item and is left empty.
 */
export function validateSummary(
  raw: unknown,
  segmentIds: readonly string[],
  allowedNames: readonly string[],
  labels: readonly string[],
): { summary: MeetingSummary; dropped: number } {
  const o = isRecord(raw) ? raw : {};
  const known = new Set(segmentIds);
  const shownLabels = new Set(labels);
  const names = new Map<string, string>();
  for (const n of allowedNames) {
    const key = n.trim().toLowerCase();
    if (key && !names.has(key)) names.set(key, n.trim());
  }
  let dropped = 0;

  const text = (v: unknown, max: number): string => {
    if (typeof v === 'string') return clip(v, max);
    dropped++;
    return '';
  };
  function list<T>(v: unknown, max: number, item: (x: unknown) => T | null): T[] {
    if (!Array.isArray(v)) {
      dropped++;
      return [];
    }
    const out: T[] = [];
    for (const x of v) {
      const t = item(x);
      if (t === null || out.length >= max) dropped++;
      else out.push(t);
    }
    return out;
  }
  // "s12", "S12" and "12" all mean segment s12.
  const normalId = (id: string): string => {
    const m = /^[sS]?(\d{1,7})$/.exec(id.trim());
    return m ? `s${Number(m[1])}` : id.trim();
  };
  const cited = (ids: string[]): string[] => [...new Set(ids.map(normalId).filter((id) => known.has(id)))];

  const seenLabels = new Set<string>();
  const summary: MeetingSummary = {
    whatHappened: text(o.whatHappened, MEETING_LIMITS.whatHappened),
    discussion: list(o.discussion, MEETING_LIMITS.discussion, (x) => {
      const r = MeetingDiscussionWireSchema.safeParse(x);
      if (!r.success) return null;
      const d = { topic: clip(r.data.topic, MEETING_LIMITS.topic), summary: clip(r.data.summary, MEETING_LIMITS.text) };
      return d.topic || d.summary ? d : null;
    }),
    decisions: list(o.decisions, MEETING_LIMITS.decisions, (x) => {
      const r = MeetingDecisionWireSchema.safeParse(x);
      if (!r.success) return null;
      const d = { text: clip(r.data.text, MEETING_LIMITS.text), segmentIds: cited(r.data.segmentIds) };
      return d.text && d.segmentIds.length ? d : null;
    }),
    actionItems: list(o.actionItems, MEETING_LIMITS.actionItems, (x) => {
      const r = MeetingActionWireSchema.safeParse(x);
      if (!r.success) return null;
      const deadline = r.data.deadline.trim();
      const a = {
        side: r.data.side,
        task: clip(r.data.task, MEETING_LIMITS.text),
        owner: clip(r.data.owner, MEETING_LIMITS.owner) || null,
        deadline: isIsoDate(deadline) ? deadline : null,
        segmentIds: cited(r.data.segmentIds),
      };
      return a.task && a.segmentIds.length ? a : null;
    }),
    openQuestions: list(o.openQuestions, MEETING_LIMITS.openQuestions, (x) => {
      const q = typeof x === 'string' ? clip(x, MEETING_LIMITS.text) : '';
      return q || null;
    }),
    conclusion: text(o.conclusion, MEETING_LIMITS.conclusion),
    speakers: list(o.speakers, labels.length, (x) => {
      const r = MeetingSpeakerWireSchema.safeParse(x);
      if (!r.success) return null;
      const label = r.data.label.trim();
      if (!shownLabels.has(label) || seenLabels.has(label)) return null;
      seenLabels.add(label);
      return { label, name: names.get(r.data.name.trim().toLowerCase()) ?? null };
    }),
  };
  return { summary, dropped };
}
