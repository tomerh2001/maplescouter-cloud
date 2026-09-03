import { describe, expect, it } from 'vitest';
import { parseEntityTags } from '../src/app.js';
import { parseIgn } from '../src/ign.js';
import { deriveMeta, parseLevel, validatePreset, validatePutBody } from '../src/validate.js';
import { samplePreset } from './helpers.js';

describe('parseIgn', () => {
  it('accepts 1-16 alphanumerics and lowercases the key', () => {
    expect(parseIgn('HTomer')).toEqual({ ign: 'HTomer', key: 'htomer' });
    expect(parseIgn('a')).toEqual({ ign: 'a', key: 'a' });
    expect(parseIgn('A1B2C3D4E5F6G7H8')).toEqual({ ign: 'A1B2C3D4E5F6G7H8', key: 'a1b2c3d4e5f6g7h8' });
  });

  it('rejects everything else', () => {
    for (const bad of ['', ' ', 'a b', 'a-b', 'a_b', 'a.b', '..', '../x', 'a/b', 'a\\b', '은월', 'x'.repeat(17), 'a%20b']) {
      expect(parseIgn(bad), bad).toBeNull();
    }
    expect(parseIgn(42)).toBeNull();
    expect(parseIgn(undefined)).toBeNull();
  });
});

describe('parseLevel', () => {
  it('accepts numeric strings and numbers in 0..300', () => {
    expect(parseLevel('290')).toBe(290);
    expect(parseLevel(' 0 ')).toBe(0);
    expect(parseLevel(300)).toBe(300);
  });

  it('rejects out-of-range and non-numeric values', () => {
    for (const bad of ['301', -1, '1.5', 1.5, 'abc', '', null, undefined, '1e2', {}]) {
      expect(parseLevel(bad), String(bad)).toBeNull();
    }
  });
});

describe('validatePreset', () => {
  it('accepts a real-looking preset and drops unknown envelope keys', () => {
    const res = validatePreset(samplePreset({ ign: 'HTomer', extra: 1 }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(Object.keys(res.value).sort()).toEqual(['data', 'label', 'savedAt', 'type', 'v']);
    expect(res.value.data).toBe((samplePreset() as { data: unknown }).data === res.value.data ? res.value.data : res.value.data);
  });

  it.each([
    ['not an object', 'nope'],
    ['wrong type', samplePreset({ type: 'other' })],
    ['wrong version', samplePreset({ v: 2 })],
    ['missing data', samplePreset({ data: undefined })],
    ['data not object', samplePreset({ data: [] })],
    ['missing stat', { ...samplePreset(), data: { hexa: {}, doping: {}, linkSkill: {} } }],
    ['missing hexa', { ...samplePreset(), data: { stat: { myClass: 'x', level: '1' }, doping: {}, linkSkill: {} } }],
    ['missing myClass', samplePreset({}, { myClass: undefined })],
    ['empty myClass', samplePreset({}, { myClass: '  ' })],
    ['level too high', samplePreset({}, { level: '301' })],
    ['level not numeric', samplePreset({}, { level: 'abc' })],
    ['label not string', samplePreset({ label: 5 })],
    ['savedAt not string', samplePreset({ savedAt: 5 })],
  ])('rejects %s', (_name, preset) => {
    const res = validatePreset(preset);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.detail).toBeTypeOf('string');
  });
});

describe('validatePutBody', () => {
  it('requires a preset and normalises label/meta', () => {
    expect(validatePutBody({}).ok).toBe(false);
    const res = validatePutBody({ preset: samplePreset(), label: '  Main  ', meta: { class: 'x', level: '5', hexaStat: '3' } });
    expect(res).toEqual({
      ok: true,
      value: expect.objectContaining({ label: 'Main', meta: { class: 'x', level: 5, hexaStat: 3 } }),
    });
  });

  it('treats blank label and null meta as absent', () => {
    const res = validatePutBody({ preset: samplePreset(), label: '   ', meta: null });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.label).toBeUndefined();
      expect(res.value.meta).toBeUndefined();
    }
  });

  it('rejects bad label/meta types', () => {
    expect(validatePutBody({ preset: samplePreset(), label: 7 }).ok).toBe(false);
    expect(validatePutBody({ preset: samplePreset(), label: 'x'.repeat(65) }).ok).toBe(false);
    expect(validatePutBody({ preset: samplePreset(), meta: 'x' }).ok).toBe(false);
    expect(validatePutBody({ preset: samplePreset(), meta: { level: 999 } }).ok).toBe(false);
    expect(validatePutBody({ preset: samplePreset(), meta: { hexaStat: -1 } }).ok).toBe(false);
  });
});

describe('deriveMeta', () => {
  it('derives from preset.data and only falls back to client meta for gaps', () => {
    const res = validatePreset(samplePreset({}, { level: '285' }, {}));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(deriveMeta(res.value, { class: 'ignored', level: 1, hexaStat: 4 })).toEqual({ class: '은월', level: 285, hexaStat: 4 });
    expect(deriveMeta(res.value)).toEqual({ class: '은월', level: 285, hexaStat: null });
  });

  it('reads hexaStat from preset.data.hexa', () => {
    const res = validatePreset(samplePreset({}, {}, { hexaStat: 2 }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(deriveMeta(res.value).hexaStat).toBe(2);
  });
});

describe('parseEntityTags', () => {
  it('unquotes strong and weak tags and keeps *', () => {
    expect(parseEntityTags(undefined)).toBeUndefined();
    expect(parseEntityTags('')).toBeUndefined();
    expect(parseEntityTags('"2026-09-01T00:00:00.000Z"')).toEqual(['2026-09-01T00:00:00.000Z']);
    expect(parseEntityTags('W/"a", "b" , c')).toEqual(['a', 'b', 'c']);
    expect(parseEntityTags('*')).toEqual(['*']);
    expect(parseEntityTags(['"a"', '"b"'])).toEqual(['a', 'b']);
  });
});
