import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error -- Three.js ships no types; the agent serves it to the browser (/dashboard/vendor/three.js)
import * as REAL_THREE from 'three';
// Browser module; its JSDoc types are checked by tsconfig.web.json, so the import is untyped here.
// @ts-expect-error -- browser module (see above)
import { chatGroup, entryHtml, entryOf, heroHtml, listHtml } from '../../src/web/public/views/assistant.js';
// @ts-expect-error -- browser module (see above)
import { showScreens } from '../../src/web/public/router.js';
// @ts-expect-error -- browser module (see above)
import { startWaves, wavesWith } from '../../src/web/public/wavefield.js';

// The assistant's page (November release, changes 1 and 8): the chat list's groups, that every word from the agent
// (titles, questions, answers, cards, links) reaches the page escaped, and the empty chat's wave field (its points, its
// one WebGL context freed on leave, the still frame with reduced motion, and no drawing while the page is hidden).

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
  it('shows the heading with one green word and the offered questions escaped, each with its icon (the waves sit behind)', () => {
    const html: string = heroHtml(['Summarise today', '<img src=x onerror=alert(1)>']);
    expect(html).not.toContain('<canvas'); // the wave field is a layer behind the conversation, not part of the hero
    expect(html).toContain('Your agent · answers from your workspace');
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

describe('the wave field (wavefield.js)', () => {
  /** A renderer without a GPU: it keeps what the field asks of it. */
  class FakeRenderer {
    static made: FakeRenderer[] = [];
    pixel = 0;
    renders = 0;
    disposed = false;
    lost = false;
    outputColorSpace = '';
    scene: any = null;
    constructor() {
      FakeRenderer.made.push(this);
    }
    setPixelRatio(p: number) {
      this.pixel = p;
    }
    setSize() {}
    render(scene: unknown) {
      this.renders++;
      this.scene = scene;
    }
    dispose() {
      this.disposed = true;
    }
    forceContextLoss() {
      this.lost = true;
    }
  }
  const THREE = { ...REAL_THREE, WebGLRenderer: FakeRenderer };
  const canvas = { getBoundingClientRect: () => ({ width: 1000, height: 600 }) };
  const LAPTOP = { reduceMotion: false, phone: false, parallax: true };

  /** The browser's frames, run by hand. */
  let frames: Map<number, (t: number) => void>;
  let clock: number;
  const tick = (n = 1) => {
    for (let i = 0; i < n; i++) {
      clock += 16;
      const due = [...frames.values()];
      frames.clear();
      for (const fn of due) fn(clock);
    }
  };
  let doc: EventTarget & { hidden: boolean, documentElement: { dataset: { theme: string } } };
  let win: EventTarget;
  let themeChanged: () => void;
  let observing: number;

  beforeEach(() => {
    FakeRenderer.made = [];
    frames = new Map();
    clock = 0;
    let id = 0;
    vi.stubGlobal('requestAnimationFrame', (fn: (t: number) => void) => {
      frames.set(++id, fn);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (n: number) => frames.delete(n));
    doc = Object.assign(new EventTarget(), { hidden: false, documentElement: { dataset: { theme: 'dark' } } });
    vi.stubGlobal('document', doc);
    win = new EventTarget();
    vi.stubGlobal('addEventListener', win.addEventListener.bind(win));
    vi.stubGlobal('removeEventListener', win.removeEventListener.bind(win));
    vi.stubGlobal('devicePixelRatio', 3);
    observing = 0;
    themeChanged = () => {};
    vi.stubGlobal('ResizeObserver', class {
      observe() { observing++; }
      disconnect() { observing--; }
    });
    vi.stubGlobal('MutationObserver', class {
      constructor(fn: () => void) { themeChanged = fn; }
      observe() { observing++; }
      disconnect() { observing--; }
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const pointsOf = (r: FakeRenderer) => r.scene.children.find((c: any) => c.isPoints);

  it('draws about 2,500 points on a laptop and 900 on a phone, in one WebGL context, the pixel ratio capped at 1.5', () => {
    const laptop = wavesWith(THREE, canvas, LAPTOP);
    tick();
    const [r] = FakeRenderer.made;
    expect(FakeRenderer.made).toHaveLength(1);
    expect(r!.pixel).toBe(1.5);
    expect(r!.renders).toBe(1);
    const n = pointsOf(r!).geometry.getAttribute('position').count;
    expect(n).toBeGreaterThanOrEqual(2_400);
    expect(n).toBeLessThanOrEqual(2_600);
    laptop.stop();
    wavesWith(THREE, canvas, { ...LAPTOP, phone: true, parallax: false });
    tick();
    expect(pointsOf(FakeRenderer.made[1]!).geometry.getAttribute('position').count).toBe(900);
  });

  it('stop frees the renderer and its context, the geometry and the material, and draws no more frames', () => {
    const waves = wavesWith(THREE, canvas, LAPTOP);
    tick(3);
    const r = FakeRenderer.made[0]!;
    const points = pointsOf(r);
    const freed: string[] = [];
    points.geometry.addEventListener('dispose', () => freed.push('geometry'));
    points.material.addEventListener('dispose', () => freed.push('material'));
    expect(observing).toBe(2); // its size and the theme
    waves.stop();
    expect(freed.sort()).toEqual(['geometry', 'material']);
    expect(r.disposed).toBe(true);
    expect(r.lost).toBe(true); // the context goes at once, not when the page is collected
    expect(frames.size).toBe(0);
    expect(observing).toBe(0);
    doc.dispatchEvent(new Event('visibilitychange')); // its listeners are gone too
    win.dispatchEvent(new Event('pointermove'));
    tick(3);
    expect(r.renders).toBe(3);
    waves.stop(); // twice is harmless
  });

  it('with reduced motion it draws one still frame, and draws it again only when asked to think or the theme changes', () => {
    const waves = wavesWith(THREE, canvas, { ...LAPTOP, reduceMotion: true });
    const r = FakeRenderer.made[0]!;
    expect(r.renders).toBe(1);
    expect(frames.size).toBe(0);
    tick(5);
    expect(r.renders).toBe(1);
    const u = pointsOf(r).material.uniforms;
    expect(u.uThink.value).toBe(0);
    waves.think(true); // still: straight to the thinking frame
    expect(r.renders).toBe(2);
    expect(u.uThink.value).toBe(1);
    expect(u.uLight.value).toBe(0);
    doc.documentElement.dataset.theme = 'light';
    themeChanged();
    expect(r.renders).toBe(3);
    expect(u.uLight.value).toBe(1); // muted greens on white
    expect(frames.size).toBe(0);
    waves.stop();
  });

  it('draws nothing while the page is hidden, and goes on when it shows again', () => {
    const waves = wavesWith(THREE, canvas, LAPTOP);
    tick(2);
    const r = FakeRenderer.made[0]!;
    doc.hidden = true;
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(frames.size).toBe(0);
    tick(10);
    expect(r.renders).toBe(2);
    doc.hidden = false;
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(frames.size).toBe(1);
    tick(2);
    expect(r.renders).toBe(4);
    waves.stop();
  });

  it('thinking eases the waves faster and higher, then back to idle when the answer ends', () => {
    const waves = wavesWith(THREE, canvas, LAPTOP);
    tick();
    const u = pointsOf(FakeRenderer.made[0]!).material.uniforms;
    const step = () => {
      const t0 = u.uTime.value;
      tick();
      return u.uTime.value - t0;
    };
    const idle = step();
    expect(idle).toBeGreaterThan(0);
    waves.think(true);
    tick();
    expect(u.uThink.value).toBeGreaterThan(0);
    expect(u.uThink.value).toBeLessThan(0.5); // eased in, not a jump
    tick(200);
    expect(u.uThink.value).toBeGreaterThan(0.95);
    expect(step()).toBeGreaterThan(idle * 1.8);
    waves.think(false);
    tick(200);
    expect(u.uThink.value).toBeLessThan(0.05);
    expect(step()).toBeLessThan(idle * 1.1);
    waves.stop();
  });

  it('without Three.js or without WebGL it draws nothing (the page keeps its CSS glow)', async () => {
    class NoWebgl {
      constructor() {
        throw new Error('no WebGL');
      }
    }
    expect(wavesWith({ ...REAL_THREE, WebGLRenderer: NoWebgl }, canvas, LAPTOP)).toBeNull();
    expect(await startWaves(canvas, LAPTOP)).toBeNull(); // /dashboard/vendor/three.js is the browser's, not here
    expect(frames.size).toBe(0);
  });
});
