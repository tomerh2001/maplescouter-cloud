import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Logger } from 'pino';
import { KEY_RE } from './ign.js';

/** Nexon's public GMS ranking API (no auth, no CORS: the browser cannot call it, so this service proxies it). */
export const DEFAULT_AVATAR_UPSTREAM = 'https://www.nexon.com/api/maplestory/no-auth/ranking/v2/na';
export const AVATAR_USER_AGENT =
  'Mozilla/5.0 (compatible; maplescouter-cloud/1.0; +https://github.com/tomerh2001/maplescouter-cloud)';
export const AVATAR_FILE = 'avatars.json';
export const DEFAULT_AVATAR_HIT_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_AVATAR_MISS_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_AVATAR_MAX_ENTRIES = 20_000;
/** How long an expired hit is kept for stale-on-error before it is dropped from memory and the file. */
export const AVATAR_STALE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_AVATAR_TIMEOUT_MS = 8_000;
/** Ranking boards to query, in order: 0 = regular worlds, 1 = Heroic (Reboot) worlds. */
const BOARDS = [0, 1] as const;

/** What GET /v1/avatar/:ign returns. */
export interface Avatar {
  /** IGN as Nexon spells it. */
  ign: string;
  level: number;
  job: string;
  worldId: number;
  /** PNG served by msavatar*.nexon.net, 96x96. */
  image: string;
  fetchedAt: string;
}

export type AvatarLookup =
  | { status: 'hit'; avatar: Avatar; stale: boolean }
  | { status: 'miss' }
  | { status: 'error' };

/** The subset of `fetch` the service needs; `globalThis.fetch` satisfies it, and tests stub it. */
export interface UpstreamResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type FetchImpl = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<UpstreamResponse>;

type AvatarLogger = Pick<Logger, 'info' | 'warn' | 'error' | 'debug'>;

export interface AvatarServiceOptions {
  dataDir: string;
  fetchImpl?: FetchImpl;
  upstream?: string;
  hitTtlMs?: number;
  missTtlMs?: number;
  maxEntries?: number;
  timeoutMs?: number;
  log?: AvatarLogger;
  /** Clock, injectable for tests. */
  now?: () => number;
}

interface CacheEntry {
  /** null = a cached miss (both boards returned no such character). */
  avatar: Avatar | null;
  expiresAt: number;
}

interface PersistedEntry {
  key: string;
  avatar: Avatar;
  expiresAt: number;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === 'object' && err !== null && 'code' in err;
}

function isAvatar(v: unknown): v is Avatar {
  if (typeof v !== 'object' || v === null) return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a.ign === 'string' &&
    typeof a.level === 'number' &&
    typeof a.job === 'string' &&
    typeof a.worldId === 'number' &&
    typeof a.image === 'string' &&
    typeof a.fetchedAt === 'string'
  );
}

function isPersistedEntry(v: unknown): v is PersistedEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e.key === 'string' && KEY_RE.test(e.key) && isAvatar(e.avatar) && typeof e.expiresAt === 'number';
}

/**
 * Turn one ranking response into an Avatar for `key`, or null when the board has no such character.
 * Throws when the body is not shaped like a ranking response (treated as an upstream failure).
 */
export function pickRank(body: unknown, key: string, fetchedAt: string): Avatar | null {
  if (typeof body !== 'object' || body === null) throw new Error('upstream body is not an object');
  const ranks = (body as { ranks?: unknown }).ranks;
  if (!Array.isArray(ranks)) throw new Error('upstream body has no ranks array');
  for (const rank of ranks as unknown[]) {
    if (typeof rank !== 'object' || rank === null) continue;
    const r = rank as Record<string, unknown>;
    if (typeof r.characterName !== 'string' || r.characterName.toLowerCase() !== key) continue;
    if (
      typeof r.level !== 'number' ||
      typeof r.jobName !== 'string' ||
      typeof r.worldID !== 'number' ||
      typeof r.characterImgURL !== 'string' ||
      !/^https?:\/\//.test(r.characterImgURL)
    ) {
      throw new Error('upstream rank entry is malformed');
    }
    return {
      ign: r.characterName,
      level: r.level,
      job: r.jobName,
      worldId: r.worldID,
      image: r.characterImgURL,
      fetchedAt,
    };
  }
  return null;
}

/**
 * Character look-up on Nexon's ranking API with an in-memory cache (hits 24 h, misses 1 h by default).
 * Hits are persisted to `<dataDir>/avatars.json` (temp file + fsync + rename) and loaded on boot so a
 * restart does not refetch. Concurrent look-ups of one IGN share a single upstream call. When Nexon fails
 * and a stale hit exists, the stale hit is served. Expired hits older than `AVATAR_STALE_GRACE_MS` are dropped
 * whenever the file is written or loaded. The cache is capped; the oldest entries are dropped.
 */
export class AvatarService {
  readonly file: string;
  readonly hitTtlMs: number;
  readonly missTtlMs: number;
  readonly maxEntries: number;
  readonly timeoutMs: number;
  private readonly upstream: string;
  private readonly fetchImpl: FetchImpl;
  private readonly log: AvatarLogger | undefined;
  private readonly now: () => number;
  /** Insertion order = age: refreshed entries are re-inserted at the end, eviction drops from the front. */
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<AvatarLookup>>();
  private dirty = false;
  private writing: Promise<void> | null = null;

  private constructor(opts: AvatarServiceOptions) {
    this.file = path.join(path.resolve(opts.dataDir), AVATAR_FILE);
    this.upstream = opts.upstream ?? DEFAULT_AVATAR_UPSTREAM;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchImpl);
    this.hitTtlMs = opts.hitTtlMs ?? DEFAULT_AVATAR_HIT_TTL_MS;
    this.missTtlMs = opts.missTtlMs ?? DEFAULT_AVATAR_MISS_TTL_MS;
    this.maxEntries = opts.maxEntries ?? DEFAULT_AVATAR_MAX_ENTRIES;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_AVATAR_TIMEOUT_MS;
    this.log = opts.log;
    this.now = opts.now ?? Date.now;
  }

  static async open(opts: AvatarServiceOptions): Promise<AvatarService> {
    const service = new AvatarService(opts);
    await fs.mkdir(path.dirname(service.file), { recursive: true });
    await service.load();
    return service;
  }

  /** Cached entries (hits and misses). */
  size(): number {
    return this.cache.size;
  }

  /** Number of look-ups currently waiting on Nexon. */
  pending(): number {
    return this.inflight.size;
  }

  /**
   * Look a character up. `ign` may carry any case; the cache is keyed by the lowercase form.
   * Never rejects for upstream trouble (that is `status: 'error'`); only an invalid IGN throws.
   */
  lookup(ign: string): Promise<AvatarLookup> {
    const key = ign.toLowerCase();
    if (!KEY_RE.test(key)) throw new Error(`invalid ign: ${JSON.stringify(ign)}`);
    const entry = this.cache.get(key);
    if (entry !== undefined && entry.expiresAt > this.now()) {
      return Promise.resolve(entry.avatar === null ? { status: 'miss' } : { status: 'hit', avatar: entry.avatar, stale: false });
    }
    const pending = this.inflight.get(key);
    if (pending !== undefined) return pending;
    const run = this.refresh(ign, key, entry).finally(() => {
      if (this.inflight.get(key) === run) this.inflight.delete(key);
    });
    this.inflight.set(key, run);
    return run;
  }

  /** Wait for any pending cache file write to finish. */
  async flush(): Promise<void> {
    while (this.writing !== null) await this.writing;
  }

  private async refresh(ign: string, key: string, stale: CacheEntry | undefined): Promise<AvatarLookup> {
    let found: Avatar | null;
    try {
      found = await this.fetchUpstream(ign, key);
    } catch (err) {
      // No IGN in the log line: request logs never carry it either.
      this.log?.warn({ err, stale: stale?.avatar !== null && stale !== undefined }, 'avatar lookup failed upstream');
      if (stale !== undefined && stale.avatar !== null) return { status: 'hit', avatar: stale.avatar, stale: true };
      return { status: 'error' };
    }
    this.set(key, found);
    return found === null ? { status: 'miss' } : { status: 'hit', avatar: found, stale: false };
  }

  private set(key: string, avatar: Avatar | null): void {
    const previous = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, { avatar, expiresAt: this.now() + (avatar === null ? this.missTtlMs : this.hitTtlMs) });
    let evictedHit = false;
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      if (this.cache.get(oldest)?.avatar !== null) evictedHit = true;
      this.cache.delete(oldest);
    }
    // The file only holds hits: rewrite it when a hit was added, replaced, or dropped.
    if (avatar !== null || previous?.avatar != null || evictedHit) this.schedulePersist();
  }

  private async fetchUpstream(ign: string, key: string): Promise<Avatar | null> {
    for (const board of BOARDS) {
      const hit = await this.queryBoard(ign, key, board);
      if (hit !== null) return hit;
    }
    return null;
  }

  private async queryBoard(ign: string, key: string, board: number): Promise<Avatar | null> {
    const url =
      `${this.upstream}?type=overall&id=weekly&reboot_index=${board}&page_index=1` +
      `&character_name=${encodeURIComponent(ign)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        headers: { 'user-agent': AVATAR_USER_AGENT, accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`upstream responded ${res.status}`);
      return pickRank(await res.json(), key, new Date(this.now()).toISOString());
    } finally {
      clearTimeout(timer);
    }
  }

  private schedulePersist(): void {
    this.dirty = true;
    if (this.writing === null) this.writing = this.writeLoop();
  }

  /** Coalesces bursts: one write in flight at a time, and a dirty flag folds further changes into the next write. */
  private async writeLoop(): Promise<void> {
    try {
      while (this.dirty) {
        this.dirty = false;
        await this.writeFile();
      }
    } catch (err) {
      this.log?.warn({ err, file: this.file }, 'could not write the avatar cache');
    } finally {
      this.writing = null;
    }
  }

  /** Expired past the stale grace window: no longer worth keeping for stale-on-error. */
  private tooOld(expiresAt: number): boolean {
    return expiresAt + AVATAR_STALE_GRACE_MS < this.now();
  }

  private async writeFile(): Promise<void> {
    const entries: PersistedEntry[] = [];
    for (const [key, entry] of this.cache) {
      if (entry.avatar === null) continue;
      if (this.tooOld(entry.expiresAt)) {
        this.cache.delete(key);
        continue;
      }
      entries.push({ key, avatar: entry.avatar, expiresAt: entry.expiresAt });
    }
    // An array, not an object: digit-only IGNs would be reordered as integer keys and lose their age order.
    const contents = JSON.stringify({ v: 1, avatars: entries });
    const dir = path.dirname(this.file);
    const tmp = path.join(dir, `.${AVATAR_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    try {
      const handle = await fs.open(tmp, 'w', 0o644);
      try {
        await handle.writeFile(contents, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(tmp, this.file);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
  }

  private async load(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') return;
      this.log?.warn({ err, file: this.file }, 'could not read the avatar cache, starting empty');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.log?.warn({ err, file: this.file }, 'avatar cache is not valid JSON, starting empty');
      return;
    }
    const list = (typeof parsed === 'object' && parsed !== null ? (parsed as { avatars?: unknown }).avatars : undefined);
    if (!Array.isArray(list)) {
      this.log?.warn({ file: this.file }, 'avatar cache has an unexpected shape, starting empty');
      return;
    }
    let skipped = 0;
    for (const item of list as unknown[]) {
      if (!isPersistedEntry(item) || this.tooOld(item.expiresAt)) {
        skipped++;
        continue;
      }
      this.cache.delete(item.key);
      this.cache.set(item.key, { avatar: item.avatar, expiresAt: item.expiresAt });
    }
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    this.log?.info({ file: this.file, avatars: this.cache.size, skipped }, 'avatar cache loaded');
  }
}
