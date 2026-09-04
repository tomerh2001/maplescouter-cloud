import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AvatarService, AVATAR_FILE, AVATAR_USER_AGENT, pickRank, type Avatar, type FetchImpl } from '../src/avatar.js';
import { makeApp, silentLogger, tempDir, type TestApp } from './helpers.js';

const UPSTREAM = 'http://nexon.test/ranking';

function rank(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    characterID: 0,
    characterName: name,
    exp: 1,
    level: 291,
    rank: 5013,
    worldID: 1,
    characterImgURL: `https://msavatar1.nexon.net/Character/${name}.png`,
    jobName: 'Shade',
    jobDetail: null,
    legionLevel: 0,
    ...overrides,
  };
}

function board(ranks: Record<string, unknown>[]): unknown {
  return { totalCount: ranks.length, ranks };
}

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** Stub upstream: `boards[i]` is what reboot_index=i answers (a body, or an Error to throw). */
function nexonStub(boards: Record<number, unknown>) {
  return vi.fn<FetchImpl>(async (url) => {
    const parsed = new URL(url);
    const index = Number(parsed.searchParams.get('reboot_index'));
    const answer = boards[index];
    if (answer instanceof Error) throw answer;
    if (answer === undefined) return json({ error: 'no such board' }, 500);
    return json(answer);
  });
}

const apps: TestApp[] = [];
async function app(fetchImpl: FetchImpl, overrides: Record<string, unknown> = {}, dir?: string): Promise<TestApp> {
  const t = await makeApp({ avatarUpstream: UPSTREAM, ...overrides }, { fetchImpl, dir });
  apps.push(t);
  return t;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((t) => t.close()));
});

const get = (t: TestApp, ign: string) => t.app.inject({ method: 'GET', url: `/v1/avatar/${ign}` });

describe('GET /v1/avatar/:ign', () => {
  it('returns the character look from board 0 with a public cache header', async () => {
    const fetchImpl = nexonStub({ 0: board([rank('HTomer')]) });
    const t = await app(fetchImpl);
    const res = await get(t, 'HTomer');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
    const body = res.json() as Avatar;
    expect(body).toEqual({
      ign: 'HTomer',
      level: 291,
      job: 'Shade',
      worldId: 1,
      image: 'https://msavatar1.nexon.net/Character/HTomer.png',
      fetchedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) as string,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${UPSTREAM}?type=overall&id=weekly&reboot_index=0&page_index=1&character_name=HTomer`);
    expect(init.headers['user-agent']).toBe(AVATAR_USER_AGENT);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('falls through to board 1 when board 0 has no such character', async () => {
    const fetchImpl = nexonStub({ 0: board([]), 1: board([rank('Kronos', { worldID: 45, jobName: 'Hero' })]) });
    const t = await app(fetchImpl);
    const res = await get(t, 'kronos');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ign: 'Kronos', worldId: 45, job: 'Hero' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.map(([url]) => new URL(url).searchParams.get('reboot_index'))).toEqual(['0', '1']);
  });

  it('answers 404 not_found when both boards are empty, and caches the miss', async () => {
    const fetchImpl = nexonStub({ 0: board([]), 1: board([]) });
    const t = await app(fetchImpl);
    const res = await get(t, 'zzzzqqqq1234');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const again = await get(t, 'zzzzqqqq1234');
    expect(again.statusCode).toBe(404);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('ignores rank rows whose name is not the one asked for', async () => {
    const fetchImpl = nexonStub({ 0: board([rank('HTomer2')]), 1: board([rank('Other')]) });
    const t = await app(fetchImpl);
    expect((await get(t, 'HTomer')).statusCode).toBe(404);
  });

  it('answers 502 upstream when Nexon fails and nothing is cached, without caching the failure', async () => {
    const fetchImpl = nexonStub({ 0: new Error('socket hang up') });
    const t = await app(fetchImpl);
    const res = await get(t, 'HTomer');
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'upstream' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const retry = await get(t, 'HTomer');
    expect(retry.statusCode).toBe(502);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('treats a non-200 or malformed upstream answer as an upstream failure', async () => {
    const t1 = await app(vi.fn<FetchImpl>(async () => json({ ranks: [] }, 503)));
    expect((await get(t1, 'HTomer')).statusCode).toBe(502);

    const t2 = await app(vi.fn<FetchImpl>(async () => json({ nope: true })));
    expect((await get(t2, 'HTomer')).statusCode).toBe(502);

    const t3 = await app(vi.fn<FetchImpl>(async () => json(board([rank('HTomer', { characterImgURL: 42 })]))));
    expect((await get(t3, 'HTomer')).statusCode).toBe(502);
  });

  it('serves repeat and differently-cased requests from the cache (one upstream call)', async () => {
    const fetchImpl = nexonStub({ 0: board([rank('HTomer')]) });
    const t = await app(fetchImpl);
    const first = (await get(t, 'HTomer')).json();
    expect((await get(t, 'HTomer')).json()).toEqual(first);
    expect((await get(t, 'htomer')).json()).toEqual(first);
    expect((await get(t, 'HTOMER')).json()).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refetches after the hit TTL and serves the stale entry when the refetch fails', async () => {
    const boards: Record<number, unknown> = { 0: board([rank('HTomer')]) };
    const fetchImpl = nexonStub(boards);
    const t = await app(fetchImpl, { avatarHitTtlMs: 1 });
    const first = (await get(t, 'HTomer')).json();
    await sleep(5);

    boards[0] = new Error('down');
    const stale = await get(t, 'HTomer');
    expect(stale.statusCode).toBe(200);
    expect(stale.json()).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    boards[0] = board([rank('HTomer', { level: 292 })]);
    const fresh = await get(t, 'HTomer');
    expect(fresh.statusCode).toBe(200);
    expect((fresh.json() as Avatar).level).toBe(292);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('refetches a miss after the miss TTL', async () => {
    const boards: Record<number, unknown> = { 0: board([]), 1: board([]) };
    const fetchImpl = nexonStub(boards);
    const t = await app(fetchImpl, { avatarMissTtlMs: 1 });
    expect((await get(t, 'NewChar')).statusCode).toBe(404);
    await sleep(5);
    boards[0] = board([rank('NewChar')]);
    expect((await get(t, 'NewChar')).statusCode).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('rejects invalid IGNs with 400 invalid_ign before touching upstream', async () => {
    const fetchImpl = nexonStub({});
    const t = await app(fetchImpl);
    for (const bad of ['bad-ign', 'a'.repeat(17), 'sp%20ace', '%EC%9D%80%EC%9B%94']) {
      const res = await get(t, bad);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid_ign' });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('dedupes concurrent look-ups of one IGN into a single upstream call', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = vi.fn<FetchImpl>(async () => {
      await gate;
      return json(board([rank('HTomer')]));
    });
    const t = await app(fetchImpl);
    const pending = [get(t, 'HTomer'), get(t, 'htomer'), get(t, 'HTOMER')];
    await sleep(5);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    release!();
    const results = await Promise.all(pending);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('persists hits to avatars.json and serves them after a restart without refetching', async () => {
    const dir = await tempDir();
    const first = nexonStub({ 0: board([rank('HTomer')]) });
    const t1 = await app(first, {}, dir);
    const body = (await get(t1, 'HTomer')).json();
    await t1.close();

    const file = JSON.parse(await readFile(path.join(dir, AVATAR_FILE), 'utf8')) as {
      v: number;
      avatars: { key: string; avatar: Avatar; expiresAt: number }[];
    };
    expect(file.v).toBe(1);
    expect(file.avatars).toHaveLength(1);
    expect(file.avatars[0]).toMatchObject({ key: 'htomer', avatar: body });
    expect(file.avatars[0]!.expiresAt).toBeGreaterThan(Date.now());

    const second = nexonStub({ 0: new Error('must not be called') });
    const t2 = await app(second, {}, dir);
    const res = await get(t2, 'HTomer');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(body);
    expect(second).not.toHaveBeenCalled();
  });

  it('does not persist misses', async () => {
    const dir = await tempDir();
    const t1 = await app(nexonStub({ 0: board([]), 1: board([]) }), {}, dir);
    expect((await get(t1, 'Nobody')).statusCode).toBe(404);
    await t1.close();
    await expect(readFile(path.join(dir, AVATAR_FILE), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('boots with an empty cache when avatars.json is corrupt', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, AVATAR_FILE), '{not json', 'utf8');
    const fetchImpl = nexonStub({ 0: board([rank('HTomer')]) });
    const t = await app(fetchImpl, {}, dir);
    expect((await get(t, 'HTomer')).statusCode).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('is listed in the root endpoints', async () => {
    const t = await app(nexonStub({}));
    const res = await t.app.inject({ method: 'GET', url: '/' });
    expect((res.json() as { endpoints: string[] }).endpoints).toContain('GET /v1/avatar/:ign');
  });
});

describe('AvatarService', () => {
  it('aborts an upstream call that exceeds the timeout and reports an error', async () => {
    const fetchImpl = vi.fn<FetchImpl>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const service = await AvatarService.open({ dataDir: await tempDir(), fetchImpl, timeoutMs: 10, log: silentLogger });
    const result = await service.lookup('HTomer');
    expect(result).toEqual({ status: 'error' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(service.pending()).toBe(0);
  });

  it('caps the cache and drops the oldest entries first', async () => {
    const fetchImpl = vi.fn<FetchImpl>(async (url) => {
      const name = new URL(url).searchParams.get('character_name')!;
      return json(board([rank(name)]));
    });
    const dir = await tempDir();
    const service = await AvatarService.open({ dataDir: dir, fetchImpl, maxEntries: 2, log: silentLogger });
    await service.lookup('One');
    await service.lookup('Two');
    await service.lookup('One'); // still fresh: no refetch, keeps its age
    await service.lookup('Three');
    expect(service.size()).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    await service.lookup('One'); // evicted, so this refetches
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    await service.flush();
    const file = JSON.parse(await readFile(path.join(dir, AVATAR_FILE), 'utf8')) as { avatars: { key: string }[] };
    expect(file.avatars.map((e) => e.key)).toEqual(['three', 'one']);
  });

  it('uses the injected clock for expiry', async () => {
    let now = 1_000_000;
    const fetchImpl = nexonStub({ 0: board([rank('HTomer')]) });
    const service = await AvatarService.open({
      dataDir: await tempDir(),
      fetchImpl,
      hitTtlMs: 100,
      now: () => now,
      log: silentLogger,
    });
    const first = await service.lookup('HTomer');
    expect(first).toMatchObject({ status: 'hit', stale: false });
    now += 99;
    expect(await service.lookup('HTomer')).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now += 2;
    await service.lookup('HTomer');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws on an invalid IGN instead of calling upstream', async () => {
    const fetchImpl = nexonStub({});
    const service = await AvatarService.open({ dataDir: await tempDir(), fetchImpl, log: silentLogger });
    expect(() => service.lookup('not valid!')).toThrow(/invalid ign/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('pickRank', () => {
  it('maps a Nexon rank row to the response shape', () => {
    expect(pickRank(board([rank('HTomer')]), 'htomer', '2026-09-04T00:00:00.000Z')).toEqual({
      ign: 'HTomer',
      level: 291,
      job: 'Shade',
      worldId: 1,
      image: 'https://msavatar1.nexon.net/Character/HTomer.png',
      fetchedAt: '2026-09-04T00:00:00.000Z',
    });
  });

  it('returns null for an empty board and throws on a malformed body', () => {
    expect(pickRank(board([]), 'htomer', 'x')).toBeNull();
    expect(() => pickRank(null, 'htomer', 'x')).toThrow();
    expect(() => pickRank({ totalCount: 1 }, 'htomer', 'x')).toThrow();
  });
});
