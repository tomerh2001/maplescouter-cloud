import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CharacterStore, InvalidKeyError, nextTimestamp } from '../src/store.js';
import type { CharacterInput } from '../src/types.js';
import { samplePreset, silentLogger, tempDir } from './helpers.js';

function input(ign: string, extra: Partial<CharacterInput> = {}): CharacterInput {
  return {
    ign,
    label: ign,
    meta: { class: '은월', level: 290, hexaStat: 2 },
    preset: samplePreset() as unknown as CharacterInput['preset'],
    ...extra,
  };
}

let dir: string;
let store: CharacterStore;

beforeEach(async () => {
  dir = await tempDir();
  store = await CharacterStore.open(dir, silentLogger);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('nextTimestamp', () => {
  it('bumps by 1 ms when the clock has not moved past the previous value', () => {
    const now = new Date('2026-09-01T00:00:00.000Z');
    expect(nextTimestamp(undefined, now)).toBe('2026-09-01T00:00:00.000Z');
    expect(nextTimestamp('2026-09-01T00:00:00.000Z', now)).toBe('2026-09-01T00:00:00.001Z');
    expect(nextTimestamp('2026-09-01T00:00:05.000Z', now)).toBe('2026-09-01T00:00:05.001Z');
    expect(nextTimestamp('2020-01-01T00:00:00.000Z', now)).toBe('2026-09-01T00:00:00.000Z');
  });
});

describe('CharacterStore', () => {
  it('starts empty and creates the characters directory', async () => {
    expect(store.size()).toBe(0);
    expect(store.list()).toEqual([]);
    expect(store.directory).toBe(path.join(dir, 'characters'));
    expect(await readdir(store.directory)).toEqual([]);
  });

  it('writes one atomic json file per key and leaves no temp files', async () => {
    const res = await store.put('htomer', input('HTomer'));
    expect(res.status).toBe('created');
    if (res.status === 'conflict') return;
    expect(res.doc.createdAt).toBe(res.doc.updatedAt);

    const files = await readdir(store.directory);
    expect(files).toEqual(['htomer.json']);
    const onDisk = JSON.parse(await readFile(path.join(store.directory, 'htomer.json'), 'utf8'));
    expect(onDisk).toEqual(res.doc);
    expect(await store.get('htomer')).toEqual(res.doc);
    expect(store.has('htomer')).toBe(true);
    expect(store.summary('htomer')).toEqual({
      ign: 'HTomer',
      label: 'HTomer',
      meta: { class: '은월', level: 290, hexaStat: 2 },
      createdAt: res.doc.createdAt,
      updatedAt: res.doc.updatedAt,
    });
  });

  it('updates in place, preserving createdAt and advancing updatedAt', async () => {
    const first = await store.put('htomer', input('HTomer'));
    const second = await store.put('htomer', input('HTOMER', { label: 'renamed' }));
    expect(first.status).toBe('created');
    expect(second.status).toBe('updated');
    if (first.status === 'conflict' || second.status === 'conflict') return;
    expect(second.doc.createdAt).toBe(first.doc.createdAt);
    expect(second.doc.updatedAt > first.doc.updatedAt).toBe(true);
    expect(second.doc.ign).toBe('HTOMER');
    expect(second.doc.label).toBe('renamed');
    expect(store.size()).toBe(1);
    expect(await readdir(store.directory)).toEqual(['htomer.json']);
  });

  it('lists newest first and caps the result', async () => {
    await store.put('aaa', input('aaa'));
    await store.put('bbb', input('bbb'));
    await store.put('ccc', input('ccc'));
    await store.put('aaa', input('aaa'));
    expect(store.list().map((s) => s.ign)).toEqual(['aaa', 'ccc', 'bbb']);
    expect(store.list(2).map((s) => s.ign)).toEqual(['aaa', 'ccc']);
    expect(store.list(9999)).toHaveLength(3);
    expect(store.list()[0]).not.toHaveProperty('preset');
  });

  it('returns copies from the index so callers cannot mutate it', async () => {
    await store.put('aaa', input('aaa'));
    const s = store.summary('aaa');
    if (s) s.meta.level = 1;
    expect(store.summary('aaa')?.meta.level).toBe(290);
    store.list()[0]!.meta.level = 2;
    expect(store.list()[0]!.meta.level).toBe(290);
  });

  it('deletes and reports whether anything was removed', async () => {
    await store.put('aaa', input('aaa'));
    expect(await store.delete('aaa')).toBe(true);
    expect(await store.get('aaa')).toBeUndefined();
    expect(store.size()).toBe(0);
    expect(await readdir(store.directory)).toEqual([]);
    expect(await store.delete('aaa')).toBe(false);
    expect(await store.get('nobody')).toBeUndefined();
  });

  it('honours If-Match tags', async () => {
    const missing = await store.put('aaa', input('aaa'), { ifMatch: ['whatever'] });
    expect(missing).toEqual({ status: 'conflict', updatedAt: null });

    const created = await store.put('aaa', input('aaa'));
    if (created.status === 'conflict') throw new Error('unexpected conflict');
    const tag = created.doc.updatedAt;

    const stale = await store.put('aaa', input('aaa'), { ifMatch: ['stale'] });
    expect(stale).toEqual({ status: 'conflict', updatedAt: tag });

    const ok = await store.put('aaa', input('aaa'), { ifMatch: ['other', tag] });
    expect(ok.status).toBe('updated');

    const star = await store.put('aaa', input('aaa'), { ifMatch: ['*'] });
    expect(star.status).toBe('updated');
  });

  it('rejects keys that are not lowercase alphanumerics (no traversal)', async () => {
    for (const bad of ['../x', 'HTomer', '', 'a'.repeat(17), 'a/b', 'a\\b', '..', '.', 'a.json', 'a b']) {
      await expect(store.get(bad), bad).rejects.toBeInstanceOf(InvalidKeyError);
      await expect(store.put(bad, input('x')), bad).rejects.toBeInstanceOf(InvalidKeyError);
      await expect(store.delete(bad), bad).rejects.toBeInstanceOf(InvalidKeyError);
    }
    expect(await readdir(store.directory)).toEqual([]);
    expect(await readdir(dir)).toEqual(['characters']);
  });

  it('rebuilds the index on open, skipping junk and cleaning temp files', async () => {
    await store.put('good', input('Good'));
    await store.put('other', input('Other'));
    await writeFile(path.join(store.directory, 'broken.json'), '{not json', 'utf8');
    await writeFile(path.join(store.directory, 'Bad Name.json'), '{}', 'utf8');
    await writeFile(path.join(store.directory, 'notes.txt'), 'hi', 'utf8');
    await writeFile(path.join(store.directory, '.good.123.deadbeef.tmp'), '{}', 'utf8');
    await writeFile(
      path.join(store.directory, 'mismatch.json'),
      JSON.stringify({ ign: 'Someone', label: 'x', createdAt: 'a', updatedAt: 'b', meta: {}, preset: {} }),
      'utf8',
    );

    const reopened = await CharacterStore.open(dir, silentLogger);
    expect(reopened.list().map((s) => s.ign)).toEqual(['Other', 'Good']);
    expect(reopened.list()).toEqual(store.list());
    const files = (await readdir(store.directory)).sort();
    expect(files).not.toContain('.good.123.deadbeef.tmp');
    expect(files).toContain('broken.json');
    expect(await reopened.get('good')).toEqual(await store.get('good'));
  });

  it('serialises concurrent writes to the same key', async () => {
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => store.put('race', input(`Race${i}`))));
    const stamps = results.map((r) => (r.status === 'conflict' ? 'conflict' : r.doc.updatedAt));
    expect(stamps).not.toContain('conflict');
    expect(new Set(stamps).size).toBe(25);
    expect([...stamps].sort()).toEqual(stamps);
    expect(results.filter((r) => r.status === 'created')).toHaveLength(1);

    const files = await readdir(store.directory);
    expect(files).toEqual(['race.json']);
    const doc = await store.get('race');
    expect(doc?.updatedAt).toBe(stamps[24]);
    expect(doc?.ign).toBe('Race24');
  });
});
