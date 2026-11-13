import { beforeAll, describe, expect, it, vi } from 'vitest';

// A browser module (its JSDoc types are checked by tsconfig.web.json). The chat module asks the browser for
// matchMedia as it loads, so a stub is put in place before the import.
let render: (t: unknown, o?: unknown) => string;
beforeAll(async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  // @ts-expect-error -- browser module (see above)
  ({ render } = await import('../../src/web/public/views/taskDrawer.js'));
});

const task = (over: Record<string, unknown> = {}) => ({
  code: 'ACM-1', title: 'Fix the logo', client: { code: 'ACM', name: 'Acme' }, owner: null, askedBy: null, deadline: null, status: 'open',
  overdue: false, priority: null, prioritySource: null, priorityKeyword: null, sentiment: null, source: 'whatsapp', sourceQuote: 'Please fix the logo @Rahul',
  sourceDate: '2026-11-11T13:12:00Z', sourceSender: 'Priya', sourceMessageId: 42, meetingTitle: null, askedAt: '2026-11-11T13:12:00Z',
  createdAt: '2026-11-11T13:14:00Z', sourceRevoked: false, latestProgress: null, remindedCount: 0, history: [], ...over,
});

describe('the task panel Proof block', () => {
  it('shows a message task as a button into the chat, with sender, quote, and both times', () => {
    const html: string = render(task());
    expect(html).toContain('Proof');
    expect(html).not.toContain('Where it came from');
    expect(html).toContain('<button type="button" class="quote quote-btn" data-open-source');
    expect(html).toContain('Priya');
    expect(html).toContain('Please fix the logo @Rahul');
    expect(html).toContain('Asked: 11 Nov, 18:42');
    expect(html).toContain('Found by the agent: 11 Nov, 18:44');
    expect(html).toContain('Open in chat');
  });

  it('is a plain bubble when the message is not stored, and keeps the deleted note', () => {
    const html: string = render(task({ sourceMessageId: null, sourceRevoked: true }));
    expect(html).not.toContain('data-open-source');
    expect(html).toContain('<div class="quote">');
    expect(html).toContain('the sender deleted this message');
  });

  it('names the meeting for a meeting task', () => {
    const html: string = render(task({ source: 'meeting', sourceQuote: null, sourceMessageId: null, sourceSender: null, meetingTitle: 'Kickoff call' }));
    expect(html).toContain('From the meeting Kickoff call, 11 Nov, 18:42');
    expect(html).toContain('Found by the agent: 11 Nov, 18:44');
    expect(html).not.toContain('data-open-source');
  });

  it('says a dashboard task was added by the owner', () => {
    const html: string = render(task({ source: 'dashboard', sourceQuote: null, sourceMessageId: null, sourceSender: null }));
    expect(html).toContain('Added by you on 11 Nov, 18:44');
  });

  it('escapes everything the agent sent', () => {
    const html: string = render(task({ sourceSender: '<img src=x onerror=1>', sourceQuote: '<script>1</script>', meetingTitle: '"><b>' }));
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
    const m: string = render(task({ source: 'meeting', meetingTitle: '"><b>' }));
    expect(m).not.toContain('"><b>');
  });
});
