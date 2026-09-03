import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeApp, samplePreset, type TestApp } from './helpers.js';

let t: TestApp;

beforeEach(async () => {
  t = await makeApp();
});

afterEach(async () => {
  await t.close();
});

const put = (ign: string, body: unknown, headers: Record<string, string> = {}) =>
  t.app.inject({ method: 'PUT', url: `/v1/characters/${ign}`, headers, payload: body as Record<string, unknown> });
const get = (ign: string, headers: Record<string, string> = {}) =>
  t.app.inject({ method: 'GET', url: `/v1/characters/${ign}`, headers });

describe('GET /healthz', () => {
  it('reports ok and the character count', async () => {
    const before = await t.app.inject({ method: 'GET', url: '/healthz' });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toEqual({ ok: true, characters: 0 });
    expect(before.headers['cache-control']).toBe('no-store');

    await put('HTomer', { preset: samplePreset() });
    const after = await t.app.inject({ method: 'GET', url: '/healthz' });
    expect(after.json()).toEqual({ ok: true, characters: 1 });
  });

  it('serves a tiny index at /', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ service: 'maplescouter-cloud' });
  });
});

describe('PUT + GET /v1/characters/:ign', () => {
  it('creates, then updates, and returns the document with an ETag', async () => {
    const created = await put('HTomer', { preset: samplePreset() });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { ign: string; updatedAt: string };
    expect(body.ign).toBe('HTomer');
    expect(body.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(created.headers.etag).toBe(`"${body.updatedAt}"`);

    const fetched = await get('HTomer');
    expect(fetched.statusCode).toBe(200);
    expect(fetched.headers.etag).toBe(`"${body.updatedAt}"`);
    expect(fetched.headers['cache-control']).toBe('no-store');
    const doc = fetched.json();
    expect(doc).toEqual({
      ign: 'HTomer',
      label: 'HTomer',
      createdAt: body.updatedAt,
      updatedAt: body.updatedAt,
      meta: { class: '은월', level: 290, hexaStat: 2, hexaConverted: null },
      preset: samplePreset(),
    });

    const updated = await put('HTomer', { preset: samplePreset({}, { level: '291' }), label: 'Main' });
    expect(updated.statusCode).toBe(200);
    const again = (await get('HTomer')).json() as { createdAt: string; updatedAt: string; label: string; meta: { level: number } };
    expect(again.createdAt).toBe(body.updatedAt);
    expect(again.updatedAt > body.updatedAt).toBe(true);
    expect(again.label).toBe('Main');
    expect(again.meta.level).toBe(291);
  });

  it('keys by lowercased IGN but keeps the display case of the latest write', async () => {
    await put('HTomer', { preset: samplePreset() });
    const lower = await get('htomer');
    expect(lower.statusCode).toBe(200);
    expect((lower.json() as { ign: string }).ign).toBe('HTomer');

    await put('HTOMER', { preset: samplePreset() });
    const list = (await t.app.inject({ method: 'GET', url: '/v1/characters' })).json() as { characters: { ign: string }[] };
    expect(list.characters.map((c) => c.ign)).toEqual(['HTOMER']);
  });

  it('strips unknown preset envelope keys and stores data verbatim', async () => {
    await put('HTomer', { preset: samplePreset({ ign: 'HTomer', junk: true }) });
    const doc = (await get('HTomer')).json() as { preset: Record<string, unknown> };
    expect(doc.preset).not.toHaveProperty('ign');
    expect(doc.preset).not.toHaveProperty('junk');
    expect(doc.preset.data).toEqual(samplePreset().data);
  });

  it('uses client meta only as a fallback', async () => {
    await put('NoHexa', { preset: samplePreset({}, {}, {}), meta: { hexaStat: 3, class: 'ignored', level: 1 } });
    expect((await get('NoHexa')).json()).toMatchObject({ meta: { class: '은월', level: 290, hexaStat: 3, hexaConverted: null } });
    await put('Bare', { preset: samplePreset({}, {}, {}) });
    expect((await get('Bare')).json()).toMatchObject({ meta: { class: '은월', level: 290, hexaStat: null, hexaConverted: null } });
  });

  it('returns 404 for unknown characters', async () => {
    const res = await get('Nobody');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  });

  it('honours If-None-Match with 304', async () => {
    const created = (await put('HTomer', { preset: samplePreset() })).json() as { updatedAt: string };
    const res = await get('HTomer', { 'if-none-match': `"${created.updatedAt}"` });
    expect(res.statusCode).toBe(304);
    expect(res.body).toBe('');
    expect(res.headers.etag).toBe(`"${created.updatedAt}"`);
    const miss = await get('HTomer', { 'if-none-match': '"stale"' });
    expect(miss.statusCode).toBe(200);
  });

  it.each(['x'.repeat(17), 'a%20b', '%EC%9D%80%EC%9B%94', 'a%2Fb', 'a-b', 'a.json', 'a%2e%2e'])('rejects invalid IGN %s with 400', async (ign) => {
    const res = await get(ign);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_ign' });
    const written = await put(ign, { preset: samplePreset() });
    expect(written.statusCode).toBe(400);
    expect(t.store.size()).toBe(0);
  });

  it('never writes outside the characters directory on traversal attempts', async () => {
    for (const ign of ['..%2F..%2Fevil', '%2e%2e%2fevil', '..', '.%2e', '%2e%2e']) {
      const res = await put(ign, { preset: samplePreset() });
      expect([400, 404]).toContain(res.statusCode);
    }
    expect(t.store.size()).toBe(0);
  });

  it.each([
    ['empty object', {}],
    ['preset not object', { preset: 'x' }],
    ['wrong type', { preset: samplePreset({ type: 'nope' }) }],
    ['wrong version', { preset: samplePreset({ v: 2 }) }],
    ['missing stat', { preset: { ...samplePreset(), data: { hexa: {}, doping: {}, linkSkill: {} } } }],
    ['missing myClass', { preset: samplePreset({}, { myClass: undefined }) }],
    ['level 301', { preset: samplePreset({}, { level: '301' }) }],
    ['level text', { preset: samplePreset({}, { level: 'max' }) }],
    ['label not string', { preset: samplePreset(), label: 3 }],
    ['meta not object', { preset: samplePreset(), meta: 'x' }],
  ])('rejects invalid body: %s', async (_name, body) => {
    const res = await put('HTomer', body);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_body', detail: expect.any(String) });
  });

  it('rejects a JSON array body', async () => {
    const res = await put('HTomer', [1, 2]);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_body' });
  });

  it('rejects malformed JSON with 400', async () => {
    const res = await t.app.inject({
      method: 'PUT',
      url: '/v1/characters/HTomer',
      headers: { 'content-type': 'application/json' },
      payload: '{"preset": ',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_json' });
  });

  it('rejects unparseable content types with 415', async () => {
    const res = await t.app.inject({
      method: 'PUT',
      url: '/v1/characters/HTomer',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'preset=hello',
    });
    expect(res.statusCode).toBe(415);
    expect(res.json()).toMatchObject({ error: 'unsupported_media_type' });
  });

  it('rejects a text/plain body as an invalid body', async () => {
    const res = await t.app.inject({
      method: 'PUT',
      url: '/v1/characters/HTomer',
      headers: { 'content-type': 'text/plain' },
      payload: 'hello',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_body' });
  });

  it('enforces the 256 KB body limit with 413', async () => {
    const big = { preset: samplePreset({}, { padding: 'x'.repeat(300 * 1024) }) };
    const res = await put('HTomer', big);
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ error: 'payload_too_large', limit: 256 * 1024 });
    expect(t.store.size()).toBe(0);

    const nearLimit = { preset: samplePreset({}, { padding: 'x'.repeat(200 * 1024) }) };
    expect((await put('HTomer', nearLimit)).statusCode).toBe(201);
  });

  it('implements If-Match conflicts', async () => {
    const preset = samplePreset();
    const onMissing = await put('HTomer', { preset }, { 'if-match': '"anything"' });
    expect(onMissing.statusCode).toBe(409);
    expect(onMissing.json()).toEqual({ error: 'conflict', updatedAt: null });

    const created = (await put('HTomer', { preset })).json() as { updatedAt: string };

    const stale = await put('HTomer', { preset }, { 'if-match': '"2020-01-01T00:00:00.000Z"' });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: 'conflict', updatedAt: created.updatedAt });
    expect((await get('HTomer')).json()).toMatchObject({ updatedAt: created.updatedAt });

    const fresh = await put('HTomer', { preset }, { 'if-match': `"${created.updatedAt}"` });
    expect(fresh.statusCode).toBe(200);
    const next = fresh.json() as { updatedAt: string };
    expect(next.updatedAt > created.updatedAt).toBe(true);

    const weak = await put('HTomer', { preset }, { 'if-match': `W/"${next.updatedAt}"` });
    expect(weak.statusCode).toBe(200);

    const star = await put('HTomer', { preset }, { 'if-match': '*' });
    expect(star.statusCode).toBe(200);
  });
});

describe('HEAD /v1/characters/:ign', () => {
  it('returns the ETag without a body', async () => {
    const created = (await put('HTomer', { preset: samplePreset() })).json() as { updatedAt: string };
    const res = await t.app.inject({ method: 'HEAD', url: '/v1/characters/htomer' });
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBe(`"${created.updatedAt}"`);
    expect(res.body).toBe('');
  });

  it('returns 404 / 400 without a body', async () => {
    const missing = await t.app.inject({ method: 'HEAD', url: '/v1/characters/Nobody' });
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toBe('');
    const bad = await t.app.inject({ method: 'HEAD', url: '/v1/characters/a-b' });
    expect(bad.statusCode).toBe(400);
  });
});

describe('GET /v1/characters', () => {
  it('lists summaries newest first and honours ?limit', async () => {
    await put('First', { preset: samplePreset() });
    await put('Second', { preset: samplePreset({}, { level: '250' }), label: 'Alt' });
    await put('First', { preset: samplePreset() });

    const res = await t.app.inject({ method: 'GET', url: '/v1/characters' });
    expect(res.statusCode).toBe(200);
    const { characters } = res.json() as { characters: Record<string, unknown>[] };
    expect(characters.map((c) => c.ign)).toEqual(['First', 'Second']);
    expect(Object.keys(characters[0]!).sort()).toEqual(['createdAt', 'ign', 'label', 'meta', 'updatedAt']);
    expect(characters[1]).toMatchObject({ label: 'Alt', meta: { class: '은월', level: 250, hexaStat: 2, hexaConverted: null } });

    const limited = (await t.app.inject({ method: 'GET', url: '/v1/characters?limit=1' })).json() as { characters: unknown[] };
    expect(limited.characters).toHaveLength(1);
    const silly = (await t.app.inject({ method: 'GET', url: '/v1/characters?limit=abc' })).json() as { characters: unknown[] };
    expect(silly.characters).toHaveLength(2);
  });
});

describe('DELETE /v1/characters/:ign', () => {
  it('requires a matching X-Confirm header', async () => {
    await put('HTomer', { preset: samplePreset() });

    const none = await t.app.inject({ method: 'DELETE', url: '/v1/characters/HTomer' });
    expect(none.statusCode).toBe(400);
    expect(none.json()).toMatchObject({ error: 'confirm_required' });

    const wrong = await t.app.inject({ method: 'DELETE', url: '/v1/characters/HTomer', headers: { 'x-confirm': 'Other' } });
    expect(wrong.statusCode).toBe(400);
    expect(t.store.size()).toBe(1);

    const ok = await t.app.inject({ method: 'DELETE', url: '/v1/characters/HTomer', headers: { 'x-confirm': 'htomer' } });
    expect(ok.statusCode).toBe(204);
    expect(ok.body).toBe('');
    expect((await get('HTomer')).statusCode).toBe(404);

    const again = await t.app.inject({ method: 'DELETE', url: '/v1/characters/HTomer', headers: { 'x-confirm': 'HTomer' } });
    expect(again.statusCode).toBe(404);
  });

  it('rejects invalid IGNs', async () => {
    const res = await t.app.inject({ method: 'DELETE', url: '/v1/characters/a-b', headers: { 'x-confirm': 'a-b' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_ign' });
  });
});

describe('CORS', () => {
  it('answers preflight from maplescouter.com', async () => {
    const res = await t.app.inject({
      method: 'OPTIONS',
      url: '/v1/characters/HTomer',
      headers: {
        origin: 'https://maplescouter.com',
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'content-type,if-match',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(String(res.headers['access-control-allow-methods'])).toContain('PUT');
    expect(String(res.headers['access-control-allow-methods'])).toContain('DELETE');
    expect(String(res.headers['access-control-allow-headers'])).toContain('If-Match');
    expect(String(res.headers['access-control-allow-headers'])).toContain('X-Confirm');
    expect(res.headers['access-control-max-age']).toBe('86400');
  });

  it('exposes ETag on actual responses', async () => {
    await put('HTomer', { preset: samplePreset() });
    const res = await get('HTomer', { origin: 'https://maplescouter.com' });
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-expose-headers']).toBe('ETag');
  });
});

describe('rate limiting', () => {
  it('limits writes separately from reads', async () => {
    await t.close();
    t = await makeApp({ writeRateLimit: 2 });
    expect((await put('A', { preset: samplePreset() })).statusCode).toBe(201);
    expect((await put('B', { preset: samplePreset() })).statusCode).toBe(201);
    const third = await put('C', { preset: samplePreset() });
    expect(third.statusCode).toBe(429);
    expect(third.json()).toEqual({ error: 'rate_limited' });
    expect(third.headers['retry-after']).toBeDefined();
    expect((await get('A')).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });

  it('limits reads but never healthz or preflight', async () => {
    await t.close();
    t = await makeApp({ readRateLimit: 2 });
    await put('A', { preset: samplePreset() });
    expect((await get('A')).statusCode).toBe(200);
    expect((await get('A')).statusCode).toBe(200);
    expect((await get('A')).statusCode).toBe(429);
    expect((await t.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    const preflight = await t.app.inject({
      method: 'OPTIONS',
      url: '/v1/characters/A',
      headers: { origin: 'https://maplescouter.com', 'access-control-request-method': 'GET' },
    });
    expect(preflight.statusCode).toBe(204);
  });
});

describe('unknown routes', () => {
  it('returns JSON 404', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  });
});

describe('reviewer regressions', () => {
  it('answers HEAD for auto-exposed GET routes (uptime monitors)', async () => {
    for (const url of ['/healthz', '/', '/v1/characters']) {
      const res = await t.app.inject({ method: 'HEAD', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.body).toBe('');
    }
  });

  it('HEAD /v1/characters/:ign sends Content-Length and honours If-None-Match', async () => {
    await put('HTomer', { preset: samplePreset() });
    const full = await get('HTomer');
    const head = await t.app.inject({ method: 'HEAD', url: '/v1/characters/HTomer' });
    expect(head.statusCode).toBe(200);
    expect(head.headers.etag).toBe(full.headers.etag);
    expect(Number(head.headers['content-length'])).toBe(Buffer.byteLength(full.body, 'utf8'));
    const notModified = await t.app.inject({
      method: 'HEAD',
      url: '/v1/characters/HTomer',
      headers: { 'if-none-match': String(full.headers.etag) },
    });
    expect(notModified.statusCode).toBe(304);
  });

  it('keys the rate limiter on CF-Connecting-IP, so a forged X-Forwarded-For cannot dodge it', async () => {
    await t.close();
    t = await makeApp({ writeRateLimit: 2 });
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await put('HTomer', { preset: samplePreset() }, {
        'cf-connecting-ip': '203.0.113.7',
        'x-forwarded-for': `10.0.0.${i}, 172.16.0.1`, // attacker-controlled, must be ignored
      });
      codes.push(res.statusCode);
    }
    expect(codes).toEqual([201, 200, 429]);
    // A different edge-asserted client gets its own bucket.
    const other = await put('Other', { preset: samplePreset() }, { 'cf-connecting-ip': '198.51.100.9' });
    expect(other.statusCode).toBe(201);
  });

  it('falls back to the last X-Forwarded-For hop, then the socket, when CF-Connecting-IP is absent', async () => {
    const { clientIp } = await import('../src/app.js');
    expect(clientIp({ headers: { 'x-forwarded-for': ' 1.1.1.1 , 2.2.2.2 ' }, ip: '9.9.9.9' })).toBe('2.2.2.2');
    expect(clientIp({ headers: {}, ip: '9.9.9.9' })).toBe('9.9.9.9');
    expect(clientIp({ headers: { 'cf-connecting-ip': '8.8.8.8', 'x-forwarded-for': '1.1.1.1' }, ip: '9.9.9.9' })).toBe('8.8.8.8');
  });

  it('keeps serving a document when DELETE cannot unlink the file', async () => {
    await put('HTomer', { preset: samplePreset() });
    const fsp = (await import('node:fs')).promises;
    const spy = vi.spyOn(fsp, 'unlink').mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    try {
      const failed = await t.app.inject({ method: 'DELETE', url: '/v1/characters/HTomer', headers: { 'x-confirm': 'HTomer' } });
      expect(failed.statusCode).toBe(500);
      expect((await get('HTomer')).statusCode).toBe(200); // index intact
      expect((await t.app.inject({ method: 'GET', url: '/healthz' })).json().characters).toBe(1);
    } finally {
      spy.mockRestore();
    }
    const ok = await t.app.inject({ method: 'DELETE', url: '/v1/characters/HTomer', headers: { 'x-confirm': 'HTomer' } });
    expect(ok.statusCode).toBe(204);
    expect((await get('HTomer')).statusCode).toBe(404);
  });
});
