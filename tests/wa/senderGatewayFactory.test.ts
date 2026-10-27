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

const { baileysSenderSocketFactory, SENDER_DEVICE_NAME } = await import('../../src/wa/senderGateway.ts');

describe('baileysSenderSocketFactory', () => {
  it('builds a socket that sets no online presence and syncs no history', async () => {
    const silent = { level: 'silent', child: () => silent, trace() {}, debug() {}, info() {}, warn() {}, error() {} };
    const auth = { creds: {}, keys: {} } as unknown as AuthenticationState;
    baileysSenderSocketFactory(silent as never)(auth);
    const c = captured.config!;
    expect(c.logger).toBe(silent);
    // The spare phone lists this link under its own name.
    expect(c.browser).toEqual([SENDER_DEVICE_NAME, 'Desktop', '1.0.0']);
    expect(SENDER_DEVICE_NAME).toBe('WA Agent - Morning report');
    expect(c.markOnlineOnConnect).toBe(false);
    expect(c.syncFullHistory).toBe(false);
    expect((c.shouldSyncHistoryMessage as () => boolean)()).toBe(false);
    expect(c.generateHighQualityLinkPreview).toBe(false);
    expect(c.enableRecentMessageCache).toBe(true);
    expect(await (c.getMessage as () => Promise<unknown>)()).toBeUndefined();
  });
});
