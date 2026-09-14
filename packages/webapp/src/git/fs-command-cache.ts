import { type IsoGitFsPromises, type NodeLikeStats, wantsUtf8 } from './vfs-fs-adapter.js';

export interface ReadCacheLimits {
  maxEntries: number;

  maxFileBytes: number;

  maxTotalBytes: number;
}

const DEFAULT_LIMITS: ReadCacheLimits = {
  maxEntries: 50_000,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
};

const STABLE_ERROR_CODES = new Set(['ENOENT', 'ENOTDIR', 'EISDIR']);

function isPackPath(path: string): boolean {
  return path.endsWith('.pack') || path.endsWith('.idx');
}

function normalizePath(path: string): string {
  const collapsed = path.replace(/\/{2,}/g, '/');
  if (collapsed.length > 1 && collapsed.endsWith('/')) return collapsed.slice(0, -1);
  return collapsed;
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf('/');
  if (slash < 0) return '.';
  return slash === 0 ? '/' : path.slice(0, slash);
}

function errorCodeOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function byteLengthOf(value: Uint8Array | string): number {
  return typeof value === 'string' ? value.length * 2 : value.byteLength;
}

function fileKey(path: string, utf8: boolean): string {
  return `${utf8 ? 'u' : 'b'} ${path}`;
}

class ReadScope {
  readonly stats = new Map<string, Promise<NodeLikeStats>>();
  readonly lstats = new Map<string, Promise<NodeLikeStats>>();
  readonly dirs = new Map<string, Promise<string[]>>();
  readonly files = new Map<string, Promise<Uint8Array | string>>();

  private readonly fileBytes = new Map<string, number>();
  private retainedBytes = 0;

  constructor(private readonly limits: ReadCacheLimits) {}

  hasRoom(): boolean {
    const entries = this.stats.size + this.lstats.size + this.dirs.size + this.files.size;
    return entries < this.limits.maxEntries;
  }

  retainFile(key: string, value: Uint8Array | string): boolean {
    const bytes = byteLengthOf(value);
    if (bytes > this.limits.maxFileBytes) return false;
    if (this.retainedBytes + bytes > this.limits.maxTotalBytes) return false;
    this.fileBytes.set(key, bytes);
    this.retainedBytes += bytes;
    return true;
  }

  private dropFile(key: string): void {
    const bytes = this.fileBytes.get(key);
    if (bytes === undefined) return;
    this.fileBytes.delete(key);
    this.retainedBytes -= bytes;
  }

  private forgetSelf(path: string): void {
    this.stats.delete(path);
    this.lstats.delete(path);
    this.dirs.delete(path);
    for (const key of [fileKey(path, true), fileKey(path, false)]) {
      this.files.delete(key);
      this.dropFile(key);
    }
  }

  invalidatePath(rawPath: string): void {
    const path = normalizePath(rawPath);
    this.forgetSelf(path);
    const parent = parentOf(path);
    this.dirs.delete(parent);
    this.stats.delete(parent);
    this.lstats.delete(parent);
  }

  invalidateSubtree(rawPath: string): void {
    const path = normalizePath(rawPath);
    const prefix = `${path}/`;
    for (const map of [this.stats, this.lstats, this.dirs]) {
      for (const key of map.keys()) if (key.startsWith(prefix)) map.delete(key);
    }
    for (const key of this.files.keys()) {
      if (key.slice(2).startsWith(prefix)) {
        this.files.delete(key);
        this.dropFile(key);
      }
    }
    this.invalidatePath(path);
  }
}

interface MemoOptions<T> {
  admit: () => boolean;

  keep?: (value: T) => boolean;
}

function memoize<T>(
  map: Map<string, Promise<T>>,
  key: string,
  load: () => Promise<T>,
  options: MemoOptions<T>
): Promise<T> {
  const hit = map.get(key);
  if (hit) return hit;
  const pending = load();
  if (!options.admit()) return pending;
  map.set(key, pending);
  const evict = (): void => {
    if (map.get(key) === pending) map.delete(key);
  };
  void pending.then(
    (value) => {
      if (options.keep && !options.keep(value)) evict();
    },
    (err) => {
      if (!STABLE_ERROR_CODES.has(errorCodeOf(err) ?? '')) evict();
    }
  );
  return pending;
}

export function createCommandScopedReadCache(
  inner: IsoGitFsPromises,
  limits: Partial<ReadCacheLimits> = {}
): IsoGitFsPromises {
  const scope = new ReadScope({ ...DEFAULT_LIMITS, ...limits });
  const admit = (): boolean => scope.hasRoom();

  const readdir: IsoGitFsPromises['readdir'] = async (path) => {
    const names = await memoize(scope.dirs, normalizePath(path), () => inner.readdir(path), {
      admit,
    });
    return names.slice();
  };

  const readFile: IsoGitFsPromises['readFile'] = async (path, options) => {
    if (isPackPath(path)) return inner.readFile(path, options);
    const key = fileKey(normalizePath(path), wantsUtf8(options));
    const value = await memoize(scope.files, key, () => inner.readFile(path, options), {
      admit,
      keep: (v) => scope.retainFile(key, v),
    });
    return typeof value === 'string' ? value : new Uint8Array(value);
  };

  const statLike = (
    map: Map<string, Promise<NodeLikeStats>>,
    load: (path: string) => Promise<NodeLikeStats>
  ): ((path: string) => Promise<NodeLikeStats>) => {
    return (path) => memoize(map, normalizePath(path), () => load(path), { admit });
  };

  const afterWrite = async <T>(path: string, op: () => Promise<T>, subtree = false): Promise<T> => {
    try {
      return await op();
    } finally {
      if (subtree) scope.invalidateSubtree(path);
      else scope.invalidatePath(path);
    }
  };

  return {
    readFile,
    readdir,
    stat: statLike(scope.stats, (p) => inner.stat(p)),
    lstat: statLike(scope.lstats, (p) => inner.lstat(p)),
    readlink: (path) => inner.readlink(path),
    writeFile: (path, data, options) =>
      afterWrite(path, () => inner.writeFile(path, data, options)),
    unlink: (path) => afterWrite(path, () => inner.unlink(path), true),
    rmdir: (path) => afterWrite(path, () => inner.rmdir(path), true),
    mkdir: (path, options) => afterWrite(path, () => inner.mkdir(path, options)),
    symlink: (target, path) => afterWrite(path, () => inner.symlink(target, path)),
  };
}
