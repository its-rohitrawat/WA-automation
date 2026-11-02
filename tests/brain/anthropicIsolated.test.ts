import Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ANTHROPIC_API_URL, isolatedClientOptions, isolatedFetch } from '../../src/brain/anthropicIsolated.ts';

// A customer's Anthropic client takes nothing from the founder's environment (review B). The real SDK, with a fake fetch:
// nothing leaves this machine. Every key and value here is a placeholder.

const ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS'] as const;
const CUSTOMER_KEY = 'sk-ant-customer-placeholder';
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  // What a founder's environment could hold.
  process.env.ANTHROPIC_API_KEY = 'sk-ant-founder-env-placeholder';
  process.env.ANTHROPIC_AUTH_TOKEN = 'founder-bearer-placeholder';
  process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9/founder-proxy';
  process.env.ANTHROPIC_CUSTOM_HEADERS = 'X-Founder-Tag: founder-value\nX-Api-Key: sk-ant-founder-header-placeholder\nanthropic-beta: founder-beta';
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** A fake network: records each request's URL and headers, and answers an empty models list. */
function network() {
  const seen: { url: string; headers: Headers }[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    seen.push({ url: input instanceof Request ? input.url : String(input), headers: new Headers(init?.headers) });
    return new Response(JSON.stringify({ data: [], has_more: false, first_id: null, last_id: null }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { seen, fetch };
}

describe('a customer’s Anthropic client (anthropicIsolated.ts)', () => {
  it('without it, the founder’s environment reaches a client given its own key: the reason for it', async () => {
    const net = network();
    await new Anthropic({ apiKey: CUSTOMER_KEY, fetch: net.fetch, maxRetries: 0 }).models.list({ limit: 1 });
    const { url, headers } = net.seen[0]!;
    expect(url.startsWith('http://127.0.0.1:9/founder-proxy')).toBe(true);
    expect(headers.get('authorization')).toBe('Bearer founder-bearer-placeholder');
    expect(headers.get('x-founder-tag')).toBe('founder-value');
    expect(headers.get('x-api-key')).toBe('sk-ant-founder-header-placeholder'); // the environment's header even replaced the key
  });

  it('with it: Anthropic’s own address, the customer’s key only, no bearer token, none of the environment’s headers', async () => {
    const net = network();
    await new Anthropic({ ...isolatedClientOptions(CUSTOMER_KEY, net.fetch), maxRetries: 0 }).models.list({ limit: 1 });
    const { url, headers } = net.seen[0]!;
    expect(url.startsWith(`${ANTHROPIC_API_URL}/`)).toBe(true);
    expect(headers.get('x-api-key')).toBe(CUSTOMER_KEY);
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('x-founder-tag')).toBeNull();
    expect(headers.get('anthropic-beta')).toBeNull();
    expect(JSON.stringify([...headers])).not.toMatch(/founder/);
  });

  it('a header the request sets itself is kept, even when the environment names the same header', async () => {
    const net = network();
    const client = new Anthropic({ ...isolatedClientOptions(CUSTOMER_KEY, net.fetch), maxRetries: 0 });
    await client.models.list({ limit: 1 }, { headers: { 'anthropic-beta': 'own-beta' } });
    expect(net.seen[0]!.headers.get('anthropic-beta')).toBe('own-beta');
  });

  it('its fetch alone (the second layer): drops any Authorization and puts the customer’s key last', async () => {
    const net = network();
    await isolatedFetch(CUSTOMER_KEY, net.fetch)('https://api.anthropic.com/v1/models', {
      headers: { Authorization: 'Bearer founder-bearer-placeholder', 'X-Api-Key': 'sk-ant-founder-header-placeholder', 'X-Founder-Tag': 'founder-value' },
    });
    const { headers } = net.seen[0]!;
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('x-api-key')).toBe(CUSTOMER_KEY);
    expect(headers.get('x-founder-tag')).toBeNull();
  });

  it('reads the environment at each request, not when the client is made', async () => {
    const net = network();
    delete process.env.ANTHROPIC_CUSTOM_HEADERS;
    const client = new Anthropic({ ...isolatedClientOptions(CUSTOMER_KEY, net.fetch), maxRetries: 0 });
    process.env.ANTHROPIC_CUSTOM_HEADERS = 'X-Late: late-value';
    await client.models.list({ limit: 1 }, { headers: { 'X-Late': 'late-value' } }); // as if it came from the environment
    expect(net.seen[0]!.headers.get('x-late')).toBeNull();
  });
});
