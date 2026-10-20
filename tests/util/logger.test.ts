import { describe, expect, it } from 'vitest';
import type { DestinationStream } from 'pino';
import { createLogger } from '../../src/util/logger.ts';

describe('logger', () => {
  it('censors fields that can carry chat content', () => {
    const lines: string[] = [];
    const dest = { write: (s: string) => { lines.push(s); } } as unknown as DestinationStream;
    const log = createLogger('info', dest);
    log.info({ clientId: 3, text: 'banner thoda bright karo', prompt: 'secret prompt' }, 'stored');
    const out = lines.join('');
    expect(out).toContain('"clientId":3');
    expect(out).not.toContain('banner');
    expect(out).not.toContain('secret prompt');
    expect(out).toContain('[REDACTED]');
  });
});
