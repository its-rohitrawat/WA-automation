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

const { baileysSocketFactory, TRACKER_DEVICE_NAME } = await import('../../src/wa/gateway.ts');
const { SENDER_DEVICE_NAME } = await import('../../src/wa/senderGateway.ts');

describe('baileysSocketFactory', () => {
  it('builds a passive socket configuration', async () => {
    const silent = { level: 'silent', child: () => silent, trace() {}, debug() {}, info() {}, warn() {}, error() {} };
    const auth = { creds: {}, keys: {} } as unknown as AuthenticationState;
    baileysSocketFactory(silent as never)(auth, async () => undefined);
    const c = captured.config!;
    expect(c.markOnlineOnConnect).toBe(false);
    expect(c.syncFullHistory).toBe(false);
    expect(c.enableRecentMessageCache).toBe(false);
    // The founder's phone lists this link under its own name, never the spare number's.
    expect(c.browser).toEqual([TRACKER_DEVICE_NAME, 'Desktop', '1.0.0']);
    expect(TRACKER_DEVICE_NAME).toBe('WA Agent - Tracker');
    expect(TRACKER_DEVICE_NAME).not.toBe(SENDER_DEVICE_NAME);
    expect(await (c.getMessage as () => Promise<unknown>)()).toBeUndefined();
  });
});
