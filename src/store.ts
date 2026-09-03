import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Logger } from 'pino';
import { KEY_RE } from './ign.js';
import type { CharacterDoc, CharacterInput, CharacterSummary } from './types.js';

export const DEFAULT_LIST_LIMIT = 500;
export const MAX_LIST_LIMIT = 500;

export interface PutOptions {
  /** Entity tags from If-Match: unquoted `updatedAt` values, or "*". Undefined = unconditional write. */
  ifMatch?: readonly string[];
}

export type PutResult =
  | { status: 'created' | 'updated'; doc: CharacterDoc }
  | { status: 'conflict'; updatedAt: string | null };

export class InvalidKeyError extends Error {
  constructor(key: unknown) {
    super(`invalid character key: ${JSON.stringify(key)}`);
    this.name = 'InvalidKeyError';
  }
}

type StoreLogger = Pick<Logger, 'info' | 'warn' | 'error' | 'debug'>;

function toSummary(doc: CharacterDoc): CharacterSummary {
  return { ign: doc.ign, label: doc.label, meta: { ...doc.meta }, updatedAt: doc.updatedAt, createdAt: doc.createdAt };
}

function cloneSummary(s: CharacterSummary): CharacterSummary {
  return { ...s, meta: { ...s.meta } };
}

function isDoc(v: unknown): v is CharacterDoc {
  if (typeof v !== 'object' || v === null) return false;
  const d = v as Record<string, unknown>;
  return (
    typeof d.ign === 'string' &&
    typeof d.label === 'string' &&
    typeof d.createdAt === 'string' &&
    typeof d.updatedAt === 'string' &&
    typeof d.meta === 'object' && d.meta !== null &&
    typeof d.preset === 'object' && d.preset !== null
  );
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === 'object' && err !== null && 'code' in err;
}

/** ISO timestamp strictly after `previous`, so two writes in the same millisecond still change the ETag. */
export function nextTimestamp(previous?: string, now: Date = new Date()): string {
  const iso = now.toISOString();
  if (previous === undefined || iso > previous) return iso;
  const prevMs = Date.parse(previous);
  return new Date((Number.isFinite(prevMs) ? prevMs : now.getTime()) + 1).toISOString();
}

/**
 * File-backed character store: one `<key>.json` per character under `<dataDir>/characters`,
 * written atomically (temp file + fsync + rename). An in-memory index of summaries is rebuilt from
 * the directory on open and kept current on every write, so listing and HEAD never touch the disk.
 */
export class CharacterStore {
  readonly directory: string;
  private readonly index = new Map<string, CharacterSummary>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly log: StoreLogger | undefined;

  private constructor(dataDir: string, log?: StoreLogger) {
    this.directory = path.join(path.resolve(dataDir), 'characters');
    this.log = log;
  }

  static async open(dataDir: string, log?: StoreLogger): Promise<CharacterStore> {
    const store = new CharacterStore(dataDir, log);
    await fs.mkdir(store.directory, { recursive: true });
    await store.rebuildIndex();
    return store;
  }

  size(): number {
    return this.index.size;
  }

  has(key: string): boolean {
    return this.index.has(key);
  }

  /** Index-only lookup (no disk access). */
  summary(key: string): CharacterSummary | undefined {
    const s = this.index.get(key);
    return s === undefined ? undefined : cloneSummary(s);
  }

  /** Summaries sorted by updatedAt desc (ties by IGN), capped at `limit` (max 500). */
  list(limit: number = DEFAULT_LIST_LIMIT): CharacterSummary[] {
    const cap = Math.max(0, Math.min(Math.trunc(limit), MAX_LIST_LIMIT));
    return [...this.index.values()]
      .sort((a, b) => (a.updatedAt === b.updatedAt ? a.ign.localeCompare(b.ign) : a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, cap)
      .map(cloneSummary);
  }

  async get(key: string): Promise<CharacterDoc | undefined> {
    const file = this.filePath(key);
    if (!this.index.has(key)) return undefined;
    try {
      return await this.readDoc(file);
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        this.index.delete(key);
        return undefined;
      }
      throw err;
    }
  }

  async put(key: string, input: CharacterInput, opts: PutOptions = {}): Promise<PutResult> {
    const file = this.filePath(key);
    return this.withLock(key, async () => {
      const current = this.index.get(key);
      if (opts.ifMatch !== undefined) {
        const matches = current !== undefined && opts.ifMatch.some((tag) => tag === '*' || tag === current.updatedAt);
        if (!matches) return { status: 'conflict', updatedAt: current?.updatedAt ?? null };
      }

      const updatedAt = nextTimestamp(current?.updatedAt);
      const doc: CharacterDoc = {
        ign: input.ign,
        label: input.label,
        createdAt: current?.createdAt ?? updatedAt,
        updatedAt,
        meta: { ...input.meta },
        preset: input.preset,
      };
      await this.writeAtomic(file, key, JSON.stringify(doc));
      this.index.set(key, toSummary(doc));
      const status = current === undefined ? 'created' : 'updated';
      this.log?.info({ key, status }, 'character saved');
      return { status, doc };
    });
  }

  async delete(key: string): Promise<boolean> {
    const file = this.filePath(key);
    return this.withLock(key, async () => {
      const indexed = this.index.delete(key);
      let unlinked = false;
      try {
        await fs.unlink(file);
        unlinked = true;
      } catch (err) {
        if (!isNodeError(err) || err.code !== 'ENOENT') throw err;
      }
      const removed = indexed || unlinked;
      if (removed) this.log?.info({ key }, 'character deleted');
      return removed;
    });
  }

  /** Resolve `<directory>/<key>.json`, refusing anything that is not a valid key or escapes the directory. */
  private filePath(key: string): string {
    if (typeof key !== 'string' || !KEY_RE.test(key)) throw new InvalidKeyError(key);
    const file = path.join(this.directory, `${key}.json`);
    if (path.dirname(file) !== this.directory) throw new InvalidKeyError(key);
    return file;
  }

  private async readDoc(file: string): Promise<CharacterDoc> {
    const raw = await fs.readFile(file, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isDoc(parsed)) throw new Error(`malformed character file: ${file}`);
    return parsed;
  }

  private async writeAtomic(file: string, key: string, contents: string): Promise<void> {
    const tmp = path.join(this.directory, `.${key}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    try {
      const handle = await fs.open(tmp, 'w', 0o644);
      try {
        await handle.writeFile(contents, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(tmp, file);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
  }

  private async rebuildIndex(): Promise<void> {
    this.index.clear();
    const entries = await fs.readdir(this.directory, { withFileTypes: true });
    let skipped = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      if (name.startsWith('.') && name.endsWith('.tmp')) {
        await fs.rm(path.join(this.directory, name), { force: true });
        this.log?.warn({ file: name }, 'removed stale temp file');
        continue;
      }
      if (!name.endsWith('.json')) continue;
      const key = name.slice(0, -'.json'.length);
      if (!KEY_RE.test(key)) {
        skipped++;
        this.log?.warn({ file: name }, 'skipping character file with an invalid key');
        continue;
      }
      try {
        const doc = await this.readDoc(path.join(this.directory, name));
        if (doc.ign.toLowerCase() !== key) {
          skipped++;
          this.log?.warn({ file: name, ign: doc.ign }, 'skipping character file whose ign does not match its name');
          continue;
        }
        this.index.set(key, toSummary(doc));
      } catch (err) {
        skipped++;
        this.log?.warn({ file: name, err }, 'skipping unreadable character file');
      }
    }
    this.log?.info({ directory: this.directory, characters: this.index.size, skipped }, 'character index built');
  }

  /** Serialise writes per key so If-Match checks and rename order stay consistent under concurrency. */
  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.then(fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(key, tail);
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return run;
  }
}
