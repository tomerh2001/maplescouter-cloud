import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { LogController, type FastifyReply } from 'fastify';
import { Address6 } from 'ip-address';
import { isIPv6 } from 'node:net';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import { parseIgn } from './ign.js';
import { CharacterStore, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from './store.js';
import { deriveMeta, validatePutBody } from './validate.js';

export interface AppOptions {
  config: Config;
  store: CharacterStore;
  logger: Logger;
}

const ONE_MINUTE_MS = 60_000;
const NO_RATE_LIMIT = { rateLimit: false as const };
const REPO_URL = 'https://github.com/tomerh2001/maplescouter-cloud';

interface IgnParams {
  ign: string;
}

export function etagFor(updatedAt: string): string {
  return `"${updatedAt}"`;
}

/** Parse an If-Match / If-None-Match header into unquoted tags ("*" kept as-is). Undefined when absent or empty. */
export function parseEntityTags(header: string | string[] | undefined): string[] | undefined {
  if (header === undefined) return undefined;
  const raw = Array.isArray(header) ? header.join(',') : header;
  const tags = raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '')
    .map((t) => /^(?:W\/)?"(.*)"$/.exec(t)?.[1] ?? t);
  return tags.length > 0 ? tags : undefined;
}

function tagsMatch(tags: string[] | undefined, updatedAt: string): boolean {
  return tags !== undefined && tags.some((t) => t === '*' || t === updatedAt);
}

function errorInfo(error: unknown): { statusCode: number; code: string; message: string } {
  const e = (typeof error === 'object' && error !== null ? error : {}) as {
    statusCode?: unknown;
    code?: unknown;
    message?: unknown;
  };
  return {
    statusCode: typeof e.statusCode === 'number' ? e.statusCode : 500,
    code: typeof e.code === 'string' ? e.code : '',
    message: typeof e.message === 'string' ? e.message : 'error',
  };
}

/**
 * Client address used as the rate-limit key. Behind Cloudflare → cloudflared → traefik the socket peer
 * and the last X-Forwarded-For hop are both infrastructure, while `CF-Connecting-IP` is set by the
 * Cloudflare edge and cannot be spoofed past it. So: CF-Connecting-IP when both TRUST_PROXY and
 * TRUST_CF_HEADER are on, else Fastify's `request.ip` (which already honours the trustProxy option:
 * the last X-Forwarded-For hop with TRUST_PROXY=true, the socket peer with TRUST_PROXY=false).
 * Headers are never consulted when the proxy is not trusted, so a direct client cannot pick its own bucket.
 * The result is normalised (see normaliseIp) because a custom keyGenerator skips the plugin's own IPv6 masking.
 */
export function clientIp(
  request: { headers: Record<string, string | string[] | undefined>; ip: string },
  trust: Pick<Config, 'trustProxy' | 'trustCfHeader'>,
): string {
  if (trust.trustProxy && trust.trustCfHeader) {
    const cf = request.headers['cf-connecting-ip'];
    const cfIp = (Array.isArray(cf) ? cf[0] : cf)?.trim();
    if (cfIp) return normaliseIp(cfIp);
  }
  return normaliseIp(request.ip);
}

/**
 * Mirror @fastify/rate-limit's default key normalisation: IPv4-mapped IPv6 collapses to the IPv4, other IPv6
 * is masked to its /64 (one residential customer owns 2^64 addresses, so a per-address key could be rotated
 * around the limiter), and IPv4 is lower-cased. Unparseable input is returned as-is.
 */
export function normaliseIp(ip: string): string {
  if (!isIPv6(ip)) return ip.toLowerCase();
  try {
    const address = new Address6(ip);
    if (address.isMapped4()) return address.to4().correctForm();
    return new Address6(`${ip}/64`).startAddress().correctForm();
  } catch {
    return ip;
  }
}

function notFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ error: 'not_found' });
}

function invalidIgn(reply: FastifyReply): FastifyReply {
  return reply.code(400).send({ error: 'invalid_ign', detail: 'ign must match ^[A-Za-z0-9]{1,16}$' });
}

/** The concrete Fastify instance type (its logger generic is pino's Logger). */
export type App = Awaited<ReturnType<typeof buildApp>>;

export async function buildApp({ config, store, logger }: AppOptions) {
  const app = Fastify({
    loggerInstance: logger,
    // Fastify's stock request lines print the concrete URL (which carries the IGN) and `request.ip`,
    // which behind traefik is cloudflared, not the address the limiter keys on. The onResponse hook
    // below logs one line per request with the route pattern and the same address as clientIp().
    logController: new LogController({ disableRequestLogging: true }),
    // Trust exactly one hop (traefik, the socket peer) for X-Forwarded-*; never the whole chain.
    // The limiter key itself comes from clientIp(), see above.
    trustProxy: config.trustProxy ? (_address: string, hop: number) => hop === 0 : false,
    bodyLimit: config.bodyLimit,
    // Auto-HEAD for every GET (uptime monitors probe with HEAD); /v1/characters/:ign overrides it below.
    exposeHeadRoutes: true,
  });

  await app.register(cors, {
    origin: '*',
    methods: ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'If-Match', 'If-None-Match', 'X-Confirm'],
    // Retry-After and X-RateLimit-* let the browser client tell the user how long to wait on 429.
    exposedHeaders: ['ETag', 'Retry-After', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
    maxAge: 86_400,
  });

  // Global limiter covers reads; write routes override it below with their own (smaller) budget.
  await app.register(rateLimit, {
    global: true,
    max: config.readRateLimit,
    timeWindow: ONE_MINUTE_MS,
    keyGenerator: (request) => clientIp(request, config),
  });
  const writeLimited = { config: { rateLimit: { max: config.writeRateLimit, timeWindow: ONE_MINUTE_MS } } };

  app.addHook('onSend', async (_request, reply) => {
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
  });

  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        method: request.method,
        // Route pattern, not the URL: the URL contains the IGN. Unmatched requests have no route.
        route: request.routeOptions.url ?? 'unmatched',
        status: reply.statusCode,
        ms: Math.round(reply.elapsedTime),
        ip: clientIp(request, config),
      },
      'request',
    );
  });

  app.setNotFoundHandler((_request, reply) => notFound(reply));

  app.setErrorHandler((error: unknown, request, reply) => {
    const { statusCode: status, code, message } = errorInfo(error);
    if (status === 429) return reply.code(429).send({ error: 'rate_limited' });
    if (code === 'FST_ERR_CTP_BODY_TOO_LARGE' || status === 413) {
      return reply.code(413).send({ error: 'payload_too_large', limit: config.bodyLimit });
    }
    if (code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || status === 415) {
      return reply.code(415).send({ error: 'unsupported_media_type', detail: 'send Content-Type: application/json' });
    }
    if (code === 'FST_ERR_CTP_INVALID_JSON_BODY' || code === 'FST_ERR_CTP_EMPTY_JSON_BODY') {
      return reply.code(400).send({ error: 'invalid_json' });
    }
    if (status >= 400 && status < 500) return reply.code(status).send({ error: 'bad_request', detail: message });
    request.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send({ error: 'internal' });
  });

  app.get('/', { config: NO_RATE_LIMIT }, async () => ({
    service: 'maplescouter-cloud',
    docs: REPO_URL,
    endpoints: ['GET /healthz', 'GET /v1/characters', 'GET|HEAD|PUT|DELETE /v1/characters/:ign'],
  }));

  app.get('/healthz', { config: NO_RATE_LIMIT }, async () => ({ ok: true, characters: store.size() }));

  app.get<{ Querystring: { limit?: string } }>('/v1/characters', async (request) => {
    let limit = DEFAULT_LIST_LIMIT;
    const raw = request.query.limit;
    if (raw !== undefined) {
      const n = Number(raw);
      if (Number.isInteger(n) && n >= 1) limit = Math.min(n, MAX_LIST_LIMIT);
    }
    return { characters: store.list(limit) };
  });

  // Registered BEFORE the GET so exposeHeadRoutes does not auto-generate (and collide with) a HEAD here.
  app.head<{ Params: IgnParams }>('/v1/characters/:ign', async (request, reply) => {
    const parsed = parseIgn(request.params.ign);
    if (parsed === null) return reply.code(400).send();
    const summary = store.summary(parsed.key);
    if (summary === undefined) return reply.code(404).send();
    reply.header('etag', etagFor(summary.updatedAt));
    if (tagsMatch(parseEntityTags(request.headers['if-none-match']), summary.updatedAt)) {
      return reply.code(304).send();
    }
    reply.header('content-type', 'application/json; charset=utf-8');
    const bytes = store.byteSize(parsed.key);
    if (bytes !== undefined) reply.header('content-length', String(bytes));
    return reply.code(200).send();
  });

  app.get<{ Params: IgnParams }>('/v1/characters/:ign', async (request, reply) => {
    const parsed = parseIgn(request.params.ign);
    if (parsed === null) return invalidIgn(reply);

    const summary = store.summary(parsed.key);
    if (summary === undefined) return notFound(reply);
    reply.header('etag', etagFor(summary.updatedAt));
    if (tagsMatch(parseEntityTags(request.headers['if-none-match']), summary.updatedAt)) {
      return reply.code(304).send();
    }

    const doc = await store.get(parsed.key);
    if (doc === undefined) return notFound(reply);
    reply.header('etag', etagFor(doc.updatedAt));
    return doc;
  });

  app.put<{ Params: IgnParams; Body: unknown }>('/v1/characters/:ign', writeLimited, async (request, reply) => {
    const parsed = parseIgn(request.params.ign);
    if (parsed === null) return invalidIgn(reply);

    const body = validatePutBody(request.body);
    if (!body.ok) return reply.code(400).send({ error: 'invalid_body', detail: body.detail });
    const { preset, label, meta } = body.value;

    const result = await store.put(
      parsed.key,
      { ign: parsed.ign, label: label ?? parsed.ign, meta: deriveMeta(preset, meta), preset },
      { ifMatch: parseEntityTags(request.headers['if-match']) },
    );
    if (result.status === 'conflict') {
      return reply.code(409).send({ error: 'conflict', updatedAt: result.updatedAt });
    }
    if (result.status === 'full') {
      return reply.code(507).send({ error: 'storage_full', limit: store.maxCharacters });
    }
    reply.header('etag', etagFor(result.doc.updatedAt));
    return reply.code(result.status === 'created' ? 201 : 200).send({ ign: result.doc.ign, updatedAt: result.doc.updatedAt });
  });

  app.delete<{ Params: IgnParams }>('/v1/characters/:ign', writeLimited, async (request, reply) => {
    const parsed = parseIgn(request.params.ign);
    if (parsed === null) return invalidIgn(reply);

    const confirm = request.headers['x-confirm'];
    if (typeof confirm !== 'string' || confirm.trim().toLowerCase() !== parsed.key) {
      return reply.code(400).send({ error: 'confirm_required', detail: `send header X-Confirm: ${parsed.ign}` });
    }
    const removed = await store.delete(parsed.key);
    if (!removed) return notFound(reply);
    return reply.code(204).send();
  });

  return app;
}
