import { pino, type DestinationStream, type Logger } from 'pino';

/** Field names that could carry chat content. Always censored, even if a caller logs them by mistake. */
const REDACT = ['text', 'body', 'content', 'message', 'prompt', 'quote', '*.text', '*.body', '*.content', '*.prompt', '*.quote'];

export type { Logger };

export function createLogger(level: string, destination?: DestinationStream): Logger {
  const opts = { level, base: undefined, redact: { paths: REDACT, censor: '[REDACTED]' } };
  return destination ? pino(opts, destination) : pino(opts);
}

export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}
