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

export interface StoreOptions {
  /** Cap on the number of stored characters. Creates past the cap fail with `full`; overwrites are unaffected. */
  maxCharacters?: number;
}

export type PutResult =
  | { status: 'created' | 'updated'; doc: CharacterDoc }
  | { status: 'conflict'; updatedAt: string | null }
  | { status: 'full' };

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
 * The number of documents is capped (`maxCharacters`) so one client cannot fill the disk or bloat the index.
 */
export class CharacterStore {
  readonly directory: string;
  readonly maxCharacters: number;
  private readonly index = new Map<string, CharacterSummary>();
  /** Memoised `list()` order (updatedAt desc, ties by IGN); null until needed, dropped on every index change. */
  private sorted: CharacterSummary[] | null = null;
  /** On-disk size of each document in bytes (for HEAD Content-Length). */
  private readonly sizes = new Map<string, number>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly log: StoreLogger | undefined;

  private constructor(dataDir: string, log?: StoreLogger, opts: StoreOptions = {}) {
    this.directory = path.join(path.resolve(dataDir), 'characters');
    this.log = log;
    const cap = opts.maxCharacters;
    this.maxCharacters = cap !== undefined && Number.isFinite(cap) && cap > 0 ? Math.trunc(cap) : Infinity;
  }

  static async open(dataDir: string, log?: StoreLogger, opts: StoreOptions = {}): Promise<CharacterStore> {
    const store = new CharacterStore(dataDir, log, opts);
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

  /** Byte size of the stored document, if indexed. */
  byteSize(key: string): number | undefined {
    return this.sizes.get(key);
  }

  /** Index-only lookup (no disk access). */
  summary(key: string): CharacterSummary | undefined {
    const s = this.index.get(key);
    return s === undefined ? undefined : cloneSummary(s);
  }

  /** Summaries sorted by updatedAt desc (ties by IGN), capped at `limit` (max 500). */
  list(limit: number = DEFAULT_LIST_LIMIT): CharacterSummary[] {
    const cap = Math.max(0, Math.min(Math.trunc(limit), MAX_LIST_LIMIT));
    this.sorted ??= [...this.index.values()].sort((a, b) =>
      a.updatedAt === b.updatedAt ? a.ign.localeCompare(b.ign) : a.updatedAt < b.updatedAt ? 1 : -1,
    );
    return this.sorted.slice(0, cap).map(cloneSummary);
  }

  async get(key: string): Promise<CharacterDoc | undefined> {
    const file = this.filePath(key);
    if (!this.index.has(key)) return undefined;
    try {
      return await this.readDoc(file);
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        this.index.delete(key);
        this.sizes.delete(key);
        this.sorted = null;
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
      if (current === undefined && this.index.size >= this.maxCharacters) {
        this.log?.warn({ key, characters: this.index.size }, 'character cap reached, create refused');
        return { status: 'full' };
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
      const contents = JSON.stringify(doc);
      await this.writeAtomic(file, key, contents);
      this.index.set(key, toSummary(doc));
      this.sizes.set(key, Buffer.byteLength(contents, 'utf8'));
      this.sorted = null;
      const status = current === undefined ? 'created' : 'updated';
      // No key here: this fires on every save, and the IGN does not belong in the retained log stream.
      this.log?.info({ status, characters: this.index.size }, 'character saved');
      return { status, doc };
    });
  }

  async delete(key: string): Promise<boolean> {
    const file = this.filePath(key);
    return this.withLock(key, async () => {
      // Unlink FIRST: if the disk refuses, the index must keep serving the document (a 500 here
      // must not make it vanish until the next restart).
      let unlinked = false;
      try {
        await fs.unlink(file);
        unlinked = true;
      } catch (err) {
        if (!isNodeError(err) || err.code !== 'ENOENT') throw err;
      }
      if (unlinked) await this.syncDirectory();
      const indexed = this.index.delete(key);
      this.sizes.delete(key);
      this.sorted = null;
      const removed = indexed || unlinked;
      if (removed) this.log?.info({ characters: this.index.size }, 'character deleted');
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
    // The rename is only a directory-entry change: flush it so a crash after the response cannot
    // roll the file back to the previous version (or to nothing) while the client keeps the new ETag.
    await this.syncDirectory();
  }

  /** fsync the store directory after a rename/unlink. Filesystems that refuse directory fsync are tolerated. */
  private async syncDirectory(): Promise<void> {
    let dir: fs.FileHandle | undefined;
    try {
      dir = await fs.open(this.directory, 'r');
      await dir.sync();
    } catch (err) {
      if (!isNodeError(err) || !['EINVAL', 'EPERM', 'ENOTSUP', 'EISDIR', 'EBADF'].includes(err.code ?? '')) throw err;
    } finally {
      await dir?.close();
    }
  }

  private async rebuildIndex(): Promise<void> {
    this.index.clear();
    this.sizes.clear();
    this.sorted = null;
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
        this.sizes.set(key, (await fs.stat(path.join(this.directory, name))).size);
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
