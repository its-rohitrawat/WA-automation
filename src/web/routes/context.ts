// What the dashboard's route handlers (D2/D3) take and give, before they are mounted in the router (stage 2). Each
// handler is a plain function: D1's owner guard has already checked the session (and, for a POST, the Origin and the
// CSRF token) and hands over who is asking. Handlers return the status and JSON body; the mounting code sends them.

/** An owner request that D1's guard has let through. */
export interface OwnerContext {
  /** The signed-in owner's email, for the audit log only. */
  actor: string;
  /** The owner's session (its hash in web_sessions), so a pending sign-in or a QR stream belongs to one browser. */
  sessionId: string;
  /** 12 hex characters: ties the audit line to the request log. */
  requestId: string;
}

export interface ApiResult<T = unknown> {
  status: number;
  body: T;
}

/** The one error shape, as D1's sendError writes it. The message is plain and safe to show. */
export interface ApiError {
  error: { code: string; message: string; [extra: string]: unknown };
}

export const ok = <T>(body: T, status = 200): ApiResult<T> => ({ status, body });

export const fail = (status: number, code: string, message: string, extra: Record<string, unknown> = {}): ApiResult<ApiError> => ({
  status,
  body: { error: { code, message, ...extra } },
});

/** The audit_log kinds (migration v9). */
export type AuditKind = 'auth' | 'config' | 'connection' | 'task' | 'meeting' | 'ops';

/**
 * Writes one audit line (D1's audit store, bound when the routes are mounted). event and detail are plain words, never
 * tokens, cookies, QR codes, full phone numbers or message text.
 */
export type AuditFn = (entry: { actor: string; event: string; kind: AuditKind; detail?: string; requestId: string }) => void;
