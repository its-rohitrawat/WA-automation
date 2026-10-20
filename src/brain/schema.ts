import { z } from 'zod';

export const OP_NAMES = [
  'add_task',
  'update_task',
  'close_task',
  'mark_maybe_done',
  'log_reminder',
  'add_decision',
  'set_phase',
  'set_status',
  'set_person_role',
] as const;

/** Flat on purpose: fields that do not apply to an operation are null. validator.ts enforces the rest. */
export const AiOpSchema = z.object({
  op: z.enum(OP_NAMES),
  taskCode: z.string().nullable(),
  side: z.enum(['us', 'client']).nullable(),
  title: z.string().nullable(),
  category: z.enum(['design', 'development', 'content', 'payment', 'approval', 'other']).nullable(),
  priority: z.enum(['high', 'medium', 'low']).nullable(),
  assignedTo: z.string().nullable(),
  askedBy: z.string().nullable(),
  deadline: z.string().nullable(),
  latestProgress: z.string().nullable(),
  text: z.string().nullable(),
  phase: z.string().nullable(),
  personJid: z.string().nullable(),
  role: z.enum(['team', 'client']).nullable(),
  sourceMessageIds: z.array(z.string()),
  reason: z.string(),
});

export const AiOutputSchema = z.object({ ops: z.array(AiOpSchema) });

export type AiOp = z.infer<typeof AiOpSchema>;
export type AiOutput = z.infer<typeof AiOutputSchema>;
