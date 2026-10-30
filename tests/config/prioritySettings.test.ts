import { describe, expect, it } from 'vitest';
import {
  checkKeywords, DEFAULT_KEYWORDS, KEYWORD_MAX_CHARS, KEYWORDS_PER_LEVEL, PrioritySettings, readSentimentEnabled,
} from '../../src/config/prioritySettings.ts';
import { ControlError, type AuditEntry } from '../../src/control/errors.ts';
import type { Db } from '../../src/store/db.ts';
import { getKv } from '../../src/store/kv.ts';
import { manualClock } from '../../src/util/clock.ts';
import { NOW, seededDb } from '../helpers/db.ts';
import { rawOf } from '../../src/store/engine/sqlite.ts';

const OWNER = 'owner@example.com';
const EMPTY = { critical: [], major: [], medium: [], low: [] };

async function setup() {
  const db = await seededDb();
  const clock = manualClock(NOW);
  const store = new PrioritySettings({ db, clock });
  const audits: AuditEntry[] = [];
  return { db, clock, store, audits, audit: async (_q: unknown, e: AuditEntry) => { audits.push(e); } };
}

const rows = (db: Db) => rawOf(db).prepare('SELECT k, v, updated_by AS by FROM settings ORDER BY k').all();

async function refusal(fn: () => unknown): Promise<ControlError> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof ControlError) return e;
    throw e;
  }
  throw new Error('expected a ControlError');
}

describe('PrioritySettings', () => {
  it('starts with the starting lists and sentiment off, and says they are the defaults', async () => {
    const { db, store } = await setup();
    expect(store.get()).toEqual({ keywords: DEFAULT_KEYWORDS, sentimentEnabled: false });
    expect(await store.view()).toEqual({
      keywords: DEFAULT_KEYWORDS, sentimentEnabled: false, source: { priorityKeywords: 'default', sentimentEnabled: 'default' },
      limits: { perLevel: KEYWORDS_PER_LEVEL, maxChars: KEYWORD_MAX_CHARS },
    });
    expect(await readSentimentEnabled(db)).toBe(false);
  });

  it('saves the cleaned lists and audits counts only, in one transaction', async () => {
    const { db, store, audits, audit } = await setup();
    const view = await store.set('priorityKeywords', { critical: ['  Site   down ', 'URGENT', 'urgent', ''], major: ['zaroori'], medium: [], low: ['no rush'] }, OWNER, audit);
    expect(view.keywords).toEqual({ critical: ['Site down', 'URGENT'], major: ['zaroori'], medium: [], low: ['no rush'] });
    expect(view.source.priorityKeywords).toBe('dashboard');
    expect(audits).toEqual([{ actor: OWNER, event: 'settings.priorityKeywords', kind: 'config', detail: 'Priority keywords saved (Critical 2, Major 1, Medium 0, Low 1)' }]);
    expect(JSON.stringify(audits)).not.toContain('Site down');
    expect(rows(db)).toEqual([{ k: 'priorityKeywords', v: JSON.stringify(view.keywords), by: OWNER }]);
  });

  it('lets the owner empty every list', async () => {
    const { store, audit } = await setup();
    expect((await store.set('priorityKeywords', EMPTY, OWNER, audit)).keywords).toEqual(EMPTY);
    expect(store.get().keywords).toEqual(EMPTY);
  });

  it('switches sentiment on and off, audits it and asks for a tracker rebuild', async () => {
    const { db, store, audits, audit } = await setup();
    expect((await store.set('sentimentEnabled', true, OWNER, audit)).sentimentEnabled).toBe(true);
    expect(await readSentimentEnabled(db)).toBe(true);
    expect(await getKv(db, 'rebuild_requested')).toBe(NOW);
    await store.set('sentimentEnabled', false, OWNER, audit);
    expect(await readSentimentEnabled(db)).toBe(false);
    expect(audits.map((a) => a.detail)).toEqual(['Sentiment analysis switched on', 'Sentiment analysis switched off']);
  });

  it('changes nothing for a value already saved, and does save the default once it is chosen on purpose', async () => {
    const { store, audits, audit } = await setup();
    await store.set('sentimentEnabled', false, OWNER, audit);
    await store.set('sentimentEnabled', false, OWNER, audit);
    expect(audits).toHaveLength(1);
    expect((await store.view()).source.sentimentEnabled).toBe('dashboard');
  });

  it('refuses unknown keys and bad values, naming the level and place but never the keyword, and saves nothing', async () => {
    const { db, store, audit, audits } = await setup();
    expect((await refusal(() => store.set('apiKey', 'x', OWNER, audit))).status).toBe(422);
    expect((await refusal(() => store.set('sentimentEnabled', 'yes', OWNER, audit))).message).toBe('sentimentEnabled must be true or false');
    const long = 'x'.repeat(KEYWORD_MAX_CHARS + 1);
    const cases: [unknown, string][] = [
      [null, 'Send the keywords as four lists: critical, major, medium and low'],
      [[], 'Send the keywords as four lists: critical, major, medium and low'],
      [{ critical: [], major: [], medium: [] }, 'Send the keywords as four lists: critical, major, medium and low'],
      [{ ...EMPTY, extra: [] }, 'Send the keywords as four lists: critical, major, medium and low'],
      [{ ...EMPTY, major: 'urgent' }, 'Major keywords must be a list'],
      [{ ...EMPTY, low: ['ok', 7] }, 'Low keyword 2 must be text'],
      [{ ...EMPTY, critical: [long] }, `Critical keyword 1 is longer than ${KEYWORD_MAX_CHARS} characters`],
      [{ ...EMPTY, critical: ['a‮b'] }, 'Critical keyword 1 has a hidden or control character'],
      [{ ...EMPTY, critical: ['!!!'] }, 'Critical keyword 1 needs at least one letter or number'],
      [{ ...EMPTY, critical: ['Urgent'], major: ['ok', 'urgent'] }, 'Major keyword 2 is already in Critical: keep each keyword in one list'],
      [{ ...EMPTY, medium: Array.from({ length: KEYWORDS_PER_LEVEL + 1 }, (_, i) => `k${i}`) }, `Medium can have at most ${KEYWORDS_PER_LEVEL} keywords`],
    ];
    for (const [value, message] of cases) {
      const e = await refusal(() => store.set('priorityKeywords', value, OWNER, audit));
      expect(e.status).toBe(422);
      expect(e.message).toBe(message);
    }
    expect(audits).toEqual([]);
    expect(rows(db)).toEqual([]);
  });

  it('counts repeats once toward the limit', () => {
    expect(checkKeywords({ ...EMPTY, low: Array.from({ length: KEYWORDS_PER_LEVEL + 5 }, (_, i) => (i < KEYWORDS_PER_LEVEL ? `k${i}` : 'k0')) }).low)
      .toHaveLength(KEYWORDS_PER_LEVEL);
  });

  it('falls back to the defaults when a stored row is damaged', async () => {
    const { db, store } = await setup();
    rawOf(db).prepare("INSERT INTO settings (k, v, updated_at, updated_by) VALUES ('priorityKeywords', '{\"critical\":5}', ?, 'x'), ('sentimentEnabled', 'nope', ?, 'x')").run(NOW, NOW);
    await store.load(); // written behind the store's back: it reads them again
    expect(store.get()).toEqual({ keywords: DEFAULT_KEYWORDS, sentimentEnabled: false });
    expect((await store.view()).source).toEqual({ priorityKeywords: 'default', sentimentEnabled: 'default' });
  });

  it('writes nothing when the audit row cannot be written', async () => {
    const { db, store } = await setup();
    await expect(store.set('sentimentEnabled', true, OWNER, () => { throw new Error('disk full'); })).rejects.toThrow('disk full');
    expect(rows(db)).toEqual([]);
    expect(await readSentimentEnabled(db)).toBe(false);
  });
});
