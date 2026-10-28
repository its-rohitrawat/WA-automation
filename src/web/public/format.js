// Dates and amounts as the owner reads them: India time, short and plain.

const IST = 'Asia/Kolkata';

/** @param {string | null | undefined} iso */
const parse = (iso) => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t);
};

/** "40 s ago", "12 min ago", "3 h ago", "Yesterday", "Mon 16:30", "21 Oct". @param {string | null | undefined} iso @param {Date} [now] */
export function ago(iso, now = new Date()) {
  const d = parse(iso);
  if (!d) return '—';
  const s = Math.max(0, Math.round((now.getTime() - d.getTime()) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 6 * 3600) return `${Math.round(s / 3600)} h ago`;
  return when(iso, now);
}

/** "Today 11:00", "Yesterday 18:40", "Mon 16:30" (this week), else "21 Oct 09:12". @param {string | null | undefined} iso @param {Date} [now] */
export function when(iso, now = new Date()) {
  const d = parse(iso);
  if (!d) return '—';
  const day = (x) => x.toLocaleDateString('en-CA', { timeZone: IST });
  const time = d.toLocaleTimeString('en-GB', { timeZone: IST, hour: '2-digit', minute: '2-digit' });
  const days = Math.round((Date.parse(day(now)) - Date.parse(day(d))) / 86_400_000);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  if (days > 1 && days < 7) return `${d.toLocaleDateString('en-GB', { timeZone: IST, weekday: 'short' })} ${time}`;
  return `${d.toLocaleDateString('en-GB', { timeZone: IST, day: 'numeric', month: 'short' })} ${time}`;
}

/** "28 Oct 2026" in India time. @param {string | null | undefined} iso */
export function date(iso) {
  const d = parse(iso);
  return d ? d.toLocaleDateString('en-GB', { timeZone: IST, day: 'numeric', month: 'short', year: 'numeric' }) : '—';
}

/** "11:55" in India time. @param {string | null | undefined} iso */
export function clock(iso) {
  const d = parse(iso);
  return d ? d.toLocaleTimeString('en-GB', { timeZone: IST, hour: '2-digit', minute: '2-digit' }) : '—';
}

/** "Tuesday 27 October". @param {Date} [now] */
export function today(now = new Date()) {
  return now.toLocaleDateString('en-GB', { timeZone: IST, weekday: 'long', day: 'numeric', month: 'long' });
}

/** "Good morning" / "Good afternoon" / "Good evening" in India time. @param {Date} [now] */
export function greeting(now = new Date()) {
  const h = Number(now.toLocaleTimeString('en-GB', { timeZone: IST, hour: '2-digit', hour12: false }));
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

/** "$2.37". @param {number | null | undefined} n */
export const usd = (n) => (typeof n === 'number' && Number.isFinite(n) ? `$${n.toFixed(2)}` : '—');

/** "RS" from "Rohit Solution Bowl", or from the email. @param {string} name @param {string} email */
export function initials(name, email) {
  const words = (name || '').trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (email || '?').slice(0, 2).toUpperCase();
}
