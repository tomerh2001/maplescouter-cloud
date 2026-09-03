import pino, { type Logger } from 'pino';

export function createLogger(opts: { logLevel: string; logPretty: boolean }): Logger {
  // pino writes newline-delimited JSON to stdout by default; LOG_PRETTY is a dev-only convenience.
  return pino({
    level: opts.logLevel,
    ...(opts.logPretty ? { transport: { target: 'pino-pretty' } } : {}),
  });
}
