import { createRequire } from 'node:module';
import pino, { type Logger } from 'pino';

function prettyAvailable(): boolean {
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

export function createLogger(opts: { logLevel: string; logPretty: boolean }): Logger {
  // pino writes newline-delimited JSON to stdout by default; LOG_PRETTY is a dev-only convenience.
  // pino-pretty is a devDependency, so the production image must not crash when LOG_PRETTY is set.
  const pretty = opts.logPretty && prettyAvailable();
  const logger = pino({
    level: opts.logLevel,
    ...(pretty ? { transport: { target: 'pino-pretty' } } : {}),
  });
  if (opts.logPretty && !pretty) logger.warn('LOG_PRETTY set but pino-pretty is not installed; using JSON logs');
  return logger;
}
