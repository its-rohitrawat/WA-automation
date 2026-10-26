import type { HealthSnapshot } from '../health/health.ts';
import type { BatchSummary } from '../store/batches.ts';
import type { ClientRow } from '../store/clients.ts';
import { istShortDate, istTime } from '../util/time.ts';

const STALE_MS = 2 * 60_000;

function ageText(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min <= 120) return `${min} min ago`;
  if (ms <= 48 * 3_600_000) return `${Math.round(ms / 3_600_000)} hours ago`;
  return `${Math.round(ms / 86_400_000)} days ago`;
}

const stamp = (iso: string) => `${istShortDate(new Date(iso))} ${istTime(new Date(iso))}`;

export function formatStatus(i: {
  snapshot: HealthSnapshot | undefined;
  clients: ClientRow[];
  batches: BatchSummary[];
  unprocessed: Map<number, number>;
  now: Date;
  /** Speech-to-text copies the agent gave up deleting at the provider (sttForgetsGivenUp); missing or 0: no line. */
  sttCopiesLeft?: number;
  /** Voice-note speech-to-text copies the agent gave up deleting at the provider (mediaSttForgetsGivenUp); missing or 0: no line. */
  voiceCopiesLeft?: number;
}): string {
  const lines: string[] = [];
  const s = i.snapshot;
  // The last snapshot can still say "Connected" after the service has stopped.
  const ageMs = s ? i.now.getTime() - new Date(s.at).getTime() : 0;
  const stale = s !== undefined && ageMs > STALE_MS;
  const lk = stale ? 'last known: ' : '';
  if (s && stale) {
    lines.push(`⚠️ The service has not reported since ${stamp(s.at)}. Is it running?`);
  }
  lines.push(`WA Agent status (${stamp(i.now.toISOString())} IST)`);
  if (!s) {
    lines.push('Health:      no report yet (is the service running?)');
  } else {
    lines.push(`Health:      ${s.line.text} (reported ${ageText(ageMs)})`);
    lines.push(`WhatsApp:    ${lk}${s.whatsapp.state} since ${stamp(s.whatsapp.since)}`);
    if (s.publishFailingSince) lines.push(`Drive:       failing since ${stamp(s.publishFailingSince)}`);
    if (s.ingestFailures > 0) lines.push(`Messages not saved: ${s.ingestFailures} (see wa-agent.out.log)`);
    if (s.media) {
      // Missing in snapshots written before Phase 2b.
      const refused = s.media.sttRefused ?? 0;
      // "including": these are part of the files waiting, not more of them.
      const voice = refused > 0 ? ` · including ${refused} voice note${refused === 1 ? '' : 's'} waiting (speech key refused)` : '';
      lines.push(`Files:       ${s.media.pending} waiting to be read · ${s.media.failedRecent} could not be read (24 h) · ${s.media.uploadFailed} not uploaded to Drive${voice}`);
    }
    if (s.meetings) {
      const m = s.meetings.stats;
      const extra = `${m.noAccess > 0 ? `, ${m.noAccess} no access` : ''}${m.tooLong > 0 ? `, ${m.tooLong} too long` : ''}`;
      lines.push(`Meetings:    ${m.done} done, ${m.waiting} waiting, ${m.unassigned} unassigned, ${m.failed} failed${extra}`);
    }
    // The split is shown with meetings, where speech-to-text spend matters, and once voice notes have cost speech spend.
    const split = s.spendByKind && (s.meetings || s.spendByKind.stt > 0) ? ` (AI $${s.spendByKind.ai.toFixed(2)}, speech $${s.spendByKind.stt.toFixed(2)})` : '';
    lines.push(`Spend today: ${lk}$${s.spentToday.toFixed(2)} of $${s.capUsd.toFixed(2)}${split}`);
    lines.push(`Disk free:   ${s.freeGb === null ? 'unknown' : `${s.freeGb.toFixed(1)} GB`}`);
  }
  // Read from the database, not the service's report: shown even when the service is stopped. Not on the health line.
  const left = i.sttCopiesLeft ?? 0;
  if (left > 0) {
    lines.push(`Speech copies: ${left} speech-to-text ${left === 1 ? 'copy' : 'copies'} could not be deleted from the provider; see SETUP (Meeting summaries)`);
  }
  const voiceLeft = i.voiceCopiesLeft ?? 0;
  if (voiceLeft > 0) {
    lines.push(
      `Voice copies: ${voiceLeft} speech-to-text ${voiceLeft === 1 ? 'copy' : 'copies'} of voice notes could not be deleted from the provider; see SETUP (Voice notes)`,
    );
  }
  lines.push('Clients:');
  const batches = new Map(i.batches.map((b) => [b.clientId, b]));
  for (const c of i.clients) {
    const b = batches.get(c.id);
    const last = !b ? 'no batches yet' : b.status === 'failed' ? `last batch failed (${b.errorCode ?? 'unknown'})` : `last batch ${b.status}`;
    const name = `${c.name}${c.active ? '' : ' (inactive)'}`;
    lines.push(`  ${c.code.padEnd(5)}${name.padEnd(28)}queued ${String(i.unprocessed.get(c.id) ?? 0).padEnd(5)}${last}`);
  }
  return lines.join('\n');
}
