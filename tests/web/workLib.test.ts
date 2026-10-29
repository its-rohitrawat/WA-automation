import { describe, expect, it } from 'vitest';
// The screens' pure helpers are a browser module; their JSDoc types are checked by tsconfig.web.json, so the import is untyped here.
// @ts-expect-error -- browser module (see above)
import { auditPill, deadlineText, groupByIstDay, meetingPill, numbersMatch, readList, sourceLabel, taskPill, taskQueryFromSearch, taskQueryToSearch, usageChart } from '../../src/web/public/views/workLib.js';

describe('task filters in the URL', () => {
  it('reads only allowed values, with the defaults left out', () => {
    expect(taskQueryFromSearch('?q=logo&client=sha&status=overdue&owner=Rahul&deadline=week&priority=high&sort=client&dir=desc')).toEqual({
      q: 'logo', client: 'SHA', status: 'overdue', owner: 'Rahul', deadline: 'week', priority: 'high', sort: 'client', dir: 'desc',
    });
    expect(taskQueryFromSearch('?status=late&deadline=soon&priority=urgent&sort=title&dir=up&client=sh1')).toEqual({ sort: 'deadline', dir: 'asc' });
    expect(taskQueryFromSearch('')).toEqual({ sort: 'deadline', dir: 'asc' });
  });

  it('writes the query back, leaving out empty values and the default sort', () => {
    expect(taskQueryToSearch({ q: '50% off', status: 'open', sort: 'deadline', dir: 'asc' })).toBe('?q=50%25+off&status=open');
    expect(taskQueryToSearch({ sort: 'owner', dir: 'desc' })).toBe('?sort=owner&dir=desc');
    expect(taskQueryToSearch({ sort: 'deadline', dir: 'asc' })).toBe('');
  });

  it('round-trips', () => {
    const q = { q: 'a&b=c', client: 'MEH', owner: 'Priya', sort: 'status', dir: 'desc' };
    expect(taskQueryFromSearch(taskQueryToSearch(q))).toEqual(q);
  });

  it('keeps the Overview\'s closed=7d filter, and drops any other closed value', () => {
    expect(taskQueryFromSearch('?status=done&closed=7d')).toEqual({ status: 'done', closed: '7d', sort: 'deadline', dir: 'asc' });
    expect(taskQueryToSearch({ status: 'done', closed: '7d', sort: 'deadline', dir: 'asc' })).toBe('?status=done&closed=7d');
    expect(taskQueryFromSearch('?closed=30d').closed).toBeUndefined();
    expect(taskQueryFromSearch('?removed=1').removed).toBe('1');
    expect(taskQueryFromSearch('?removed=yes').removed).toBeUndefined();
  });

  it('reads a single list value from the URL against its allowed set', () => {
    expect(readList('?view=ready', 'view', ['all', 'ready'], 'all')).toBe('ready');
    expect(readList('?view=<x>', 'view', ['all', 'ready'], 'all')).toBe('all');
    expect(readList('', 'kind', ['all', 'auth'], 'all')).toBe('all');
  });
});

describe('labels', () => {
  it('names task statuses with their colour class, never by colour alone', () => {
    expect(taskPill('overdue')).toEqual({ cls: 'p-overdue', label: 'Overdue' });
    expect(taskPill('open')).toEqual({ cls: 'p-open', label: 'Open' });
    expect(taskPill('review')).toEqual({ cls: 'p-review', label: 'Needs review' });
    expect(taskPill('done')).toEqual({ cls: 'p-done', label: 'Done' });
    expect(taskPill('x')).toEqual({ cls: 'p-muted', label: 'Unknown' });
  });

  it('names sources and meeting statuses', () => {
    expect(sourceLabel('voice')).toEqual({ icon: 'mic', label: 'Voice note' });
    expect(sourceLabel('meeting')).toEqual({ icon: 'video', label: 'Meeting' });
    expect(sourceLabel('other')).toEqual({ icon: 'bubble', label: 'WhatsApp' });
    expect(meetingPill('done').cls).toBe('p-done');
    expect(meetingPill('unassigned')).toEqual({ cls: 'p-warn', label: 'Needs a client' });
    expect(meetingPill('failed').cls).toBe('p-overdue');
    expect(meetingPill('queued').cls).toBe('p-open');
  });

  it('marks problems and changes in the audit log', () => {
    expect(auditPill({ kind: 'auth', event: 'auth.refused' }).cls).toBe('p-overdue');
    expect(auditPill({ kind: 'ops', event: 'tracker.publish_failed' }).cls).toBe('p-overdue');
    expect(auditPill({ kind: 'config', event: 'settings.reportDays' }).cls).toBe('p-review');
    expect(auditPill({ kind: 'task', event: 'task.done' }).cls).toBe('p-muted');
  });

  it('writes a deadline as a short date', () => {
    expect(deadlineText('2026-10-30')).toBe('30 Oct');
    expect(deadlineText(null)).toBe('No deadline');
    expect(deadlineText('not a date')).toBe('No deadline');
  });
});

describe('usageChart', () => {
  const days = [{ day: '2026-10-25', usd: 2 }, { day: '2026-10-26', usd: 0 }, { day: '2026-10-27', usd: 7.5 }];

  it('scales bars to the higher of the biggest day and the cap, marks today, and places the cap line', () => {
    const c = usageChart(days, 10);
    expect(c.bars.map((b: { label: string; pct: number; today: boolean }) => [b.label, b.pct, b.today])).toEqual([['25', 20, false], ['26', 0, false], ['27', 75, true]]);
    expect(c.capPct).toBe(100);
    expect(c.bars[2]!.tip).toBe('27 Oct · $7.50');
  });

  it('a day over the cap sets the scale, and the cap line sits below the top', () => {
    const c = usageChart([{ day: '2026-10-27', usd: 20 }], 10);
    expect(c.bars[0]!.pct).toBe(100);
    expect(c.capPct).toBe(50);
  });

  it('gives the hidden table rows for screen readers, and copes with no data and no cap', () => {
    expect(usageChart(days, 10).rows).toEqual([['25 Oct', '$2.00'], ['26 Oct', '$0.00'], ['27 Oct', '$7.50']]);
    expect(usageChart([], 0)).toEqual({ bars: [], capPct: null, rows: [] });
  });
});

describe('groupByIstDay', () => {
  it('groups newest first by India date, naming today and yesterday', () => {
    const now = new Date('2026-10-27T10:00:00.000Z'); // 15:30 IST on Tuesday 27 Oct
    const items = [
      { id: 'a', at: '2026-10-27T09:00:00.000Z' },
      { id: 'b', at: '2026-10-26T19:00:00.000Z' }, // 00:30 IST on the 27th: today
      { id: 'c', at: '2026-10-26T18:00:00.000Z' }, // 23:30 IST on the 26th
      { id: 'd', at: '2026-10-20T05:00:00.000Z' },
    ];
    expect(groupByIstDay(items, now).map((g: { label: string; items: { id: string }[] }) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ['Today · Tuesday 27 October', ['a', 'b']],
      ['Yesterday · Monday 26 October', ['c']],
      ['Tuesday 20 October', ['d']],
    ]);
  });
});

describe('numbersMatch', () => {
  it('needs the same Indian mobile number typed twice', () => {
    expect(numbersMatch('+91 98123 45678', '919812345678')).toBe(true);
    expect(numbersMatch('919812345678', '919812345679')).toBe(false);
    expect(numbersMatch('9812345678', '9812345678')).toBe(false); // 91 first
    expect(numbersMatch('', '')).toBe(false);
  });
});
