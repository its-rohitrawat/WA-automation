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

  function capture() {
    const lines: string[] = [];
    const dest = { write: (s: string) => { lines.push(s); } } as unknown as DestinationStream;
    return { log: createLogger('info', dest), out: () => lines.join('') };
  }

  it('censors content fields one level deep', () => {
    const { log, out } = capture();
    log.info({ m: { text: 'NESTED-SECRET' } }, 'a');
    log.info({ m: { message: 'NESTED-MSG' } }, 'b');
    expect(out()).not.toContain('NESTED-SECRET');
    expect(out()).not.toContain('NESTED-MSG');
  });

  it('censors caption and conversation at the top level', () => {
    const { log, out } = capture();
    log.info({ caption: 'CAP-SECRET', conversation: 'CONV-SECRET' }, 'c');
    expect(out()).not.toContain('CAP-SECRET');
    expect(out()).not.toContain('CONV-SECRET');
  });

  it('does not leak error message text', () => {
    const { log, out } = capture();
    log.error({ err: new Error('client said SECRET-IN-ERROR') }, 'x');
    expect(out()).toContain('"type":"Error"');
    expect(out()).not.toContain('SECRET-IN-ERROR');
  });
});
