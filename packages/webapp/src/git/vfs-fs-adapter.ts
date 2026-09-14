import type { VirtualFS } from '../fs/index.js';
import { normalizePath } from '../fs/path-utils.js';
import { type DirEntry, FsError, type Stats, statsFromDirEntry } from '../fs/types.js';

export type PromiseFsClient = { promises: IsoGitFsPromises };

export interface IsoGitFsOptions {
  objectCache?: boolean;

  statCacheMax?: number;
}

export interface IsoGitFsClient extends PromiseFsClient {
  clearStatCache(): void;

  statCacheSize(): number;
}

const MAX_CACHED_ENTRIES = 100_000;

interface CachedEntry {
  type: 'file' | 'dir';
  stats?: Stats;
}

export interface IsoGitFsPromises {
  readFile(path: string, options?: unknown): Promise<Uint8Array | string>;
  writeFile(path: string, data: Uint8Array | string, options?: unknown): Promise<void>;
  unlink(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string, options?: unknown): Promise<void>;
  rmdir(path: string): Promise<void>;
  stat(path: string): Promise<NodeLikeStats>;
  lstat(path: string): Promise<NodeLikeStats>;
  readlink(path: string): Promise<string>;
  symlink(target: string, path: string): Promise<void>;
}

export interface NodeLikeStats {
  type: 'file' | 'dir' | 'symlink';
  mode: number;
  size: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  uid: number;
  gid: number;
  dev: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

const FILE_MODE = 0o100644;
const DIR_MODE = 0o040755;
const SYMLINK_MODE = 0o120000;

const TYPE_MASK = 0o170000;
const PERMISSION_MASK = 0o7777;

function composeMode(type: 'file' | 'dir' | 'symlink', rawMode: number | undefined): number {
  const fallback = type === 'dir' ? DIR_MODE : type === 'symlink' ? SYMLINK_MODE : FILE_MODE;
  if (rawMode === undefined) return fallback;
  const permissions = rawMode & PERMISSION_MASK;
  return (fallback & TYPE_MASK) | permissions;
}

function toStats(type: 'file' | 'dir' | 'symlink', raw: Partial<NodeLikeStats>): NodeLikeStats {
  const mtimeMs = raw.mtimeMs ?? 0;
  return {
    type,
    mode: composeMode(type, raw.mode),
    size: raw.size ?? 0,
    ino: raw.ino ?? 0,
    mtimeMs,
    ctimeMs: raw.ctimeMs ?? mtimeMs,
    uid: raw.uid ?? 1,
    gid: raw.gid ?? 1,
    dev: 1,
    isFile: () => type === 'file',
    isDirectory: () => type === 'dir',
    isSymbolicLink: () => type === 'symlink',
  };
}

function fromVfsStats(s: Stats): Partial<NodeLikeStats> {
  return {
    size: s.size,
    mtimeMs: s.mtime,
    ctimeMs: s.ctime,
    ...(s.ino !== undefined ? { ino: s.ino } : {}),
    ...(s.uid !== undefined ? { uid: s.uid } : {}),
    ...(s.gid !== undefined ? { gid: s.gid } : {}),
    ...(s.mode !== undefined ? { mode: s.mode } : {}),
  };
}

export function wantsUtf8(options: unknown): boolean {
  if (typeof options === 'string') return /^utf-?8$/i.test(options);
  if (options && typeof options === 'object') {
    const enc = (options as { encoding?: unknown }).encoding;
    if (typeof enc === 'string') return /^utf-?8$/i.test(enc);
  }
  return false;
}

function readRange(options: unknown): { start: number; end: number } | null {
  if (!options || typeof options !== 'object') return null;
  const { start, end } = options as { start?: unknown; end?: unknown };
  if (typeof start !== 'number' || typeof end !== 'number') return null;
  return { start, end };
}

interface ObjectScope {
  packDirs: Map<string, Promise<string[]>>;

  fanouts: Map<string, Promise<Set<string>>>;
}

const PACK_DIR_SUFFIX = '/objects/pack';

const LOOSE_OBJECT_PATH = /^(.*\/objects)\/([0-9a-f]{2})\/[0-9a-f]{38,}$/;

const LOOSE_FANOUT_DIR = /\/objects\/[0-9a-f]{2}$/;

function isObjectStoreNamesOnlyPath(path: string): boolean {
  return path.endsWith(PACK_DIR_SUFFIX) || LOOSE_FANOUT_DIR.test(path);
}

function cacheableEntry(entry: DirEntry): CachedEntry | undefined {
  const stats = statsFromDirEntry(entry);
  if (entry.type === 'directory') return stats ? { type: 'dir', stats } : { type: 'dir' };
  return stats ? { type: 'file', stats } : undefined;
}

interface StatCache {
  prime(dir: string, entries: DirEntry[]): void;

  get(path: string): NodeLikeStats | undefined;
  drop(path: string): void;
  clear(): void;
  size(): number;
}

function createStatCache(maxEntries: number): StatCache {
  const entriesByPath = new Map<string, CachedEntry>();
  return {
    prime(dir, entries) {
      if (entries.length > maxEntries) {
        entriesByPath.clear();
        return;
      }
      if (entriesByPath.size + entries.length > maxEntries) entriesByPath.clear();
      const base = normalizePath(dir);
      const prefix = base === '/' ? '/' : `${base}/`;
      for (const entry of entries) {
        const cached = cacheableEntry(entry);

        if (cached) entriesByPath.set(`${prefix}${entry.name}`, cached);
        else entriesByPath.delete(`${prefix}${entry.name}`);
      }
    },
    get(path) {
      const cached = entriesByPath.get(normalizePath(path));
      if (!cached) return undefined;

      return toStats(cached.type, cached.stats ? fromVfsStats(cached.stats) : {});
    },
    drop(path) {
      entriesByPath.delete(normalizePath(path));
    },
    clear() {
      entriesByPath.clear();
    },
    size() {
      return entriesByPath.size;
    },
  };
}

export function createIsomorphicGitFs(
  vfs: VirtualFS,
  options: IsoGitFsOptions = {}
): IsoGitFsClient {
  const scope: ObjectScope | undefined = options.objectCache
    ? { packDirs: new Map(), fanouts: new Map() }
    : undefined;

  const statCache = createStatCache(Math.max(0, options.statCacheMax ?? MAX_CACHED_ENTRIES));

  const listNames = async (path: string): Promise<string[]> => {
    const entries = await vfs.readDir(
      path,
      isObjectStoreNamesOnlyPath(path) ? undefined : { includeStats: true }
    );
    statCache.prime(path, entries);
    return entries.map((e) => e.name);
  };

  const fanoutNames = (active: ObjectScope, objectsDir: string): Promise<Set<string>> => {
    const hit = active.fanouts.get(objectsDir);
    if (hit) return hit;
    const pending = listNames(objectsDir).then((names) => new Set(names));
    active.fanouts.set(objectsDir, pending);
    return pending;
  };

  const isMissingLooseObject = async (path: string): Promise<boolean> => {
    if (!scope) return false;
    const match = LOOSE_OBJECT_PATH.exec(path);
    if (!match) return false;
    try {
      return !(await fanoutNames(scope, match[1])).has(match[2]);
    } catch {
      return false;
    }
  };

  const invalidateObjectScope = (): void => {
    scope?.packDirs.clear();
    scope?.fanouts.clear();
  };

  const mutatePath = async <T>(path: string, op: () => Promise<T>): Promise<T> => {
    statCache.drop(path);
    return await mutate(op);
  };

  const mutate = async <T>(op: () => Promise<T>): Promise<T> => {
    invalidateObjectScope();
    try {
      return await op();
    } finally {
      invalidateObjectScope();
    }
  };

  const promises: IsoGitFsPromises = {
    async readFile(path, options) {
      if (await isMissingLooseObject(path)) {
        throw new FsError('ENOENT', 'no such file or directory', path);
      }

      const range = readRange(options);
      if (range) return await vfs.readFileRange(path, range.start, range.end);
      const content = await vfs.readFile(
        path,
        wantsUtf8(options) ? { encoding: 'utf-8' } : { encoding: 'binary' }
      );
      return content;
    },

    async writeFile(path, data, _options) {
      await mutatePath(path, () => vfs.writeFile(path, data));
    },

    async unlink(path) {
      await mutatePath(path, () => vfs.rm(path));
    },

    async readdir(path) {
      if (!scope || !path.endsWith(PACK_DIR_SUFFIX)) return await listNames(path);
      const hit = scope.packDirs.get(path);
      if (hit) return [...(await hit)];
      const pending = listNames(path);
      scope.packDirs.set(path, pending);

      return [...(await pending)];
    },

    async mkdir(path, options) {
      const opts = (options ?? undefined) as { recursive?: boolean } | undefined;
      await mutatePath(path, () =>
        vfs.mkdir(path, opts?.recursive !== undefined ? { recursive: opts.recursive } : undefined)
      );
    },

    async rmdir(path) {
      statCache.clear();
      await mutate(() => vfs.rm(path));
    },

    async stat(path) {
      const primed = statCache.get(path);
      if (primed) return primed;
      const s = await vfs.stat(path);
      return toStats(s.type === 'directory' ? 'dir' : 'file', fromVfsStats(s));
    },

    async lstat(path) {
      const primed = statCache.get(path);
      if (primed) return primed;
      const s = await vfs.lstat(path);
      const type: 'file' | 'dir' | 'symlink' =
        s.type === 'directory' ? 'dir' : s.type === 'symlink' ? 'symlink' : 'file';
      return toStats(type, fromVfsStats(s));
    },

    async readlink(path) {
      if (vfs.isPathUnderMount(path)) {
        throw new FsError('EINVAL', 'symlinks not supported on mounted filesystems', path);
      }
      return vfs.readlink(path);
    },

    async symlink(target, path) {
      if (vfs.isPathUnderMount(path)) {
        throw new FsError('EINVAL', 'symlinks not supported on mounted filesystems', path);
      }
      await mutatePath(path, () => vfs.symlink(target, path));
    },
  };

  return {
    promises,
    clearStatCache() {
      statCache.clear();
    },
    statCacheSize() {
      return statCache.size();
    },
  };
}
