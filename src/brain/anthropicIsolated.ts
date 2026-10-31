// A customer's Anthropic client, isolated from the founder's environment (review B). The SDK reads three settings from
// process.env for every client it makes, whatever key it is given:
// - ANTHROPIC_BASE_URL: where every request goes;
// - ANTHROPIC_AUTH_TOKEN: sent as `Authorization: Bearer …` BESIDE an explicit apiKey;
// - ANTHROPIC_CUSTOM_HEADERS: merged in after the auth headers, so it could even replace X-Api-Key.
// A founder's setting must never reach a customer's call, so a customer's client sets the first two itself, and its fetch
// gives every request the customer's own key, no Authorization, and none of the environment's custom headers. Those are
// read from process.env at each request, compared and dropped there; no value is kept. The founder's clients are as before.

/** Anthropic's API, set explicitly so ANTHROPIC_BASE_URL is never used. */
export const ANTHROPIC_API_URL = 'https://api.anthropic.com';

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * The environment's custom headers that this request would send as set there: their names, lower-cased. A header the
 * request set to another value itself is not one of them. Read at the call; nothing is kept.
 */
function fromEnv(headers: Headers): string[] {
  const raw = process.env.ANTHROPIC_CUSTOM_HEADERS;
  if (!raw) return [];
  const names: string[] = [];
  for (const line of raw.split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (name !== '' && headers.get(name) === line.slice(colon + 1).trim()) names.push(name);
  }
  return names;
}

/** The customer's fetch: its own key, no bearer token and none of the environment's custom headers, then `base`. */
export function isolatedFetch(apiKey: string, base: Fetch): Fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    for (const name of fromEnv(headers)) headers.delete(name);
    headers.delete('authorization');
    headers.set('x-api-key', apiKey);
    return base(input, { ...init, headers });
  };
}

/** The options a customer's `new Anthropic(...)` adds to its own (its key, timeouts and retries stay its own). */
export function isolatedClientOptions(apiKey: string, base: Fetch): { apiKey: string; authToken: null; baseURL: string; fetch: Fetch } {
  return { apiKey, authToken: null, baseURL: ANTHROPIC_API_URL, fetch: isolatedFetch(apiKey, base) };
}
