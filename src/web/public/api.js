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

/** @type {() => void} */
let onWorkspaceStarting = () => {};

/**
 * Called once by app.js: what to do when a customer's workspace is not running yet (503 workspace_starting: their
 * runtime is still starting). The call still throws, as any error does.
 * @param {() => void} fn
 */
export function setWorkspaceStartingHandler(fn) {
  onWorkspaceStarting = fn;
}

export class ApiError extends Error {
  /**
   * @param {number} status @param {string} code @param {string} message
   * @param {Record<string, unknown>} [details] the error's other fields (for example `key` and `field` on a 422)
   */
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
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
  const err = /** @type {{ error?: { code?: string, message?: string } & Record<string, unknown> } | null} */ (body)?.error;
  if (res.status === 503 && err?.code === 'workspace_starting') onWorkspaceStarting();
  const message = typeof err?.message === 'string' ? err.message : 'Something went wrong.';
  throw new ApiError(res.status, typeof err?.code === 'string' ? err.code : 'http_' + res.status, message, err ?? {});
}

/** GET a path under /dashboard/api. @param {string} path */
export async function get(path) {
  return parse(await fetch(BASE + path, { credentials: 'same-origin', headers: { Accept: 'application/json' } }));
}

/**
 * POST JSON to a path under /dashboard/api, with the CSRF token. `keepalive` lets it finish while the page unloads.
 * @param {string} path @param {unknown} [body] @param {{ keepalive?: boolean }} [opts]
 */
export async function post(path, body, opts = {}) {
  return parse(
    await fetch(BASE + path, {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: opts.keepalive === true,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': csrf ?? '' },
      body: JSON.stringify(body ?? {}),
    }),
  );
}

/**
 * POSTs JSON with the CSRF token and reads the answer as it streams: one JSON object per line, each handed to onEvent
 * as it arrives (the assistant's answers). An error status throws ApiError, as post() does.
 * @param {string} path @param {unknown} body @param {(e: any) => void} onEvent
 */
export async function postLines(path, body, onEvent) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { Accept: 'application/x-ndjson, application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': csrf ?? '' },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok || !res.body) {
    await parse(res);
    throw new ApiError(res.status, 'http_' + res.status, 'Something went wrong.');
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        onEvent(JSON.parse(line));
      } catch {
        // a line that is not JSON is skipped
      }
    }
  }
}

/**
 * The signed-in owner, or null when there is no session (401). Keeps the CSRF token in memory.
 * `platform`: the platform screens are on (SaaS S5: the founder's platform routes are mounted). `role`: 'founder', or
 * 'owner' for a customer's owner (S4.8); left out by a server before S4.8, which has only the founder.
 * @returns {Promise<{ email: string, name: string, signedInAt: string, expiresAt: string, platform: boolean, role: string } | null>}
 */
export async function me() {
  const res = await fetch(BASE + '/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
  if (res.status === 401) return null;
  const body = await parse(res);
  csrf = typeof body?.csrf === 'string' ? body.csrf : null;
  return {
    email: String(body?.email ?? ''), name: String(body?.name ?? ''), signedInAt: String(body?.signedInAt ?? ''), expiresAt: String(body?.expiresAt ?? ''),
    platform: body?.platform === true,
    role: body?.role === 'owner' ? 'owner' : 'founder',
  };
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
