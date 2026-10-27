import { closeTask, CorrectionError, editTask, reopenTask, unlockTask, type EditOptions } from '../cli/corrections.ts';
import { tx, type Db } from '../store/db.ts';
import { CATEGORIES, getTaskByCode, PRIORITIES, SIDES, TASK_FIELDS, type TaskField } from '../store/tasks.ts';
import { isIsoDate } from '../util/time.ts';
import { ControlError, type Audit } from './errors.ts';
import { FIELD_WORDS, taskDetail, type DashboardTaskDetail } from './taskQueries.ts';

// The Tasks screen's changes (D4 Task 2). Each one is the CLI's own correction (src/cli/corrections.ts), run in-process:
// it records the human event and requests the tracker rebuild exactly as `task done|reopen|unlock|edit` does. The audit
// line names the task code and field names only, never a value, which can be words from the chat.

export const TASK_ACTIONS = ['done', 'reopen', 'unlock', 'edit'] as const;
export type TaskAction = (typeof TASK_ACTIONS)[number];

/** The fields the dashboard may edit. askedBy is left to the CLI, as the plan's form does not offer it. */
export const EDITABLE_FIELDS = ['title', 'assignedTo', 'deadline', 'priority', 'side', 'category', 'latestProgress'] as const;
type EditableField = (typeof EDITABLE_FIELDS)[number];

const MAX_CHARS: Record<'title' | 'assignedTo' | 'latestProgress', number> = { title: 200, assignedTo: 100, latestProgress: 1000 };
const CHOICES: Record<'priority' | 'side' | 'category', readonly string[]> = { priority: PRIORITIES, side: SIDES, category: CATEGORIES };

const invalid = (field: string, message: string) => new ControlError(422, message, field);

/**
 * Checks an edit body as `task edit` checks its options, and returns what editTask takes: '' clears an optional field.
 * Throws ControlError (422) naming the field.
 */
export function parseTaskEdit(body: unknown): EditOptions {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw invalid('body', 'Send the fields to change as a JSON object');
  const entries = Object.entries(body as Record<string, unknown>);
  if (entries.length === 0) throw invalid('body', 'Nothing to change');
  const out: EditOptions = {};
  for (const [key, raw] of entries) {
    // The key is request input: it is named back only when it is a short plain word, and never in the message.
    if (!(EDITABLE_FIELDS as readonly string[]).includes(key)) throw invalid(/^[A-Za-z]{1,30}$/.test(key) ? key : 'body', 'That field cannot be changed here');
    const field = key as EditableField;
    if (field === 'priority' || field === 'side' || field === 'category') {
      const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
      if (!CHOICES[field].includes(v)) throw invalid(field, `${field} must be one of: ${CHOICES[field].join(', ')}`);
      out[field] = v;
      continue;
    }
    if (raw !== null && typeof raw !== 'string') throw invalid(field, `${field} must be text`);
    const v = (raw ?? '').trim();
    if (field === 'deadline') {
      if (v !== '' && !isIsoDate(v)) throw invalid(field, 'deadline must be a real date, YYYY-MM-DD, or empty');
    } else {
      if (field === 'title' && v === '') throw invalid(field, 'title cannot be empty');
      // editTask reads "none" (any case) as "clear it", so a typed "None" would be lost without a word. Empty clears.
      if (v.toLowerCase() === 'none') throw invalid(field, `${field} cannot be the word none; leave it empty to clear it`);
      if (v.length > MAX_CHARS[field]) throw invalid(field, `${field} must be at most ${MAX_CHARS[field]} characters`);
    }
    out[field] = v;
  }
  return out;
}

/** A CorrectionError in the dashboard's terms: a status the task already has is 409, any other refusal of a value 422. */
function fromCorrection(e: CorrectionError): ControlError {
  if (/^Task \S+ is already /.test(e.message)) return new ControlError(409, e.message);
  const field = TASK_FIELDS.find((f) => e.message.startsWith(`${f} `));
  return new ControlError(422, e.message, field);
}

function changedWords(opts: EditOptions): string {
  return TASK_FIELDS.filter((f: TaskField) => opts[f] !== undefined).map((f) => FIELD_WORDS[f]).join(', ');
}

/**
 * Runs one task action and returns the fresh detail. The change and its audit line are one transaction: if the audit
 * cannot be written, nothing changes. Throws ControlError: 400 an unknown action, 404 no such task, 409 the task already
 * has that status, 422 an invalid edit.
 */
export function runTaskAction(
  db: Db,
  req: { code: string; action: string; body?: unknown },
  ctx: { actor: string; now: Date; audit: Audit },
): DashboardTaskDetail {
  if (!(TASK_ACTIONS as readonly string[]).includes(req.action)) throw new ControlError(400, `action must be one of: ${TASK_ACTIONS.join(', ')}`, 'action');
  const action = req.action as TaskAction;
  const raw = req.code.trim().toUpperCase();
  const known = /^[A-Z]{3,4}-\d{1,9}$/.test(raw);
  const task = known ? getTaskByCode(db, raw) : undefined;
  if (!task) throw new ControlError(404, known ? `No task called ${raw}` : 'No task with that code');
  const code = task.code;
  const edit = action === 'edit' ? parseTaskEdit(req.body) : undefined;
  const { now } = ctx;
  try {
    tx(db, () => {
      let line: string;
      switch (action) {
        case 'done':
          closeTask(db, code, now);
          line = `Task ${code} marked done`;
          break;
        case 'reopen':
          reopenTask(db, code, now);
          line = `Task ${code} reopened`;
          break;
        case 'unlock':
          unlockTask(db, code, now);
          line = `Task ${code} handed back to the agent`;
          break;
        case 'edit':
          editTask(db, code, edit!, now);
          line = `Task ${code} edited (${changedWords(edit!)})`;
          break;
      }
      ctx.audit({ actor: ctx.actor, event: `task.${action}`, kind: 'task', detail: line });
    });
  } catch (e) {
    if (e instanceof CorrectionError) throw fromCorrection(e);
    throw e;
  }
  return taskDetail(db, code, now)!;
}
