// A scripted stand-in for Claude, for the dashboard smoke test and the local preview: it never calls the API. It picks a
// short script from the question (open a screen, draft a change, or look at today), streams its words a few at a time,
// and charges a made-up cent per step, so the panel shows streaming, a screen opening, a card and the cost line.
import type { AssistantAi, AssistantBlock, AssistantMessage, AssistantTurn } from '../src/assistant/assistant.ts';

const text = (s: string) => ({ type: 'text', text: s, citations: null }) as AssistantBlock;
const use = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input }) as AssistantBlock;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The question the latest exchange began with. */
function question(messages: AssistantMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'user' || typeof m.content === 'string') continue;
    const words = m.content.flatMap((b) => (b.type === 'text' && !b.text.startsWith('Now:') ? [b.text] : []));
    if (words.length) return words.join(' ').toLowerCase();
  }
  return '';
}

export class ScriptedAssistantAi implements AssistantAi {
  readonly attempts = 1;

  async turn(req: { messages: AssistantMessage[] }, onText: (d: string) => void): Promise<AssistantTurn> {
    const q = question(req.messages);
    const step = req.messages.filter((m) => m.role === 'assistant' && typeof m.content !== 'string').length;
    let blocks: AssistantBlock[];
    if (step === 0) {
      blocks = q.includes('overdue')
        ? [text('Opening the overdue tasks.'), use('s1', 'open_screen', { screen: 'tasks', status: 'overdue' })]
        : q.includes('add') || q.includes('task for')
          ? [text('Here is the task, ready for your Confirm.'), use('s1', 'propose_new_task', { client: 'ACM', title: 'Book the photo shoot', deadline: '2026-11-06', priority: 'high' })]
          : [use('s1', 'get_overview', {})];
    } else {
      blocks = [text(q.includes('overdue')
        ? 'Two tasks are past their deadline: ACM-001 "Send the revised quote" and MEH-002 "Share moodboard v2". Both are with Rohit.'
        : q.includes('add') || q.includes('task for')
          ? 'Nothing is added until you press **Confirm**.'
          : 'Today at a glance:\n- **11 open tasks**, 2 of them overdue (ACM-001, MEH-002).\n- One meeting summary is ready: Weekly sync.\n- AI spend is $0.42 of the $3.00 daily cap.\nThe one thing that needs you: the meetings account for org2 needs signing in again.')];
    }
    for (const b of blocks) {
      if (b.type !== 'text') continue;
      for (const piece of b.text.match(/\S+\s*/g) ?? []) {
        onText(piece);
        await sleep(12);
      }
    }
    const tool = blocks.some((b) => b.type === 'tool_use');
    return { content: blocks, stopReason: tool ? 'tool_use' : 'end_turn', costUsd: 0.012, fallbackUsed: false };
  }
}
