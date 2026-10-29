import type { SpendGuard } from '../spend/spendGuard.ts';
import type { Db } from '../store/db.ts';
import { fromIstDate, istDate } from '../util/time.ts';

// The dashboard's AI usage screen (D5 Task 2). Days are IST, as the spend table and the daily cap count them. The cap
// itself is read from the running SpendGuard: it stays a .env value. Amounts are rounded to a hundredth of a cent.

export const USAGE_DAYS = 14;

export interface UsageSummary {
  today: { spent: number; byKind: { ai: number; stt: number }; capUsd: number; remaining: number; paused: boolean };
  /** The last 14 IST days, oldest first, today last; a day without spend is 0. */
  days: { day: string; usd: number }[];
  /** Today's spend by what it paid for. */
  byUse: { use: 'messages' | 'meetings' | 'files' | 'speech' | 'voice' | 'assistant' | 'other'; label: string; usd: number }[];
  /** Today's finished batches and the messages they read. */
  batches: { today: number; messagesRead: number };
}

const round = (usd: number) => Math.round(usd * 10_000) / 10_000;

/** "YYYY-MM-DD" minus n days (calendar dates, no time zone involved). */
function minusDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * What each spend row paid for, from its detail. The callers write fixed labels: "batch <id>" (messages read into
 * tasks), "meeting <id>" (a meeting's summary and tracker update), "media <id>" (a shared file read), and speech to text
 * books as kind stt, and "assistant <n> calls" the dashboard assistant's answers. Anything else (a call still running at shutdown, booked at its estimate) is other.
 */
const USE_SQL = `CASE WHEN kind = 'stt' THEN 'speech' WHEN detail LIKE 'batch %' THEN 'messages' WHEN detail LIKE 'meeting %' THEN 'meetings'
  WHEN detail LIKE 'media %' THEN 'files' WHEN detail LIKE 'assistant %' THEN 'assistant' ELSE 'other' END`;

const USE_LABELS = {
  messages: 'Messages to tasks', meetings: 'Meeting summaries', files: 'Reading shared files', speech: 'Speech to text',
  voice: 'Voice notes (on this computer)', assistant: 'Dashboard assistant', other: 'Other',
} as const;

/**
 * The AI usage screen. voiceLocal: voice notes are transcribed on the Mac (VOICE_STT_PROVIDER=local), so they are shown
 * as a line at $0.
 */
export function usageSummary(
  db: Db,
  spend: Pick<SpendGuard, 'spentToday' | 'spentTodayByKind' | 'capUsd' | 'isPaused'>,
  now: Date,
  o: { voiceLocal: boolean },
): UsageSummary {
  const today = istDate(now);
  const first = minusDays(today, USAGE_DAYS - 1);
  const totals = new Map(
    (db.raw.prepare('SELECT day, SUM(usd) AS usd FROM spend WHERE day BETWEEN ? AND ? GROUP BY day').all(first, today) as { day: string; usd: number }[])
      .map((r) => [r.day, r.usd]),
  );
  const days = Array.from({ length: USAGE_DAYS }, (_, i) => {
    const day = minusDays(today, USAGE_DAYS - 1 - i);
    return { day, usd: round(totals.get(day) ?? 0) };
  });

  const uses = new Map(
    (db.raw.prepare(`SELECT ${USE_SQL} AS use, SUM(usd) AS usd FROM spend WHERE day = ? GROUP BY 1`).all(today) as { use: string; usd: number }[])
      .map((r) => [r.use, r.usd]),
  );
  const byUse: UsageSummary['byUse'] = [];
  for (const use of ['messages', 'meetings', 'files', 'speech', 'voice', 'assistant', 'other'] as const) {
    if (use === 'voice') {
      if (o.voiceLocal) byUse.push({ use, label: USE_LABELS.voice, usd: 0 });
      continue;
    }
    // The four uses the agent always has are listed even at $0; the assistant and other only when something was booked.
    if ((use === 'other' || use === 'assistant') && !uses.has(use)) continue;
    byUse.push({ use, label: USE_LABELS[use], usd: round(uses.get(use) ?? 0) });
  }

  const from = fromIstDate(today);
  const to = new Date(from.getTime() + 86_400_000);
  const b = db
    .raw.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(message_count), 0) AS messages FROM batches WHERE status = 'ok' AND finished_at >= ? AND finished_at < ?")
    .get(from.toISOString(), to.toISOString()) as { n: number; messages: number };

  const spent = spend.spentToday();
  const byKind = spend.spentTodayByKind();
  return {
    today: {
      spent: round(spent), byKind: { ai: round(byKind.ai), stt: round(byKind.stt) }, capUsd: spend.capUsd,
      remaining: round(Math.max(0, spend.capUsd - spent)), paused: spend.isPaused(),
    },
    days,
    byUse,
    batches: { today: b.n, messagesRead: b.messages },
  };
}
