import { z } from 'zod';

export const OP_NAMES = [
  'add_task', 'update_task', 'close_task', 'mark_maybe_done', 'reopen_task', 'log_reminder',
  'add_decision', 'set_phase', 'set_status', 'set_person_role',
] as const;

const SIDE = ['us', 'client'] as const;
const CATEGORY = ['design', 'development', 'content', 'payment', 'approval', 'other'] as const;
const PRIORITY = ['high', 'medium', 'low'] as const;
const INITIAL_STATUS = ['maybe_done', 'done'] as const; // '' = open
const ROLE = ['team', 'client'] as const;

/** What Claude returns. No unions: "" means "not set". */
export const AiWireOpSchema = z.object({
  op: z.enum(OP_NAMES),
  taskCode: z.string(),
  side: z.enum(['', ...SIDE]),
  title: z.string(),
  category: z.enum(['', ...CATEGORY]),
  priority: z.enum(['', ...PRIORITY]),
  assignedTo: z.string(),
  askedBy: z.string(),
  deadline: z.string(),
  latestProgress: z.string(),
  status: z.enum(['', ...INITIAL_STATUS]),
  text: z.string(),
  phase: z.string(),
  personJid: z.string(),
  role: z.enum(['', ...ROLE]),
  sourceMessageIds: z.array(z.string()).min(1),
  reason: z.string(),
});
export const AiWireOutputSchema = z.object({ ops: z.array(AiWireOpSchema) });
export type AiWireOp = z.infer<typeof AiWireOpSchema>;

/** Domain operation used by the validator and reconciler: "" becomes null. */
export interface AiOp {
  op: (typeof OP_NAMES)[number];
  taskCode: string | null;
  side: (typeof SIDE)[number] | null;
  title: string | null;
  category: (typeof CATEGORY)[number] | null;
  priority: (typeof PRIORITY)[number] | null;
  assignedTo: string | null;
  askedBy: string | null;
  deadline: string | null;
  latestProgress: string | null;
  status: (typeof INITIAL_STATUS)[number] | null;
  text: string | null;
  phase: string | null;
  personJid: string | null;
  role: (typeof ROLE)[number] | null;
  sourceMessageIds: string[];
  reason: string;
}
export interface AiOutput { ops: AiOp[] }

const nul = <T extends string>(v: T | ''): T | null => (v === '' ? null : v);

export function toAiOp(w: AiWireOp): AiOp {
  return {
    op: w.op,
    taskCode: nul(w.taskCode.trim()),
    side: nul(w.side),
    title: nul(w.title.trim()),
    category: nul(w.category),
    priority: nul(w.priority),
    assignedTo: nul(w.assignedTo.trim()),
    askedBy: nul(w.askedBy.trim()),
    deadline: nul(w.deadline.trim()),
    latestProgress: nul(w.latestProgress.trim()),
    status: nul(w.status),
    text: nul(w.text.trim()),
    phase: nul(w.phase.trim()),
    personJid: nul(w.personJid.trim()),
    role: nul(w.role),
    sourceMessageIds: w.sourceMessageIds,
    reason: w.reason,
  };
}

/** JSON schema sent as output_config.format.schema. Built by zod so `enum` is kept. */
export const AI_OUTPUT_JSON_SCHEMA: Record<string, unknown> = (() => {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(AiWireOutputSchema) as Record<string, unknown>;
  return schema;
})();

export class AiOutputParseError extends Error {
  constructor() {
    super('Model output was not the expected JSON');
    this.name = 'AiOutputParseError';
  }
}

/** Parses the model's text. Invalid individual ops are dropped and counted, never fatal for the batch. */
export function parseAiOutput(text: string): { output: AiOutput; invalidOps: number } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new AiOutputParseError();
  }
  const ops = (raw as { ops?: unknown } | null)?.ops;
  if (!Array.isArray(ops)) throw new AiOutputParseError();
  const valid: AiOp[] = [];
  let invalidOps = 0;
  for (const candidate of ops) {
    const r = AiWireOpSchema.safeParse(candidate);
    if (r.success) valid.push(toAiOp(r.data));
    else invalidOps++;
  }
  return { output: { ops: valid }, invalidOps };
}
