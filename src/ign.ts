/** Display-form IGN: 1-16 ASCII letters or digits (GMS naming rules; no spaces or symbols). */
export const IGN_RE = /^[A-Za-z0-9]{1,16}$/;
/** Storage key: the IGN lowercased. Doubles as the on-disk file stem. */
export const KEY_RE = /^[a-z0-9]{1,16}$/;

export interface ParsedIgn {
  /** IGN exactly as the client wrote it (display case preserved). */
  ign: string;
  /** Lowercased lookup key. */
  key: string;
}

export function parseIgn(raw: unknown): ParsedIgn | null {
  if (typeof raw !== 'string' || !IGN_RE.test(raw)) return null;
  return { ign: raw, key: raw.toLowerCase() };
}

export function isKey(raw: unknown): raw is string {
  return typeof raw === 'string' && KEY_RE.test(raw);
}
