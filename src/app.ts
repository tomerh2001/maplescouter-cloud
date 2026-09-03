import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyReply } from 'fastify';
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
    trustProxy: config.trustProxy,
    bodyLimit: config.bodyLimit,
    // HEAD /v1/characters/:ign is registered explicitly (index-only, no file read).
    exposeHeadRoutes: false,
  });

  await app.register(cors, {
    origin: '*',
    methods: ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'If-Match', 'If-None-Match', 'X-Confirm'],
    exposedHeaders: ['ETag'],
    maxAge: 86_400,
  });

  // Global limiter covers reads; write routes override it below with their own (smaller) budget.
  await app.register(rateLimit, {
    global: true,
    max: config.readRateLimit,
    timeWindow: ONE_MINUTE_MS,
  });
  const writeLimited = { config: { rateLimit: { max: config.writeRateLimit, timeWindow: ONE_MINUTE_MS } } };

  app.addHook('onSend', async (_request, reply) => {
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
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

  app.head<{ Params: IgnParams }>('/v1/characters/:ign', async (request, reply) => {
    const parsed = parseIgn(request.params.ign);
    if (parsed === null) return reply.code(400).send();
    const summary = store.summary(parsed.key);
    if (summary === undefined) return reply.code(404).send();
    reply.header('etag', etagFor(summary.updatedAt));
    reply.header('content-type', 'application/json; charset=utf-8');
    return reply.code(200).send();
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
