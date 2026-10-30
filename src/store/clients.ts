import type { ClientConfig } from '../config/groups.ts';
import type { Db, Sql } from './db.ts';
import { queueBackfill } from './historyBackfill.ts';
import type { Sentiment } from './tasks.ts';

export interface ClientRow {
  id: number;
  code: string;
  name: string;
  groupId: string;
  phases: string[];
  currentPhase: string | null;
  phaseLocked: boolean;
  statusText: string | null;
  statusUpdatedAt: string | null;
  active: boolean;
  /** The client's mood in the latest batch that judged it (sentiment switched on); null when none did. */
  sentiment: Sentiment | null;
  sentimentAt: string | null;
}

interface RawClient {
  id: number;
  code: string;
  name: string;
  group_id: string;
  phases: string;
  current_phase: string | null;
  phase_locked: number;
  status_text: string | null;
  status_updated_at: string | null;
  active: number;
  sentiment: Sentiment | null;
  sentiment_at: string | null;
}

function toRow(r: RawClient): ClientRow {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    groupId: r.group_id,
    phases: JSON.parse(r.phases) as string[],
    currentPhase: r.current_phase,
    phaseLocked: r.phase_locked === 1,
    statusText: r.status_text,
    statusUpdatedAt: r.status_updated_at,
    active: r.active === 1,
    sentiment: r.sentiment,
    sentimentAt: r.sentiment_at,
  };
}

/**
 * Makes the clients table match the config. Removed clients become inactive; nothing is deleted. A group that becomes
 * active here (new, or approved again) gets its last 7 days of messages queued for reading, in the same transaction
 * (src/wa/historyBackfill.ts reads them). Returns those group ids.
 */
export function syncClients(db: Db, configs: ClientConfig[], now: Date = new Date()): string[] {
  const upsert = db.raw.prepare(`
    INSERT INTO clients (code, name, group_id, phases, active) VALUES (@code, @name, @groupId, @phases, 1)
    ON CONFLICT (group_id) DO UPDATE SET code = excluded.code, name = excluded.name, phases = excluded.phases, active = 1`);
  const byGroup = db.raw.prepare('SELECT code, name FROM clients WHERE group_id = ?');
  const byCode = db.raw.prepare('SELECT name, group_id FROM clients WHERE code = ?');
  return db.raw.transaction(() => {
    for (const c of configs) {
      const existing = byGroup.get(c.groupId) as { code: string; name: string } | undefined;
      if (existing && existing.code !== c.code) {
        throw new Error(`Client codes are permanent because task IDs use them. Keep code ${existing.code} for ${c.name}.`);
      }
      const other = byCode.get(c.code) as { name: string; group_id: string } | undefined;
      if (other && other.group_id !== c.groupId) {
        throw new Error(`Code ${c.code} is already used by ${other.name}. Pick a different code.`);
      }
    }
    const wasActive = new Set((db.raw.prepare('SELECT group_id FROM clients WHERE active = 1').all() as { group_id: string }[]).map((r) => r.group_id));
    db.raw.prepare('UPDATE clients SET active = 0').run();
    for (const c of configs) upsert.run({ code: c.code, name: c.name, groupId: c.groupId, phases: JSON.stringify(c.phases) });
    const approved = configs.map((c) => c.groupId).filter((g) => !wasActive.has(g));
    for (const groupId of approved) {
      const { id } = db.raw.prepare('SELECT id FROM clients WHERE group_id = ?').get(groupId) as { id: number };
      queueBackfill(db, groupId, id, now);
    }
    return approved;
  }).immediate();
}

export function getClient(db: Db, id: number): ClientRow {
  const r = db.raw.prepare('SELECT * FROM clients WHERE id = ?').get(id) as RawClient | undefined;
  if (!r) throw new Error(`Unknown client id ${id}`);
  return toRow(r);
}

export function getClientByGroupId(db: Db, groupId: string): ClientRow | undefined {
  const r = db.raw.prepare('SELECT * FROM clients WHERE group_id = ?').get(groupId) as RawClient | undefined;
  return r ? toRow(r) : undefined;
}

export function getClientByCode(db: Db, code: string): ClientRow | undefined {
  const r = db.raw.prepare('SELECT * FROM clients WHERE code = ?').get(code) as RawClient | undefined;
  return r ? toRow(r) : undefined;
}

export function listClients(db: Db, activeOnly = true): ClientRow[] {
  const sql = activeOnly ? 'SELECT * FROM clients WHERE active = 1 ORDER BY name' : 'SELECT * FROM clients ORDER BY name';
  return (db.raw.prepare(sql).all() as RawClient[]).map(toRow);
}

export async function nextTaskCode(db: Sql, clientId: number): Promise<string> {
  const r = await db.get<{ code: string; seq: number }>('UPDATE clients SET next_task_seq = next_task_seq + 1 WHERE id = ? RETURNING code, next_task_seq - 1 AS seq', [
    clientId,
  ]);
  if (!r) throw new Error(`Unknown client id ${clientId}`);
  return `${r.code}-${String(r.seq).padStart(3, '0')}`;
}

/** A human-set phase is locked against AI changes until the next human change. */
export function setPhase(db: Db, clientId: number, phase: string, by: 'ai' | 'human'): void {
  db.raw.prepare('UPDATE clients SET current_phase = ?, phase_locked = ? WHERE id = ?').run(phase, by === 'human' ? 1 : 0, clientId);
}

export function clearPhaseLock(db: Db, clientId: number): void {
  db.raw.prepare('UPDATE clients SET phase_locked = 0 WHERE id = ?').run(clientId);
}

export function setStatus(db: Db, clientId: number, text: string, at: string): void {
  db.raw.prepare('UPDATE clients SET status_text = ?, status_updated_at = ? WHERE id = ?').run(text, at, clientId);
}

/** The client's mood in a batch, as the AI judged it (only while sentiment is switched on). */
export function setClientSentiment(db: Db, clientId: number, sentiment: Sentiment, at: string): void {
  db.raw.prepare('UPDATE clients SET sentiment = ?, sentiment_at = ? WHERE id = ?').run(sentiment, at, clientId);
}
