// Talks to the agent's dashboard API. Same origin only, cookies included. The CSRF token comes from /api/me and is kept
// in memory (never in storage); it goes with every call that changes something. A 401 means the session is gone: the
// page goes back to sign-in.

const BASE = '/dashboard/api';

/** @type {string | null} */
let csrf = null;
/** @type {() => void} */
let onSignedOut = () => {};

/** Called once by app.js: what to do when the session has ended. @param {() => void} fn */
export function setSignedOutHandler(fn) {
  onSignedOut = fn;
}

export class ApiError extends Error {
  /** @param {number} status @param {string} code @param {string} message */
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** @param {Response} res @returns {Promise<any>} */
async function parse(res) {
  if (res.status === 204) return null;
  let body = null;
  try {
    body = await res.json();
  } catch {
    // not JSON: handled below
  }
  if (res.ok) return body;
  if (res.status === 401) onSignedOut();
  const err = /** @type {{ error?: { code?: string, message?: string } } | null} */ (body)?.error;
  throw new ApiError(res.status, err?.code ?? 'http_' + res.status, err?.message ?? 'Something went wrong.');
}

/** GET a path under /dashboard/api. @param {string} path */
export async function get(path) {
  return parse(await fetch(BASE + path, { credentials: 'same-origin', headers: { Accept: 'application/json' } }));
}

/** POST JSON to a path under /dashboard/api, with the CSRF token. @param {string} path @param {unknown} [body] */
export async function post(path, body) {
  return parse(
    await fetch(BASE + path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': csrf ?? '' },
      body: JSON.stringify(body ?? {}),
    }),
  );
}

/**
 * The signed-in owner, or null when there is no session (401). Keeps the CSRF token in memory.
 * @returns {Promise<{ email: string, name: string, signedInAt: string, expiresAt: string } | null>}
 */
export async function me() {
  const res = await fetch(BASE + '/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
  if (res.status === 401) return null;
  const body = await parse(res);
  csrf = typeof body?.csrf === 'string' ? body.csrf : null;
  return { email: String(body?.email ?? ''), name: String(body?.name ?? ''), signedInAt: String(body?.signedInAt ?? ''), expiresAt: String(body?.expiresAt ?? '') };
}

/** Ends the session on the agent (CSRF-checked). */
export async function signOut() {
  const res = await fetch('/dashboard/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf ?? '' } });
  csrf = null;
  if (!res.ok && res.status !== 401) throw new ApiError(res.status, 'signout_failed', 'Signing out did not work. Try again.');
}

/**
 * Calls fn now and then every `ms` while the tab is visible. Returns a stop function.
 * @param {() => unknown} fn @param {number} ms
 */
export function poll(fn, ms) {
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let timer;
  const run = () => {
    try {
      const r = fn();
      if (r instanceof Promise) r.catch(() => {});
    } catch {
      // the screen shows its own error state
    }
  };
  const start = () => {
    if (timer !== undefined || document.hidden) return;
    run();
    timer = setInterval(run, ms);
  };
  const halt = () => {
    clearInterval(timer);
    timer = undefined;
  };
  const onVisibility = () => (document.hidden ? halt() : start());
  document.addEventListener('visibilitychange', onVisibility);
  start();
  return () => {
    halt();
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
