/** A gaxios error with HTTP 401 or an invalid_grant body, or an error that says invalid_grant. */
export function isAuthFailure(e: unknown): boolean {
  const x = e as { code?: unknown; status?: unknown; name?: string; message?: string; response?: { status?: number; data?: { error?: unknown } } } | null;
  if (!x || typeof x !== 'object') return false;
  if (x.name === 'DriveAuthError') return true;
  if (Number(x.code) === 401 || x.status === 401 || x.response?.status === 401) return true;
  if (x.response?.data?.error === 'invalid_grant') return true;
  return /invalid_grant/.test(`${x.name ?? ''} ${x.message ?? ''}`);
}
