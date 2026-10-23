import { describe, expect, it } from 'vitest';
import type { MeetingSummary } from '../../src/brain/meetingSchema.ts';
import {
  DOC_NAME_MAX_CHARS, DOC_TRANSCRIPT_MAX_CHARS, SUMMARY_CUT_NOTE, TRANSCRIPT_REST_NOTE, docText, meetingDocName, renderMeetingDoc,
  type MeetingDocInput,
} from '../../src/meetings/doc.ts';
import type { Segment } from '../../src/stt/types.ts';

const seg = (start: number, speaker: string | null, text: string): Segment => ({ start, end: start + 3, speaker, text });

const emptySummary: MeetingSummary = {
  whatHappened: '', discussion: [], decisions: [], actionItems: [], openQuestions: [], conclusion: '', speakers: [],
};

const summary: MeetingSummary = {
  whatHappened: 'The logo was approved.',
  discussion: [{ topic: 'Logo', summary: 'Two options were compared.' }],
  decisions: [{ text: 'Option B is final.', segmentIds: ['s2'] }],
  actionItems: [
    { side: 'us', task: 'Send the final files.', owner: 'Asha Verma', deadline: '2026-10-25', segmentIds: ['s2'] },
    { side: 'client', task: 'Share the brand colours.', owner: null, deadline: null, segmentIds: ['s2'] },
  ],
  openQuestions: ['Who prints the cards?'],
  conclusion: 'Files go out on Sunday.',
  speakers: [{ label: 'A', name: 'Asha Verma' }, { label: 'B', name: null }],
};

const base: MeetingDocInput = {
  clientId: 1,
  clientName: 'Sharma Interiors',
  title: 'Logo review',
  startedAt: '2026-10-19T08:35:00Z',
  seconds: 3725,
  attendees: [
    { name: 'Asha Verma', email: 'asha@studio.in', team: true },
    { name: 'Mr. Sharma', email: 'sharma@client.in', team: false },
  ],
  summary,
  segments: [seg(0, 'A', 'Namaste, shall we start?'), seg(75.4, 'B', 'Haan, logo final kar dete hain.'), seg(3725, null, 'Thank you.')],
  transcriptCut: false,
};

/** The body between <body> and </body>, split at each block tag the renderer makes. */
const body = (html: string): string => html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'));
/** Every tag in the HTML, without its text. */
const tags = (html: string): string[] => html.match(/<[^>]*>/g) ?? [];
const ALLOWED_TAGS = /^<\/?(html|head|body|title|h1|h2|h3|p|ul|li|strong)>$|^<!doctype html>$|^<meta charset="utf-8">$/;

describe('renderMeetingDoc', () => {
  it('has the fixed wrapper, the Doc name as title and h1, and the sections in M6 order', () => {
    const html = renderMeetingDoc(base);
    const name = '2026-10-19 – Sharma Interiors – Logo review';
    expect(html.startsWith(`<!doctype html><html><head><meta charset="utf-8"><title>${name}</title></head><body><h1>${name}</h1>`)).toBe(true);
    expect(html.endsWith('</body></html>')).toBe(true);
    const headings = [...html.matchAll(/<h[23]>([^<]*)<\/h[23]>/g)].map((m) => m[1]);
    expect(headings).toEqual([
      'Meeting info', 'What happened', 'Discussion points', 'Decisions', 'Action items', 'Our team', 'Client', 'Open questions',
      'Conclusion and next steps', 'Transcript',
    ]);
  });

  it('shows the meeting info: client, IST date with weekday, length, attendees by side, never emails', () => {
    const html = renderMeetingDoc(base);
    expect(html).toContain('<li>Client: Sharma Interiors</li>');
    expect(html).toContain('<li>Date: Monday 2026-10-19, 14:05 IST</li>');
    expect(html).toContain('<li>Length: 1 h 02 min</li>');
    expect(html).toContain('<li>Attendees from our team: Asha Verma</li>');
    expect(html).toContain('<li>Attendees from the client: Mr. Sharma</li>');
    expect(html).not.toMatch(/@|studio\.in|client\.in/);
  });

  it('never shows an email, even one inside a name or as the whole name, and leaves out unnamed attendees', () => {
    const html = renderMeetingDoc({
      ...base,
      attendees: [
        { name: 'Priya <priya@x.in>', email: 'priya@x.in', team: true },
        { name: 'rahul@client.in', team: false },
        { name: null, email: 'ghost@x.in', team: false },
      ],
    });
    expect(html).toContain('<li>Attendees from our team: Priya</li>');
    expect(html).toContain('<li>Attendees from the client: None</li>');
    expect(html).not.toMatch(/@|x\.in|client\.in/);
  });

  it('renders every summary section, with action items split into our team and the client', () => {
    const b = body(renderMeetingDoc(base));
    expect(b).toContain('<h2>What happened</h2><p>The logo was approved.</p>');
    expect(b).toContain('<h2>Discussion points</h2><ul><li><strong>Logo</strong>: Two options were compared.</li></ul>');
    expect(b).toContain('<h2>Decisions</h2><ul><li>Option B is final.</li></ul>');
    expect(b).toContain(
      '<h2>Action items</h2><h3>Our team</h3><ul><li>Send the final files. Owner: Asha Verma. Deadline: Sunday 2026-10-25.</li></ul>'
      + '<h3>Client</h3><ul><li>Share the brand colours.</li></ul>',
    );
    expect(b).toContain('<h2>Open questions</h2><ul><li>Who prints the cards?</li></ul>');
    expect(b).toContain('<h2>Conclusion and next steps</h2><p>Files go out on Sunday.</p>');
  });

  it('shows "None" for every empty section, and for an empty action-item side', () => {
    const b = body(renderMeetingDoc({ ...base, summary: emptySummary, segments: [] }));
    for (const h of ['What happened', 'Discussion points', 'Decisions', 'Our team', 'Client', 'Open questions', 'Conclusion and next steps', 'Transcript']) {
      const tag = h === 'Our team' || h === 'Client' ? 'h3' : 'h2';
      expect(b).toContain(`<${tag}>${h}</${tag}><p>None</p>`);
    }
    const onlyClient = body(renderMeetingDoc({ ...base, summary: { ...summary, actionItems: [summary.actionItems[1]!] } }));
    expect(onlyClient).toContain('<h3>Our team</h3><p>None</p><h3>Client</h3><ul><li>Share the brand colours.</li></ul>');
  });

  it('shows a discussion point with only a topic or only a summary', () => {
    const b = body(renderMeetingDoc({ ...base, summary: { ...summary, discussion: [{ topic: 'Budget', summary: '' }, { topic: '', summary: 'Talked about print.' }] } }));
    expect(b).toContain('<ul><li><strong>Budget</strong></li><li>Talked about print.</li></ul>');
  });

  it('writes one transcript paragraph per segment: clock, the summary name for the shown label, else the label', () => {
    const b = body(renderMeetingDoc(base));
    expect(b).toContain(
      '<h2>Transcript</h2><p>0:00 Asha Verma: Namaste, shall we start?</p><p>1:15 B: Haan, logo final kar dete hain.</p>'
      + '<p>1:02:05 Speaker: Thank you.</p>',
    );
  });

  it('maps names through the shown labels, including a "~2" label for a raw label that cleans to the same text', () => {
    const b = body(renderMeetingDoc({
      ...base,
      segments: [seg(0, 'A', 'first'), seg(5, 'A​', 'second'), seg(9, 'A', 'third')],
      summary: { ...emptySummary, speakers: [{ label: 'A~2', name: 'Mr. Sharma' }, { label: 'A', name: 'Asha Verma' }] },
    }));
    expect(b).toContain('<p>0:00 Asha Verma: first</p><p>0:05 Mr. Sharma: second</p><p>0:09 Asha Verma: third</p>');
  });

  it('stops the transcript at 900,000 characters with the office PC note, at a segment boundary', () => {
    const text = 'x'.repeat(99_990); // "0:00 A: " (8) + text = 99,998 characters a line
    const segments = Array.from({ length: 10 }, (_, i) => seg(i, 'A', text));
    const html = renderMeetingDoc({ ...base, summary: emptySummary, segments });
    const lines = [...html.matchAll(/<p>(\d+:\d\d A: x+)<\/p>/g)].map((m) => m[1]!);
    expect(lines).toHaveLength(9);
    expect(lines.reduce((n, l) => n + l.length, 0)).toBeLessThanOrEqual(DOC_TRANSCRIPT_MAX_CHARS);
    expect(html).toContain(`<p>${TRANSCRIPT_REST_NOTE}</p></body>`);
    expect(TRANSCRIPT_REST_NOTE).toBe('The transcript continues on the office PC.');
    const short = renderMeetingDoc({ ...base, summary: emptySummary, segments: segments.slice(0, 9) });
    expect(short).not.toContain(TRANSCRIPT_REST_NOTE);
  });

  it('notes when the summary covers only the first part of the meeting, and not otherwise', () => {
    expect(renderMeetingDoc({ ...base, transcriptCut: true })).toContain(`<p>${SUMMARY_CUT_NOTE}</p><h2>What happened</h2>`);
    expect(renderMeetingDoc(base)).not.toContain(SUMMARY_CUT_NOTE);
  });

  it('escapes every field and keeps only the tags the renderer makes', () => {
    const evil = `<script>alert("x")</script> & 'q' </p><a href="javascript:1">`;
    const html = renderMeetingDoc({
      clientId: 1,
      clientName: `Sharma ${evil}`,
      title: `Kickoff ${evil}‮gnp.exe`,
      startedAt: base.startedAt,
      seconds: 60,
      attendees: [{ name: `Asha ${evil}`, team: true }, { name: `Raj ${evil}`, team: false }],
      summary: {
        whatHappened: `wh ${evil}\n\nnext\u0007line‮`,
        discussion: [{ topic: `t ${evil}`, summary: `s ${evil}` }],
        decisions: [{ text: `d ${evil}`, segmentIds: ['s1'] }],
        actionItems: [
          { side: 'us', task: `a ${evil}`, owner: `o ${evil}`, deadline: '2026-10-25', segmentIds: ['s1'] },
          { side: 'client', task: `c ${evil}`, owner: null, deadline: null, segmentIds: ['s1'] },
        ],
        openQuestions: [`q ${evil}`],
        conclusion: `c ${evil}￿\uD800`,
        speakers: [{ label: 'A', name: `Asha ${evil}` }],
      },
      segments: [seg(0, 'A', `hello ${evil}\r\nbye\u0000`), seg(3, `<b>"x"</b>`, `t ${evil}`)],
      transcriptCut: true,
    });
    for (const t of tags(html)) expect(t).toMatch(ALLOWED_TAGS);
    // The words survive as text; no quote around an attribute value is left unescaped.
    expect(html).not.toMatch(/<script|<a |<\/?b>|href="|javascript:1"/);
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39; &lt;/p&gt;&lt;a href=&quot;javascript:1&quot;&gt;');
    // Control, format and XML-invalid characters are gone; content newlines become spaces.
    expect(html).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‮￿\n\r]|[\uD800-\uDFFF]/);
    expect(html).toContain('&gt; nextline');
    expect(html).toContain('hello ');
    expect(html).toContain('&gt; bye</p>');
  });

  it('builds the date from IST and says "unknown" for a start time that does not parse', () => {
    expect(renderMeetingDoc({ ...base, startedAt: '2026-10-19T20:00:00Z' })).toContain('<li>Date: Tuesday 2026-10-20, 01:30 IST</li>');
    expect(renderMeetingDoc({ ...base, startedAt: 'not a date' })).toContain('<li>Date: unknown</li>');
  });
});

describe('docText', () => {
  it('drops control and format characters except the joiners, and folds white space to single spaces', () => {
    expect(docText(' a\r\n\tb\u0085c d  ‮e​f‍g\u0000 ')).toBe('a b c d ef‍g');
  });
});

describe('meetingDocName', () => {
  const m = { clientId: 1, clientName: 'Sharma Interiors', title: 'Logo review', startedAt: '2026-10-19T20:00:00Z' };

  it('is "YYYY-MM-DD – Client – Title" with en dashes and the IST date', () => {
    expect(meetingDocName(m)).toBe('2026-10-20 – Sharma Interiors – Logo review');
  });

  it('uses "Meeting" for an empty or invisible title, and "Client <id>" for a client name with nothing to show', () => {
    expect(meetingDocName({ ...m, title: '' })).toBe('2026-10-20 – Sharma Interiors – Meeting');
    expect(meetingDocName({ ...m, title: ' ‮​ ' })).toBe('2026-10-20 – Sharma Interiors – Meeting');
    expect(meetingDocName({ ...m, clientName: '...' })).toBe('2026-10-20 – Client 1 – Logo review');
  });

  it('sanitises each part: Drive-unsafe characters become "_", hidden characters go, white space folds', () => {
    expect(meetingDocName({ ...m, clientName: 'A/B', title: 'Review: "v2" <final>‮txt.exe\n  done' }))
      .toBe('2026-10-20 – A_B – Review_ _v2_ _final_txt.exe done');
  });

  it('caps the name at 150 characters, cutting the title first', () => {
    const long = meetingDocName({ ...m, title: 'T'.repeat(400) });
    expect([...long].length).toBe(DOC_NAME_MAX_CHARS);
    expect(long.startsWith('2026-10-20 – Sharma Interiors – TTT')).toBe(true);
    const longClient = meetingDocName({ ...m, clientName: 'C'.repeat(300), title: 'Title words here' });
    expect([...longClient].length).toBeLessThanOrEqual(DOC_NAME_MAX_CHARS);
    expect(longClient.startsWith(`2026-10-20 – ${'C'.repeat(120)} – Title`)).toBe(true);
  });

  it('counts characters, not UTF-16 units, so an emoji is never split', () => {
    const name = meetingDocName({ ...m, title: '😀'.repeat(200) });
    expect([...name].length).toBe(DOC_NAME_MAX_CHARS);
    expect(name).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('leaves out the date when the start time does not parse', () => {
    expect(meetingDocName({ ...m, startedAt: 'nope' })).toBe('Sharma Interiors – Logo review');
  });
});
