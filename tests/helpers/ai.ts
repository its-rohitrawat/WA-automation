import type { AiOp } from '../../src/brain/schema.ts';

/** A complete AI operation with every unused field null. */
export function op(p: Partial<AiOp> & Pick<AiOp, 'op' | 'sourceMessageIds'>): AiOp {
  return {
    taskCode: null, side: null, title: null, category: null, priority: null, assignedTo: null, askedBy: null, deadline: null,
    latestProgress: null, text: null, phase: null, personJid: null, role: null, reason: 'test', ...p,
  };
}
