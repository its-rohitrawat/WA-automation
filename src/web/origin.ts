import type { IncomingMessage } from 'node:http';
import { secureFor } from './sessions.ts';

/**
 * The origin a browser is using, from an allowlist only: the public address, or this machine's own
 * `http://localhost:<port>` / `http://127.0.0.1:<port>`. An unknown Host gets the public address (else localhost). The
 * same rule as sign-in's (src/web/routes/auth.ts), for routes outside it that set cookies.
 */
export function requestOrigin(req: IncomingMessage, o: { publicUrl?: string; port: () => number | undefined }): string {
  const publicOrigin = o.publicUrl === undefined ? undefined : new URL(o.publicUrl).origin;
  const host = req.headers.host;
  const port = o.port();
  if (publicOrigin !== undefined && host === new URL(publicOrigin).host) return publicOrigin;
  if (port !== undefined && (host === `localhost:${port}` || host === `127.0.0.1:${port}`)) return `http://${host}`;
  return publicOrigin ?? `http://localhost:${port ?? 0}`;
}

/** Whether cookies set for this request carry `Secure`: only when the browser came in over the https public address. */
export function secureRequest(o: { publicUrl?: string; port: () => number | undefined }): (req: IncomingMessage) => boolean {
  return (req) => secureFor(requestOrigin(req, o));
}
