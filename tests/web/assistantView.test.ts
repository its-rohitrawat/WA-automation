import { describe, expect, it } from 'vitest';
// Browser module; its JSDoc types are checked by tsconfig.web.json, so the import is untyped here.
// @ts-expect-error -- browser module (see above)
import { chatGroup, entryHtml, entryOf, heroHtml, listHtml } from '../../src/web/public/views/assistant.js';
// @ts-expect-error -- browser module (see above)
import { showScreens } from '../../src/web/public/router.js';

// The assistant's page (November release, changes 1 and 8): the chat list's groups, and that every word from the agent
// (titles, questions, answers, cards, links) reaches the page escaped.

const NOW = new Date('2026-11-02T10:00:00.000Z'); // 15:30 IST, Monday 2 November

describe('the chat list', () => {
  it('groups chats by when they were last used, in India time: Today, Yesterday, Previous 7 days, Older', () => {
    expect(chatGroup('2026-11-02T00:00:00.000Z', NOW)).toBe('Today'); // 05:30 IST on the 2nd
    expect(chatGroup('2026-11-01T19:00:00.000Z', NOW)).toBe('Today'); // 00:30 IST on the 2nd
    expect(chatGroup('2026-11-01T18:00:00.000Z', NOW)).toBe('Yesterday'); // 23:30 IST on the 1st
    expect(chatGroup('2026-10-27T10:00:00.000Z', NOW)).toBe('Previous 7 days');
    expect(chatGroup('2026-10-26T10:00:00.000Z', NOW)).toBe('Previous 7 days'); // 7 days before
    expect(chatGroup('2026-10-25T10:00:00.000Z', NOW)).toBe('Older'); // 8 days before
    expect(chatGroup('', NOW)).toBe('Older');
    expect(chatGroup('not a date', NOW)).toBe('Older');
  });

  it('escapes every title, marks the open chat, and says so when there is none', () => {
    const html: string = listHtml([
      { id: 7, title: '<img src=x onerror=alert(1)>', updatedAt: new Date().toISOString(), running: true },
      { id: 3, title: 'Plain "quoted"', updatedAt: '2020-01-01T00:00:00.000Z', running: false },
    ], 7);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('aria-label="Rename &lt;img src=x onerror=alert(1)&gt;"');
    expect(html).toContain('href="/dashboard/assistant/7" data-chat="7" aria-current="page"');
    expect(html).toContain('class="asst-live"');
    expect(html).toContain('>Older<');
    expect(listHtml([], null)).toContain('Your chats show here.');
  });
});

describe('the empty chat', () => {
  it('shows the core canvas, the heading with one green word, and the offered questions escaped, each with its icon', () => {
    const html: string = heroHtml(['Summarise today', '<img src=x onerror=alert(1)>']);
    expect(html).toContain('<div class="asst-core" data-core aria-hidden="true"><canvas></canvas></div>');
    expect(html).toContain('Ask your agent <em>anything.</em>');
    expect(html).toContain('data-ask="Summarise today"');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html.match(/class="asst-sugg-card"/g)).toHaveLength(2);
    expect(html.match(/<svg/g)).toHaveLength(2); // an icon each (an unknown question gets the spark)
  });

  it('a message added now fades up once; a stored one draws still; the agent orb thinks while it runs', () => {
    expect(entryHtml({ who: 'me', text: 'hi', fresh: true }, 0)).toBe('<div class="asst-msg me enter">hi</div>');
    expect(entryHtml(entryOf({ role: 'user', body: 'hi' }), 0)).toBe('<div class="asst-msg me">hi</div>');
    expect(entryHtml(entryOf({ role: 'assistant', body: 'x', status: 'running' }), 1)).toContain('class="asst-orb thinking"');
    expect(entryHtml(entryOf({ role: 'assistant', body: 'x', status: 'done' }), 1)).toContain('class="asst-orb"');
  });
});

describe('a stored chat on the page', () => {
  it('draws a question and an answer as escaped text, with **bold** the only mark kept', () => {
    expect(entryHtml(entryOf({ role: 'user', body: '<script>x</script>' }), 0)).toBe('<div class="asst-msg me">&lt;script&gt;x&lt;/script&gt;</div>');
    const answer: string = entryHtml(entryOf({ role: 'assistant', body: 'Hi <b>there</b> **11 open**', status: 'done', costUsd: 0.02, note: null, cards: [], links: [] }), 1);
    expect(answer).toContain('Hi &lt;b&gt;there&lt;/b&gt; <b>11 open</b>');
    expect(answer).toContain('≈ $0.02');
  });

  it('a card is live only while this session can confirm it; confirmed, cancelled and expired cards have no buttons', () => {
    const card = (c: object) => entryHtml(entryOf({ role: 'assistant', body: 'x', status: 'done', cards: [{ id: 'c1', title: '<i>T</i>', lines: ['<u>l</u>'], expiresAt: '2026-11-02T10:10:00.000Z', state: 'waiting', ...c }], links: [] }), 1);
    expect(card({ live: true })).toContain('data-confirm');
    expect(card({ live: true })).toContain('&lt;i&gt;T&lt;/i&gt;');
    expect(card({ live: true })).toContain('<li>&lt;u&gt;l&lt;/u&gt;</li>');
    expect(card({ live: false })).toContain('Not confirmed. Nothing changed.');
    expect(card({ state: 'confirmed', said: '<b>ACM-006</b> added.' })).toContain('&lt;b&gt;ACM-006&lt;/b&gt; added.');
    expect(card({ state: 'cancelled' })).toContain('Cancelled. Nothing changed.');
    for (const c of [{ live: false }, { state: 'confirmed' }, { state: 'cancelled' }]) expect(card(c)).not.toContain('data-confirm');
  });

  it('a customer gets no link to a screen it does not have (Connections, AI usage); the founder does (Nov release piece 3)', () => {
    const answer = entryOf({ role: 'assistant', body: 'x', status: 'done', links: [{ screen: 'usage', search: '', label: 'usage' }, { screen: 'tasks', search: '', label: 'tasks' }], cards: [] });
    try {
      showScreens({ role: 'owner', assistant: true });
      const html: string = entryHtml(answer, 1);
      expect(html).toContain('Open tasks');
      expect(html).not.toContain('Open usage');
      showScreens({ role: 'founder', assistant: true });
      expect(entryHtml(answer, 1)).toContain('Open usage');
    } finally {
      showScreens({ role: 'founder' });
    }
  });

  it('a screen link keeps only a plain query string; a running answer shows its dots; an interrupted one says so', () => {
    const links = entryHtml(entryOf({ role: 'assistant', body: 'x', status: 'done', links: [{ screen: 'tasks', search: '?status=overdue', label: '<b>tasks</b>' }, { screen: 'tasks', search: 'javascript:alert(1)', label: 'x' }], cards: [] }), 2);
    expect(links).toContain('Open &lt;b&gt;tasks&lt;/b&gt;');
    expect(entryOf({ role: 'assistant', body: '', links: [{ screen: 'tasks', search: '"><script>', label: 'x' }] }).links[0].search).toBe('');
    expect(entryHtml(entryOf({ role: 'assistant', body: 'Part one', status: 'running' }), 3)).toContain('class="asst-step"');
    // While it streams, a closed **bold** shows bold and an open one stays text; the rest is escaped as ever.
    expect(entryHtml(entryOf({ role: 'assistant', body: '**11 open** and **par <i>', status: 'running' }), 3)).toContain('<b>11 open</b> and **par &lt;i&gt;');
    expect(entryHtml(entryOf({ role: 'assistant', body: 'Part one', status: 'interrupted' }), 3)).toContain('cut off when the agent restarted');
  });
});
