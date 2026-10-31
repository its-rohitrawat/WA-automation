import type { AiCallResult, ReconcileOptions } from '../../src/brain/claudeClient.ts';
import { FakeAi } from './ai.ts';

/**
 * A FakeAi for the meeting tracker step. The meeting items' ids carry the meeting's row id (mtg<id>-a1), and a test's
 * scripted answers are written as for meeting 1, its id on SQLite. On Postgres ids are shared by every customer, so in
 * each call about a meeting the answer's "mtg1-" ids are read as that meeting (the id in its <meeting_items>). Other ids
 * are left as written, so a fake one (mtg2-a1, mtg1-a9) is still refused.
 */
export class MeetingAi extends FakeAi {
  override async reconcile(system: string, user: string, opts?: ReconcileOptions): Promise<AiCallResult> {
    const r = await super.reconcile(system, user, opts);
    const id = /^\[mtg(\d+)-[ad]\d+\]/m.exec(user)?.[1];
    if (!id) return r;
    const ops = r.output.ops.map((o) => ({ ...o, sourceMessageIds: o.sourceMessageIds.map((x) => x.replace(/^mtg1-/, `mtg${id}-`)) }));
    return { ...r, output: { ...r.output, ops } };
  }
}
