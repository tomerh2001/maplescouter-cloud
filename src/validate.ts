import { PRESET_TYPE, PRESET_VERSION, type CharacterMeta, type Preset } from './types.js';

export const MAX_LABEL_LENGTH = 64;
export const MAX_CLASS_LENGTH = 64;
export const MAX_SAVED_AT_LENGTH = 64;
export const MAX_LEVEL = 300;
export const MAX_HEXA_STAT = 999;
/** userStat sections a manual preset must carry (the site's schema has more; these are the ones we rely on). */
export const REQUIRED_DATA_KEYS = ['stat', 'hexa', 'doping', 'linkSkill'] as const;

export type Validation<T> = { ok: true; value: T } | { ok: false; detail: string };

export interface PutBody {
  preset: Preset;
  label?: string;
  meta?: Partial<CharacterMeta>;
}

const fail = (detail: string): { ok: false; detail: string } => ({ ok: false, detail });

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseSmallInt(raw: unknown, max: number): number | null {
  let n: number;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'string' && /^\s*\d{1,4}\s*$/.test(raw)) n = Number(raw);
  else return null;
  return Number.isInteger(n) && n >= 0 && n <= max ? n : null;
}

/** Level as the site stores it: a numeric string ("290"); plain numbers accepted too. Integer 0..300. */
export function parseLevel(raw: unknown): number | null {
  return parseSmallInt(raw, MAX_LEVEL);
}

/** HEXA stat level: small non-negative integer (number or numeric string). */
export function parseHexaStat(raw: unknown): number | null {
  return parseSmallInt(raw, MAX_HEXA_STAT);
}

export function validatePreset(raw: unknown): Validation<Preset> {
  if (!isPlainObject(raw)) return fail('preset must be an object');
  if (raw.type !== PRESET_TYPE) return fail(`preset.type must be "${PRESET_TYPE}"`);
  if (raw.v !== PRESET_VERSION) return fail(`preset.v must be ${PRESET_VERSION}`);
  if (raw.savedAt !== undefined && (typeof raw.savedAt !== 'string' || raw.savedAt.length > MAX_SAVED_AT_LENGTH)) {
    return fail('preset.savedAt must be a short string');
  }
  if (raw.label !== undefined && (typeof raw.label !== 'string' || raw.label.length > MAX_LABEL_LENGTH)) {
    return fail(`preset.label must be a string of at most ${MAX_LABEL_LENGTH} characters`);
  }

  const data = raw.data;
  if (!isPlainObject(data)) return fail('preset.data must be an object');
  for (const key of REQUIRED_DATA_KEYS) {
    if (!isPlainObject(data[key])) return fail(`preset.data.${key} must be an object`);
  }
  const stat = data.stat as Record<string, unknown>;
  if (typeof stat.myClass !== 'string' || stat.myClass.trim() === '' || stat.myClass.length > MAX_CLASS_LENGTH) {
    return fail('preset.data.stat.myClass must be a non-empty string');
  }
  if (parseLevel(stat.level) === null) {
    return fail(`preset.data.stat.level must be an integer between 0 and ${MAX_LEVEL}`);
  }

  // Rebuild the envelope so unknown top-level keys (e.g. an "ign" added by the export enrichment) are dropped.
  const preset: Preset = { type: PRESET_TYPE, v: PRESET_VERSION, data };
  if (typeof raw.savedAt === 'string') preset.savedAt = raw.savedAt;
  if (typeof raw.label === 'string') preset.label = raw.label;
  return { ok: true, value: preset };
}

function validateMeta(raw: unknown): Validation<Partial<CharacterMeta> | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (!isPlainObject(raw)) return fail('meta must be an object');
  const meta: Partial<CharacterMeta> = {};
  if (raw.class !== undefined && raw.class !== null) {
    if (typeof raw.class !== 'string' || raw.class.length > MAX_CLASS_LENGTH) return fail('meta.class must be a string');
    meta.class = raw.class;
  }
  if (raw.level !== undefined && raw.level !== null) {
    const level = parseLevel(raw.level);
    if (level === null) return fail(`meta.level must be an integer between 0 and ${MAX_LEVEL}`);
    meta.level = level;
  }
  if (raw.hexaStat !== undefined && raw.hexaStat !== null) {
    const hexaStat = parseHexaStat(raw.hexaStat);
    if (hexaStat === null) return fail('meta.hexaStat must be a non-negative integer');
    meta.hexaStat = hexaStat;
  }
  return { ok: true, value: meta };
}

export function validatePutBody(raw: unknown): Validation<PutBody> {
  if (!isPlainObject(raw)) return fail('body must be a JSON object');
  const preset = validatePreset(raw.preset);
  if (!preset.ok) return preset;

  const out: PutBody = { preset: preset.value };
  if (raw.label !== undefined && raw.label !== null) {
    if (typeof raw.label !== 'string') return fail('label must be a string');
    const label = raw.label.trim();
    if (label.length > MAX_LABEL_LENGTH) return fail(`label must be at most ${MAX_LABEL_LENGTH} characters`);
    if (label !== '') out.label = label;
  }
  const meta = validateMeta(raw.meta);
  if (!meta.ok) return meta;
  if (meta.value !== undefined) out.meta = meta.value;
  return { ok: true, value: out };
}

/** Server-derived summary: `preset.data` wins; the client-sent `meta` only fills gaps. */
export function deriveMeta(preset: Preset, client?: Partial<CharacterMeta>): CharacterMeta {
  const stat: Record<string, unknown> = isPlainObject(preset.data.stat) ? preset.data.stat : {};
  const hexa: Record<string, unknown> = isPlainObject(preset.data.hexa) ? preset.data.hexa : {};
  const cls = typeof stat.myClass === 'string' && stat.myClass.trim() !== '' ? stat.myClass : (client?.class ?? '');
  const level = parseLevel(stat.level) ?? client?.level ?? 0;
  const hexaStat = parseHexaStat(hexa.hexaStat) ?? (client?.hexaStat == null ? null : parseHexaStat(client.hexaStat));
  // Only the client knows the converted stat (the site computes it in the browser); accept a finite positive number.
  const hc = client?.hexaConverted;
  const hexaConverted = typeof hc === 'number' && Number.isFinite(hc) && hc > 0 ? Math.round(hc) : null;
  return { class: cls, level, hexaStat, hexaConverted };
}
