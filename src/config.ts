export interface Config {
  port: number;
  host: string;
  dataDir: string;
  logLevel: string;
  logPretty: boolean;
  /** Max request body in bytes. */
  bodyLimit: number;
  /** Trust X-Forwarded-* (we sit behind traefik). */
  trustProxy: boolean;
  /** Reads (GET/HEAD) per minute per IP. */
  readRateLimit: number;
  /** Writes (PUT/DELETE) per minute per IP, per endpoint. */
  writeRateLimit: number;
}

export const DEFAULT_BODY_LIMIT = 256 * 1024;

function intEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function boolEnv(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: intEnv(env.PORT, 8080),
    host: env.HOST?.trim() || '0.0.0.0',
    dataDir: env.DATA_DIR?.trim() || '/data',
    logLevel: env.LOG_LEVEL?.trim() || 'info',
    logPretty: boolEnv(env.LOG_PRETTY, false),
    bodyLimit: intEnv(env.BODY_LIMIT, DEFAULT_BODY_LIMIT),
    trustProxy: boolEnv(env.TRUST_PROXY, true),
    readRateLimit: intEnv(env.READ_RATE_LIMIT, 600),
    writeRateLimit: intEnv(env.WRITE_RATE_LIMIT, 60),
  };
}
