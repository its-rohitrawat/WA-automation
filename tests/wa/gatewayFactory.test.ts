import { describe, expect, it, vi } from 'vitest';
import type { AuthenticationState } from 'baileys';

const captured: { config?: Record<string, unknown> } = {};

vi.mock('baileys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('baileys')>();
  return {
    ...actual,
    default: (config: Record<string, unknown>) => {
      captured.config = config;
      return {};
    },
    makeCacheableSignalKeyStore: (keys: unknown) => keys,
  };
});

const { baileysSocketFactory } = await import('../../src/wa/gateway.ts');

describe('baileysSocketFactory', () => {
  it('builds a passive socket configuration', async () => {
    const silent = { level: 'silent', child: () => silent, trace() {}, debug() {}, info() {}, warn() {}, error() {} };
    const auth = { creds: {}, keys: {} } as unknown as AuthenticationState;
    baileysSocketFactory(silent as never)(auth, async () => undefined);
    const c = captured.config!;
    expect(c.markOnlineOnConnect).toBe(false);
    expect(c.syncFullHistory).toBe(false);
    expect(c.enableRecentMessageCache).toBe(false);
    expect(await (c.getMessage as () => Promise<unknown>)()).toBeUndefined();
  });
});
