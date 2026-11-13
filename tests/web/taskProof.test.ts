import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// A browser module (its JSDoc types are checked by tsconfig.web.json). The chat module asks the browser for
// matchMedia as it loads, so a stub is put in place before the import. The clock is frozen so "this year" is stable.
let render: (t: unknown, o?: unknown) => string;
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-13T06:30:00Z') });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  // @ts-expect-error -- browser module (see above)
  ({ render } = await import('../../src/web/public/views/taskDrawer.js'));
});
afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const task = (over: Record<string, unknown> = {}) => ({
  code: 'ACM-1', title: 'Fix the logo', client: { code: 'ACM', name: 'Acme' }, owner: null, askedBy: null, deadline: null, status: 'open',
  overdue: false, priority: null, prioritySource: null, priorityKeyword: null, sentiment: null, source: 'whatsapp', sourceQuote: 'Please fix the logo @Rahul',
  sourceDate: '2026-11-11', sourceSender: 'Priya', sourceMessageId: 42, meetingTitle: null, askedAt: '2026-11-11T13:12:00.000Z',
  createdAt: '2026-11-11T13:14:00.000Z', sourceRevoked: false, latestProgress: null, remindedCount: 0, history: [], ...over,
});

describe('the task panel Proof block', () => {
  it('shows a message task as a button into the chat, with sender, quote, and the message time', () => {
    const html: string = render(task());
    expect(html).toContain('Proof');
    expect(html).not.toContain('Where it came from');
    expect(html).toContain('<button type="button" class="quote quote-btn" data-open-source>');
    expect(html).not.toContain('aria-label="Open in chat');
    expect(html).toContain('Priya');
    expect(html).toContain('Please fix the logo @Rahul');
    expect(html).toContain('<small>11 Nov, 18:42</small>');
    expect(html).toContain('Asked: 11 Nov, 18:42');
    expect(html).toContain('Found by the agent: 11 Nov, 18:44');
    expect(html).toContain('Open in chat');
  });

  it('shows only the day when the message is not stored, as a plain bubble, and keeps the deleted note', () => {
    const html: string = render(task({ sourceMessageId: null, sourceRevoked: true }));
    expect(html).not.toContain('data-open-source');
    expect(html).toContain('<div class="quote">');
    expect(html).toContain('<small>11 Nov 2026 · the sender deleted this message</small>');
    expect(html).not.toContain('05:30');
  });

  it('leaves out an empty time line', () => {
    expect(render(task({ sourceMessageId: null, sourceDate: null }))).not.toContain('<small></small>');
  });

  it("shows a removed client's message as a plain bubble, with no Open in chat", () => {
    const html: string = render(task({ clientActive: false }));
    expect(html).not.toContain('data-open-source');
    expect(html).not.toContain('Open in chat');
    expect(html).toContain('Please fix the logo @Rahul');
    expect(html).toContain('<small>11 Nov, 18:42</small>');
    expect(render(task({ clientActive: false, sourceQuote: null }))).not.toContain('data-open-source');
    expect(render(task({ clientActive: true }))).toContain('data-open-source');
  });

  it('draws the button only for a real id', () => {
    expect(render(task({ sourceMessageId: undefined }))).not.toContain('data-open-source');
  });

  it('offers a small button when the message is stored but there is no quote', () => {
    const html: string = render(task({ sourceQuote: null }));
    expect(html).toContain('data-open-source');
    expect(html).toContain('btn btn-ghost btn-sm');
  });

  it('names the meeting for a meeting task, and its quote has no sender name', () => {
    const html: string = render(task({ source: 'meeting', sourceMessageId: null, sourceSender: null, sourceQuote: 'We agreed to redo it', meetingTitle: 'Kickoff call' }));
    expect(html).toContain('From the meeting Kickoff call, 11 Nov, 18:42');
    expect(html).toContain('Found by the agent: 11 Nov, 18:44');
    expect(html).toContain('Said in the meeting');
    expect(html).not.toContain('Member');
    expect(html).not.toContain('data-open-source');
    expect(render(task({ source: 'meeting', sourceMessageId: null, sourceQuote: null, meetingTitle: null }))).toContain('From a meeting, 11 Nov, 18:42');
  });

  it('shows the message proof for a meeting task that came from a chat message', () => {
    const html: string = render(task({ source: 'meeting', meetingTitle: 'Kickoff call' }));
    expect(html).toContain('data-open-source');
    expect(html).toContain('Priya');
    expect(html).toContain('Also discussed in the meeting Kickoff call');
  });

  it('says a dashboard task was added by the owner', () => {
    const html: string = render(task({ source: 'dashboard', sourceQuote: null, sourceMessageId: null, sourceSender: null }));
    expect(html).toContain('Added by you on 11 Nov, 18:44');
  });

  it('escapes everything the agent sent', () => {
    const html: string = render(task({ sourceSender: '<img src=x onerror=1>', sourceQuote: '<script>1</script>' }));
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
    const m: string = render(task({ source: 'meeting', sourceMessageId: null, meetingTitle: '"><b>' }));
    expect(m).not.toContain('"><b>');
  });
});
