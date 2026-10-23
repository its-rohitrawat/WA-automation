import { listedPeople, meetingLength, shownLabel, speakerLabels } from '../brain/meetingPrompt.ts';
import type { MeetingSummary } from '../brain/meetingSchema.ts';
import { sanitizeFileName } from '../media/paths.ts';
import { formatClock } from '../stt/segments.ts';
import type { Segment } from '../stt/types.ts';
import { fromIstDate, istDate, istTime, istWeekday } from '../util/time.ts';

/** Transcript text kept in the Doc (M6): a Google Doc holds about 1.02 million characters, and the summary needs room. */
export const DOC_TRANSCRIPT_MAX_CHARS = 900_000;
/** The longest Doc name, in characters (code points). */
export const DOC_NAME_MAX_CHARS = 150;
/** After the last transcript line when the transcript was longer than DOC_TRANSCRIPT_MAX_CHARS. */
export const TRANSCRIPT_REST_NOTE = 'The transcript continues on the office PC.';
/** In Meeting info when the summary prompt was cut (MeetingPrompt.cut). */
export const SUMMARY_CUT_NOTE = 'The meeting was too long to summarise in full: the summary covers only its first part. The full transcript is below.';

/** What the Doc is built from. */
export interface MeetingDocInput {
  clientId: number;
  clientName: string;
  /** The meeting's title (the Calendar event's), or "" when it has none. */
  title: string;
  /** ISO time the meeting started. */
  startedAt: string;
  /** Length of the recording. */
  seconds: number;
  /**
   * Calendar attendees and signed-in Meet participants. Only names are shown, cleaned and without any email address in
   * them (listedPeople); `email` is accepted so callers can pass their rows as they are, and is never read. An attendee
   * without a name is left out.
   */
  attendees: readonly { name: string | null; email?: string; team: boolean }[];
  summary: MeetingSummary;
  /**
   * Every segment of the meeting: the same list the summary prompt was built from, so speakerLabels gives the same shown
   * labels the summary's speakers use.
   */
  segments: readonly Segment[];
  /** The summary prompt was cut (MeetingPrompt.cut): the summary covers only the first part of the meeting. */
  transcriptCut: boolean;
}

/** Control and format characters except the joiners U+200C and U+200D, lone surrogates, U+FFFE and U+FFFF (as INVISIBLE in paths.ts). */
const HIDDEN = /(?![‌‍])[\p{Cc}\p{Cf}\p{Cs}￾￿]/gu;
const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * One line of text safe to show: white space (line breaks included) folded to single spaces, then control and format
 * characters (direction overrides, zero-width marks; XML-invalid characters) removed, and trimmed.
 */
export function docText(s: string): string {
  return s.replace(/[\s\u0085]+/gu, ' ').replace(HIDDEN, '').replace(/ {2,}/g, ' ').trim();
}

/** docText with & < > " ' escaped: the only way content enters the HTML. */
const esc = (s: string): string => docText(s).replace(/[&<>"']/g, (c) => ENTITIES[c] ?? '');

const p = (text: string): string => `<p>${esc(text)}</p>`;
const NONE = p('None');
const list = (items: readonly string[]): string => (items.length ? `<ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>` : NONE);

function validDate(iso: string): Date | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * "YYYY-MM-DD – <Client> – <Title>" with en dashes and the India date of the start; each part through sanitizeFileName,
 * "Client <id>" and "Meeting" when nothing is left. At most DOC_NAME_MAX_CHARS characters: the title is cut first (the
 * client part is at most 120, so some title always fits). The date is left out when the start time does not parse.
 */
export function meetingDocName(m: { clientId: number; clientName: string; title: string; startedAt: string }): string {
  const d = validDate(m.startedAt);
  const client = sanitizeFileName(m.clientName) ?? `Client ${m.clientId}`;
  const prefix = `${d ? `${istDate(d)} – ` : ''}${client} – `;
  const room = DOC_NAME_MAX_CHARS - [...prefix].length;
  const title = sanitizeFileName(m.title, room) ?? 'Meeting';
  return sanitizeFileName(`${prefix}${title}`, DOC_NAME_MAX_CHARS) ?? prefix.trim();
}

function meetingInfo(m: MeetingDocInput): string {
  const d = validDate(m.startedAt);
  const people = listedPeople(m.attendees.flatMap((a) => (a.name === null ? [] : [{ name: a.name, team: a.team }])));
  const names = (team: boolean): string => people.filter((x) => x.team === team).map((x) => x.name).join(', ') || 'None';
  const items = [
    `Client: ${docText(m.clientName) || `Client ${m.clientId}`}`,
    `Date: ${d ? `${istWeekday(d)} ${istDate(d)}, ${istTime(d)} IST` : 'unknown'}`,
    `Length: ${meetingLength(m.seconds)}`,
    `Attendees from our team: ${names(true)}`,
    `Attendees from the client: ${names(false)}`,
  ];
  return `<h2>Meeting info</h2>${list(items.map(esc))}${m.transcriptCut ? p(SUMMARY_CUT_NOTE) : ''}`;
}

function actionItems(s: MeetingSummary, side: 'us' | 'client'): string {
  return list(
    s.actionItems
      .filter((a) => a.side === side)
      .map((a) => {
        const parts = [docText(a.task)];
        const owner = a.owner === null ? '' : docText(a.owner);
        if (owner) parts.push(`Owner: ${owner}.`);
        if (a.deadline) parts.push(`Deadline: ${istWeekday(fromIstDate(a.deadline))} ${a.deadline}.`);
        return esc(parts.join(' '));
      }),
  );
}

function summarySections(s: MeetingSummary): string {
  const text = (t: string): string => (docText(t) ? p(t) : NONE);
  const discussion = s.discussion.map((d) => {
    const topic = esc(d.topic);
    const summary = esc(d.summary);
    if (!topic) return summary;
    return summary ? `<strong>${topic}</strong>: ${summary}` : `<strong>${topic}</strong>`;
  }).filter((x) => x);
  return [
    `<h2>What happened</h2>${text(s.whatHappened)}`,
    `<h2>Discussion points</h2>${list(discussion)}`,
    `<h2>Decisions</h2>${list(s.decisions.map((d) => esc(d.text)).filter((x) => x))}`,
    `<h2>Action items</h2><h3>Our team</h3>${actionItems(s, 'us')}<h3>Client</h3>${actionItems(s, 'client')}`,
    `<h2>Open questions</h2>${list(s.openQuestions.map(esc).filter((x) => x))}`,
    `<h2>Conclusion and next steps</h2>${text(s.conclusion)}`,
  ].join('');
}

/**
 * One paragraph per segment, "12:05 Rahul: text": the clock from the start, the name the summary gave the segment's shown
 * label, else the label. Segments with no text are skipped. Stops before the line that would pass DOC_TRANSCRIPT_MAX_CHARS
 * characters of transcript text, with TRANSCRIPT_REST_NOTE.
 */
function transcript(m: MeetingDocInput): string {
  const labels = speakerLabels(m.segments);
  const names = new Map<string, string>();
  for (const sp of m.summary.speakers) if (sp.name !== null && !names.has(sp.label)) names.set(sp.label, sp.name);
  const out: string[] = [];
  let chars = 0;
  let cut = false;
  for (const s of m.segments) {
    const text = docText(s.text);
    if (!text) continue;
    const label = shownLabel(labels, s.speaker);
    const line = `${formatClock(Number.isFinite(s.start) ? s.start : 0)} ${docText(names.get(label) ?? label) || label}: ${text}`;
    if (chars + line.length > DOC_TRANSCRIPT_MAX_CHARS) {
      cut = true;
      break;
    }
    chars += line.length;
    out.push(p(line));
  }
  return `<h2>Transcript</h2>${out.length ? out.join('') : NONE}${cut ? p(TRANSCRIPT_REST_NOTE) : ''}`;
}

/**
 * The summary Doc as HTML for Drive to convert (M6): the Doc name as title, Meeting info, the summary sections (each
 * "None" when empty), then the transcript.
 *
 * Built only from escaped text: every piece of content goes through docText (one line, no control or format
 * characters) and has & < > " ' escaped. The only tags, and the only line breaks between blocks, are the renderer's own;
 * no content becomes a link, an attribute or a style. The Doc never shows an email address.
 */
export function renderMeetingDoc(m: MeetingDocInput): string {
  const title = esc(meetingDocName(m));
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>`
    + `${meetingInfo(m)}${summarySections(m.summary)}${transcript(m)}</body></html>`;
}
