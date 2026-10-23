import { isAuthFailure } from '../output/authFailure.ts';

// The errors of the meetings Google client. Messages carry short codes only, never a response body, title, name or email,
// and no error keeps its cause (a gaxios error holds the response body and request details).

/** Sign-in expired or revoked, or a meeting permission is missing: nothing works until google-auth is run again. */
export class GoogleAccessError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Google sign-in or a meeting permission is missing (${code}). Run: npm run cli -- google-auth`);
    this.name = 'GoogleAccessError';
    this.code = code;
  }
}

/** This one item is gone or not readable by WA Agent: a 404, or a 403 that is not about scopes or quotas. */
export class GoogleNoAccessError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Google item not found or not readable (${code})`);
    this.name = 'GoogleNoAccessError';
    this.code = code;
  }
}

/**
 * May pass on a later try: 429, 5xx and any other status not listed above, quota 403s, timeouts, network errors, and
 * answers that do not have the expected shape (bad_answer).
 */
export class GoogleTransientError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Google gave no usable answer (${code})`);
    this.name = 'GoogleTransientError';
    this.code = code;
  }
}

/** The recording is larger than the download limit. */
export class DownloadTooBigError extends Error {
  readonly code = 'too_big';
  constructor() {
    super('Recording is larger than the download limit (too_big)');
    this.name = 'DownloadTooBigError';
  }
}

const SCOPE_REASONS = new Set(['insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT']);
/** Drive's and Calendar's quota reasons. */
const RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'downloadQuotaExceeded', 'quotaExceeded', 'dailyLimitExceeded']);

/**
 * The reasons in a Google error body, in either shape: `error.errors[].reason` (Drive, Calendar), or `error.status` with
 * `error.details[].reason` (AIP-193: Meet). A body that arrived as text (a streamed download) is parsed first. A plain
 * `error` string (the token endpoint's invalid_grant) counts as a reason. Only compared with fixed sets, never shown.
 */
export function errorReasons(data: unknown): Set<string> {
  const out = new Set<string>();
  let body = data;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body) as unknown;
    } catch {
      return out;
    }
  }
  const error = (body as { error?: unknown } | null | undefined)?.error;
  if (typeof error === 'string') out.add(error);
  if (!error || typeof error !== 'object') return out;
  const { status, errors, details } = error as { status?: unknown; errors?: unknown; details?: unknown };
  if (typeof status === 'string') out.add(status);
  for (const list of [errors, details]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const reason = (item as { reason?: unknown } | null)?.reason;
      if (typeof reason === 'string') out.add(reason);
    }
  }
  return out;
}

/** The HTTP status of a gaxios error, read as drive.ts does: response.status, then status, then a numeric code. */
export function httpStatus(e: unknown): number | undefined {
  const x = e as { code?: unknown; status?: unknown; response?: { status?: unknown } } | null;
  for (const v of [x?.response?.status, x?.status, x?.code]) {
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{3}$/.test(v) ? Number(v) : NaN;
    if (Number.isInteger(n) && n >= 100 && n <= 599) return n;
  }
  return undefined;
}

/**
 * What a failed Google call throws:
 * - after a stop through `signal`: the signal's own reason, so callers can tell a stop from a failure;
 * - the four errors above: unchanged;
 * - 401 or invalid_grant: GoogleAccessError; 403 by reason: scope → GoogleAccessError, quota → GoogleTransientError,
 *   anything else → GoogleNoAccessError; 404: GoogleNoAccessError; any other status: GoogleTransientError http_<status>;
 * - no status: GoogleTransientError, `timeout` for a TimeoutError, ETIMEDOUT or an AbortError (not the caller's stop, so
 *   the time limit), otherwise `network`.
 */
export function mapGoogleError(e: unknown, signal: AbortSignal): unknown {
  if (signal.aborted) return signal.reason ?? e;
  if (e instanceof GoogleAccessError || e instanceof GoogleNoAccessError || e instanceof GoogleTransientError || e instanceof DownloadTooBigError) return e;
  if (e === null || typeof e !== 'object') return new GoogleTransientError('network');
  const status = httpStatus(e);
  if (isAuthFailure(e)) return new GoogleAccessError(status === 401 ? 'http_401' : 'invalid_grant');
  if (status === 403) {
    const reasons = [...errorReasons((e as { response?: { data?: unknown } }).response?.data)];
    if (reasons.some((r) => SCOPE_REASONS.has(r))) return new GoogleAccessError('http_403_scope');
    if (reasons.some((r) => RATE_REASONS.has(r))) return new GoogleTransientError('http_403_rate');
    return new GoogleNoAccessError('http_403');
  }
  if (status === 404) return new GoogleNoAccessError('http_404');
  if (status !== undefined) return new GoogleTransientError(`http_${status}`);
  const x = e as { code?: unknown; name?: unknown; cause?: { name?: unknown } | null };
  const timeoutNames = ['TimeoutError', 'AbortError', 'ETIMEDOUT'];
  if ([x.code, x.name, x.cause?.name].some((v) => typeof v === 'string' && timeoutNames.includes(v))) return new GoogleTransientError('timeout');
  return new GoogleTransientError('network');
}
