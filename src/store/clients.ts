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
export async function syncClients(db: Db, configs: ClientConfig[], now: Date = new Date()): Promise<string[]> {
  // queueBackfill writes kv, on raw until kv is converted (later in S1.12), which is allowed inside this transaction.
  return db.tx(async (q) => {
    for (const c of configs) {
      const existing = await q.get<{ code: string; name: string }>('SELECT code, name FROM clients WHERE group_id = ?', [c.groupId]);
      if (existing && existing.code !== c.code) {
        throw new Error(`Client codes are permanent because task IDs use them. Keep code ${existing.code} for ${c.name}.`);
      }
      const other = await q.get<{ name: string; group_id: string }>('SELECT name, group_id FROM clients WHERE code = ?', [c.code]);
      if (other && other.group_id !== c.groupId) {
        throw new Error(`Code ${c.code} is already used by ${other.name}. Pick a different code.`);
      }
    }
    const wasActive = new Set((await q.all<{ group_id: string }>('SELECT group_id FROM clients WHERE active = 1')).map((r) => r.group_id));
    await q.run('UPDATE clients SET active = 0');
    for (const c of configs) {
      await q.run(
        `INSERT INTO clients (code, name, group_id, phases, active) VALUES (@code, @name, @groupId, @phases, 1)
    ON CONFLICT (group_id) DO UPDATE SET code = excluded.code, name = excluded.name, phases = excluded.phases, active = 1`,
        { code: c.code, name: c.name, groupId: c.groupId, phases: JSON.stringify(c.phases) },
      );
    }
    const approved = configs.map((c) => c.groupId).filter((g) => !wasActive.has(g));
    for (const groupId of approved) {
      const { id } = (await q.get<{ id: number }>('SELECT id FROM clients WHERE group_id = ?', [groupId]))!;
      queueBackfill(db, groupId, id, now);
    }
    return approved;
  });
}

export async function getClient(db: Sql, id: number): Promise<ClientRow> {
  const r = await db.get<RawClient>('SELECT * FROM clients WHERE id = ?', [id]);
  if (!r) throw new Error(`Unknown client id ${id}`);
  return toRow(r);
}

export async function getClientByGroupId(db: Sql, groupId: string): Promise<ClientRow | undefined> {
  const r = await db.get<RawClient>('SELECT * FROM clients WHERE group_id = ?', [groupId]);
  return r ? toRow(r) : undefined;
}

export async function getClientByCode(db: Sql, code: string): Promise<ClientRow | undefined> {
  const r = await db.get<RawClient>('SELECT * FROM clients WHERE code = ?', [code]);
  return r ? toRow(r) : undefined;
}

export async function listClients(db: Sql, activeOnly = true): Promise<ClientRow[]> {
  const sql = activeOnly ? 'SELECT * FROM clients WHERE active = 1 ORDER BY name' : 'SELECT * FROM clients ORDER BY name';
  return (await db.all<RawClient>(sql)).map(toRow);
}

export async function nextTaskCode(db: Sql, clientId: number): Promise<string> {
  const r = await db.get<{ code: string; seq: number }>('UPDATE clients SET next_task_seq = next_task_seq + 1 WHERE id = ? RETURNING code, next_task_seq - 1 AS seq', [
    clientId,
  ]);
  if (!r) throw new Error(`Unknown client id ${clientId}`);
  return `${r.code}-${String(r.seq).padStart(3, '0')}`;
}

/** A human-set phase is locked against AI changes until the next human change. */
export async function setPhase(db: Sql, clientId: number, phase: string, by: 'ai' | 'human'): Promise<void> {
  await db.run('UPDATE clients SET current_phase = ?, phase_locked = ? WHERE id = ?', [phase, by === 'human' ? 1 : 0, clientId]);
}

export async function clearPhaseLock(db: Sql, clientId: number): Promise<void> {
  await db.run('UPDATE clients SET phase_locked = 0 WHERE id = ?', [clientId]);
}

export async function setStatus(db: Sql, clientId: number, text: string, at: string): Promise<void> {
  await db.run('UPDATE clients SET status_text = ?, status_updated_at = ? WHERE id = ?', [text, at, clientId]);
}

/** The client's mood in a batch, as the AI judged it (only while sentiment is switched on). */
export async function setClientSentiment(db: Sql, clientId: number, sentiment: Sentiment, at: string): Promise<void> {
  await db.run('UPDATE clients SET sentiment = ?, sentiment_at = ? WHERE id = ?', [sentiment, at, clientId]);
}
