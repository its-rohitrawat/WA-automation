const TZ = 'Asia/Kolkata';

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(opts);
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...opts });
    formatters.set(key, f);
  }
  return f;
}

function parts(d: Date, opts: Intl.DateTimeFormatOptions): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of formatterFor(opts).formatToParts(d)) out[p.type] = p.value;
  return out;
}

/** "2026-10-19": the calendar date in India. */
export function istDate(d: Date): string {
  const p = parts(d, { year: 'numeric', month: '2-digit', day: '2-digit' });
  return `${p.year}-${p.month}-${p.day}`;
}

/** "19 Oct" */
export function istShortDate(d: Date): string {
  const p = parts(d, { day: 'numeric', month: 'short' });
  return `${p.day} ${p.month}`;
}

/** "14:05" */
export function istTime(d: Date): string {
  const p = parts(d, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return `${p.hour}:${p.minute}`;
}

/** "Monday": the weekday in India. */
export function istWeekday(d: Date): string {
  return parts(d, { weekday: 'long' }).weekday ?? '';
}

/** "2026-10-19 14:05", used in AI prompts. */
export function istDateTime(d: Date): string {
  return `${istDate(d)} ${istTime(d)}`;
}

/** Midnight IST at the start of a "YYYY-MM-DD" date. */
export function fromIstDate(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00+05:30`);
}

/** "18 Oct" from "2026-10-18". */
export function displayDate(isoDate: string): string {
  return istShortDate(fromIstDate(isoDate));
}

/** Whole days from one "YYYY-MM-DD" to another. */
export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
}

/** "10 min", "1 h 02 min", "under 1 min". */
export function meetingLength(seconds: number): string {
  const minutes = Math.round(Number.isFinite(seconds) && seconds > 0 ? seconds / 60 : 0);
  if (minutes === 0) return 'under 1 min';
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}
