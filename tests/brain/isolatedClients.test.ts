import { describe, expect, it, vi } from 'vitest';
import { ANTHROPIC_API_URL } from '../../src/brain/anthropicIsolated.ts';
import { ClaudeAssistantClient } from '../../src/brain/assistantClient.ts';
import { ClaudeClient, keepConnectTimeoutCode } from '../../src/brain/claudeClient.ts';
import { ClaudeMediaClient } from '../../src/brain/mediaClient.ts';
import { ClaudeMeetingClient } from '../../src/brain/meetingClient.ts';
import { FALLBACK_PRICES } from '../../src/spend/pricing.ts';

// The four Claude clients pass `isolated` on to the SDK (review B): a customer's gets the isolated options
// (tests/brain/anthropicIsolated.test.ts tests what they do), the founder's are as before. The SDK is a stand-in that
// records what each client was made with. Every key here is a placeholder.

const sdk = vi.hoisted(() => ({ made: [] as Record<string, unknown>[] }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    constructor(o: Record<string, unknown>) {
      sdk.made.push(o);
    }
  },
}));

const KEY = 'sk-ant-placeholder';
const make = {
  reconcile: (isolated?: boolean) => new ClaudeClient({ apiKey: KEY, model: 'm', prices: FALLBACK_PRICES, ...(isolated === undefined ? {} : { isolated }) }),
  media: (isolated?: boolean) => new ClaudeMediaClient({ apiKey: KEY, model: 'm', prices: FALLBACK_PRICES, ...(isolated === undefined ? {} : { isolated }) }),
  meeting: (isolated?: boolean) => new ClaudeMeetingClient({ apiKey: KEY, model: 'm', prices: FALLBACK_PRICES, ...(isolated === undefined ? {} : { isolated }) }),
  assistant: (isolated?: boolean) => new ClaudeAssistantClient({ apiKey: KEY, model: 'm', prices: FALLBACK_PRICES, ...(isolated === undefined ? {} : { isolated }) }),
};
const optionsOf = (fn: () => unknown): Record<string, unknown> => {
  sdk.made.length = 0;
  fn();
  expect(sdk.made).toHaveLength(1);
  return sdk.made[0]!;
};

describe('the Claude clients and `isolated`', () => {
  for (const [name, client] of Object.entries(make)) {
    it(`${name}: a customer's client gets Anthropic's address, no bearer token and the isolating fetch`, () => {
      const o = optionsOf(() => client(true));
      expect(o).toMatchObject({ apiKey: KEY, authToken: null, baseURL: ANTHROPIC_API_URL });
      expect(o.fetch).not.toBe(keepConnectTimeoutCode);
    });

    it(`${name}: the founder's client (isolated unset or false) is made exactly as before`, () => {
      for (const isolated of [undefined, false]) {
        const o = optionsOf(() => client(isolated));
        expect(o.apiKey).toBe(KEY);
        expect(o.fetch).toBe(keepConnectTimeoutCode);
        expect('authToken' in o).toBe(false);
        expect('baseURL' in o).toBe(false);
      }
    });
  }
});
