import type { IncomingMessage, ServerResponse } from 'node:http';

/** What a route handler gets. `url` is parsed against a fixed local base; use it for `searchParams` only. */
export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  /** The `:param` values, percent-decoded. A null-prototype object. */
  params: Readonly<Record<string, string>>;
  url: URL;
  /** 12 hex characters; goes into log lines so an error can be found without logging request details. */
  requestId: string;
}

export type Handler = (ctx: RequestContext) => void | Promise<void>;

export interface RouteMatch {
  handler: Handler;
  params: Record<string, string>;
  /** The pattern as registered (for example `/dashboard/api/tasks/:id`): what the request log shows instead of the path. */
  pattern: string;
}

export interface Router {
  get(path: string, handler: Handler): void;
  post(path: string, handler: Handler): void;
  match(method: string, pathname: string): RouteMatch | undefined;
  /** The methods some route answers for this path (GET also stands for HEAD); empty when none does. */
  methodsFor(pathname: string): ('GET' | 'POST')[];
  /** Every route, in registration order (the route sweep test reads it, so a new route is covered by itself). */
  routes(): { method: 'GET' | 'POST'; pattern: string }[];
}

type Segment = { literal: string } | { param: string };

interface Route {
  method: 'GET' | 'POST';
  pattern: string;
  /** The pattern with every param written as `:`, so `/a/:id` and `/a/:key` count as the same route. */
  shape: string;
  segments: Segment[];
  handler: Handler;
}

const LITERAL = /^[A-Za-z0-9._~-]+$/;
const PARAM = /^:[A-Za-z_][A-Za-z0-9_]*$/;

function compile(pattern: string): Segment[] {
  if (!pattern.startsWith('/')) throw new Error('route pattern must start with /');
  const parts = pattern.slice(1).split('/');
  const seen = new Set<string>();
  return parts.map((p) => {
    if (PARAM.test(p)) {
      const name = p.slice(1);
      if (seen.has(name)) throw new Error('route pattern repeats a param name');
      seen.add(name);
      return { param: name };
    }
    if (!LITERAL.test(p)) throw new Error('route pattern has an invalid segment');
    return { literal: p };
  });
}

/**
 * A tiny router: exact literal segments and `:param` segments, matched in registration order. Patterns are fixed in
 * code; nothing from a request is ever turned into a regular expression.
 */
export function createRouter(): Router {
  const routes: Route[] = [];

  function add(method: 'GET' | 'POST', pattern: string, handler: Handler): void {
    const segments = compile(pattern);
    const shape = segments.map((s) => ('param' in s ? ':' : s.literal)).join('/');
    if (routes.some((r) => r.method === method && r.shape === shape)) throw new Error('duplicate route');
    routes.push({ method, pattern, shape, segments, handler });
  }

  function match(method: string, pathname: string): RouteMatch | undefined {
    const m = method === 'HEAD' ? 'GET' : method;
    if (m !== 'GET' && m !== 'POST') return undefined;
    if (!pathname.startsWith('/')) return undefined;
    const parts = pathname.slice(1).split('/');
    outer: for (const r of routes) {
      if (r.method !== m || r.segments.length !== parts.length) continue;
      const params = Object.create(null) as Record<string, string>;
      for (let i = 0; i < parts.length; i++) {
        const seg = r.segments[i]!;
        const part = parts[i]!;
        if ('literal' in seg) {
          if (seg.literal !== part) continue outer;
          continue;
        }
        if (part === '') continue outer;
        let value: string;
        try {
          value = decodeURIComponent(part);
        } catch {
          continue outer;
        }
        params[seg.param] = value;
      }
      return { handler: r.handler, params, pattern: r.pattern };
    }
    return undefined;
  }

  return {
    get: (path, handler) => add('GET', path, handler),
    post: (path, handler) => add('POST', path, handler),
    match,
    methodsFor: (pathname) => (['GET', 'POST'] as const).filter((m) => match(m, pathname) !== undefined),
    routes: () => routes.map((r) => ({ method: r.method, pattern: r.pattern })),
  };
}
