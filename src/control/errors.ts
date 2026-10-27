/**
 * A refusal the dashboard shows the owner as it is. The message is fixed text with codes, ids, field names and allowed
 * values only: never message text, a token or a raw error. status: what the web layer answers (400 a bad URL parameter,
 * 404 nothing with that code or id, 409 the row is not in a state that allows it, 422 an invalid edit).
 */
export class ControlError extends Error {
  readonly status: 400 | 404 | 409 | 422;
  /** The request field the message is about, for a form to show it beside the input. */
  readonly field: string | undefined;

  constructor(status: 400 | 404 | 409 | 422, message: string, field?: string) {
    super(message);
    this.name = 'ControlError';
    this.status = status;
    this.field = field;
  }
}

/** One entry for the audit log. detail: codes, ids and field names only, never message or meeting text. */
export interface AuditEntry {
  actor: string;
  event: string;
  kind: 'auth' | 'config' | 'connection' | 'task' | 'meeting' | 'ops';
  detail: string;
}

/**
 * Writes one audit row. It must be synchronous and write through the same database connection as the action: the
 * actions call it inside their transaction, so a failed write rolls the change back with it.
 */
export type Audit = (entry: AuditEntry) => void;
