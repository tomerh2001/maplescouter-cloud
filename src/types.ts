/** Preset envelope exported by maplescouter.com's Manual Input page. */
export const PRESET_TYPE = 'maplescouter-manual-preset' as const;
export const PRESET_VERSION = 1 as const;

export interface Preset {
  type: typeof PRESET_TYPE;
  v: typeof PRESET_VERSION;
  /** ISO timestamp set by the site when the slot was saved. */
  savedAt?: string;
  /** Slot label on the site. */
  label?: string;
  /** The site's full `userStat` object (stat, hexa, doping, linkSkill, ...). Stored verbatim. */
  data: Record<string, unknown>;
}

/** Summary derived server-side from `preset.data` (client `meta` only fills gaps). */
export interface CharacterMeta {
  /** Korean class name as the site stores it, e.g. "은월". */
  class: string;
  level: number;
  hexaStat: number | null;
}

export interface CharacterDoc {
  /** IGN with the display case the client used. */
  ign: string;
  label: string;
  createdAt: string;
  updatedAt: string;
  meta: CharacterMeta;
  preset: Preset;
}

export type CharacterSummary = Pick<CharacterDoc, 'ign' | 'label' | 'meta' | 'updatedAt' | 'createdAt'>;

/** What a PUT contributes; the store adds the timestamps. */
export interface CharacterInput {
  ign: string;
  label: string;
  meta: CharacterMeta;
  preset: Preset;
}
