import type { HealthSnapshot } from '../health/health.ts';
import type { Db } from '../store/db.ts';
import type { MeetingStatus } from '../store/meetings.ts';
import { istDate } from '../util/time.ts';
import { listActivity, type ActivityItem } from './activityQueries.ts';
import { listDashboardMeetings } from './meetingQueries.ts';
import { lastTrackerUpload } from './trackerQueries.ts';

// The dashboard's Overview (D1 Task 5): plain parameterised SQL, with the Meetings, Activity and Tracker screens' own
// queries reused, so every screen counts the same way. Counts use the Tasks screen's split, one bucket per task:
// overdue (not done, deadline before today IST), then review (maybe done), then open; done is closed in the last 7 IST
// days. Only active clients (in the allow-list) and their tasks count.

/** The agreed stack order of the per-client bars. */
export const SEGMENT_ORDER = ['overdue', 'open', 'review', 'done'] as const;

export interface Overview {
  clients: number;
  tasks: { open: number; overdue: number; review: number; doneThisWeek: number };
  byClient: { client: { code: string; name: string }; segments: { key: (typeof SEGMENT_ORDER)[number]; count: number }[] }[];
  meetings: { id: number; title: string; status: MeetingStatus; stageLabel: string; when: string; minutes: number | null }[];
  activity: ActivityItem[];
  tracker: { lastPublishedAt: string | null; health: { ok: boolean; text: string } | null };
}

/** "YYYY-MM-DD" minus n days (calendar dates, no time zone involved). */
function minusDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
}

/** The Overview. health: the live snapshot, for the tracker card's line and last upload. */
export async function overview(db: Db, now: Date, health?: Pick<HealthSnapshot, 'line' | 'lastPublishedAt' | 'publishFailingSince'>): Promise<Overview> {
  const today = istDate(now);
  const rows = await db.all<{ code: string; name: string; overdue: number; open: number; review: number; done: number }>(
    `SELECT c.code, c.name,
        COALESCE(SUM(t.status <> 'done' AND t.deadline IS NOT NULL AND t.deadline < @today), 0) AS overdue,
        COALESCE(SUM(t.status = 'open' AND NOT (t.deadline IS NOT NULL AND t.deadline < @today)), 0) AS open,
        COALESCE(SUM(t.status = 'maybe_done' AND NOT (t.deadline IS NOT NULL AND t.deadline < @today)), 0) AS review,
        COALESCE(SUM(t.status = 'done' AND t.closed_on BETWEEN @weekStart AND @today), 0) AS done
      FROM clients c LEFT JOIN tasks t ON t.client_id = c.id
      WHERE c.active = 1
      GROUP BY c.id ORDER BY lower(c.name), c.id`,
    { today, weekStart: minusDays(today, 6) },
  );
  const sum = (k: 'overdue' | 'open' | 'review' | 'done') => rows.reduce((a, r) => a + r[k], 0);
  const meetings = (await listDashboardMeetings(db, { view: 'all', limit: 4, offset: 0 }, now)).rows.map((m) => ({
    id: m.id, title: m.title, status: m.status, stageLabel: m.stageLabel, when: m.when, minutes: m.minutes,
  }));
  return {
    clients: rows.length,
    tasks: { open: sum('open'), overdue: sum('overdue'), review: sum('review'), doneThisWeek: sum('done') },
    byClient: rows.map((r) => ({ client: { code: r.code, name: r.name }, segments: SEGMENT_ORDER.map((key) => ({ key, count: r[key] })) })),
    meetings,
    activity: (await listActivity(db, { kind: 'work', limit: 5 })).items,
    tracker: { lastPublishedAt: await lastTrackerUpload(db, health?.lastPublishedAt), health: health ? { ok: health.line.ok, text: health.line.text } : null },
  };
}
