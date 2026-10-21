import type { HealthSnapshot } from '../health/health.ts';
import type { BatchSummary } from '../store/batches.ts';
import type { ClientRow } from '../store/clients.ts';
import { istShortDate, istTime } from '../util/time.ts';

const STALE_MS = 2 * 60_000;

const stamp = (iso: string) => `${istShortDate(new Date(iso))} ${istTime(new Date(iso))}`;

export function formatStatus(i: {
  snapshot: HealthSnapshot | undefined;
  clients: ClientRow[];
  batches: BatchSummary[];
  unprocessed: Map<number, number>;
  now: Date;
}): string {
  const lines: string[] = [];
  const s = i.snapshot;
  // The last snapshot can still say "Connected" after the service has stopped.
  if (s && i.now.getTime() - new Date(s.at).getTime() > STALE_MS) {
    lines.push(`⚠️ The service has not reported since ${stamp(s.at)}. Is it running?`);
  }
  lines.push(`WA Agent status (${stamp(i.now.toISOString())} IST)`);
  if (!s) {
    lines.push('Health:      no report yet (is the service running?)');
  } else {
    const ageMin = Math.round((i.now.getTime() - new Date(s.at).getTime()) / 60_000);
    lines.push(`Health:      ${s.line.text} (reported ${ageMin} min ago)`);
    lines.push(`WhatsApp:    ${s.whatsapp.state} since ${stamp(s.whatsapp.since)}`);
    if (s.publishFailingSince) lines.push(`Drive:       failing since ${stamp(s.publishFailingSince)}`);
    lines.push(`Spend today: $${s.spentToday.toFixed(2)} of $${s.capUsd.toFixed(2)}`);
    lines.push(`Disk free:   ${s.freeGb === null ? 'unknown' : `${s.freeGb.toFixed(1)} GB`}`);
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
