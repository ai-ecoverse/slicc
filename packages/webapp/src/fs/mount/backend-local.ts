/**
 * `LocalMountBackend` wraps a `FileSystemDirectoryHandle` and implements
 * `MountBackend` over the File System Access API.
 *
 * Interactive handle acquisition (cone approval card, extension popup, or
 * standalone direct picker) lives in `mount-commands.ts` and
 * `mount/local-mount-acquire.ts` / `shell/supplemental-commands/
 * mount-directory-approval.ts` so this module stays in the `fs/` layer.
 *
 * Two costs shape everything below (issue #2733). Every FSA call is an IPC
 * round-trip to the browser process at ~40 µs, so op *count* — not bytes — is
 * the budget:
 *
 *   - `readDir` used to `getFile()` every file entry just to fill size/mtime.
 *   `objects/pack` has 91 entries and `git log --all` lists it ~25,000 times,
 *   so one benchmark command spent 2.29 M `getFile` calls / 370 s on metadata
 *   no caller had asked for. Stats are now opt-in via `readDir(path,
 *   { includeStats: true })`.
 *   - Every op re-walked from the root handle with one `getDirectoryHandle`
 *   per path segment; a 3,549-file `git status` cost 54,767 of them. A
 *   bounded LRU of directory handles (`dirCache`) makes a repeat op under an
 *   already-visited directory cost zero root walks.
 */

import { FsError } from '../types.js';
import type {
  MountBackend,
  MountDescription,
  MountDirEntry,
  MountStat,
  ReadDirOptions,
  RefreshReport,
} from './backend.js';

export interface LocalMountBackendOptions {
  mountId: string;
  /** Max cached directory handles. Defaults to `DEFAULT_DIR_CACHE_MAX`. */
  dirCacheMax?: number;
}

/**
 * Directory-handle cache ceiling. A handle is a small object holding a path
 * and an origin-private token — Chrome re-resolves it against the real
 * directory on every use — so the cache costs memory, not correctness. 512
 * covers a git repo's hot set (`.git`, `objects/pack`, `refs/**`, plus the
 * working tree's top few levels) with room to spare.
 */
const DEFAULT_DIR_CACHE_MAX = 512;

export class LocalMountBackend implements MountBackend {
  readonly kind = 'local' as const;
  readonly source = undefined;
  readonly profile = undefined;
  readonly mountId: string;

  private readonly handle: FileSystemDirectoryHandle;
  private readonly dirCacheMax: number;
  /**
   * Resolved directory handles keyed by the mount-relative path (`''` = the
   * mount root, otherwise slash-joined segments with no leading/trailing
   * slash). Insertion order is the LRU order: a hit re-inserts at the end.
   */
  private readonly dirCache = new Map<string, FileSystemDirectoryHandle>();
  private closed = false;

  private constructor(handle: FileSystemDirectoryHandle, opts: LocalMountBackendOptions) {
    this.handle = handle;
    this.mountId = opts.mountId;
    this.dirCacheMax = opts.dirCacheMax ?? DEFAULT_DIR_CACHE_MAX;
  }

  static fromHandle(
    handle: FileSystemDirectoryHandle,
    opts: LocalMountBackendOptions
  ): LocalMountBackend {
    return new LocalMountBackend(handle, opts);
  }

  /** Test/internal access to the underlying handle. */
  getHandle(): FileSystemDirectoryHandle {
    return this.handle;
  }

  // --- internal helpers ---

  private assertOpen(path: string): void {
    if (this.closed) {
      throw new FsError('EBADF', 'mount closed', path);
    }
  }

  private splitPath(path: string): string[] {
    return path
      .replace(/^\/+/, '')
      .replace(/\/+$/, '')
      .split('/')
      .filter((s) => s.length > 0);
  }

  // --- directory-handle cache ---

  private cacheGet(key: string): FileSystemDirectoryHandle | undefined {
    const hit = this.dirCache.get(key);
    if (hit === undefined) return undefined;
    // Re-insert to move to the MRU end of the Map's insertion order.
    this.dirCache.delete(key);
    this.dirCache.set(key, hit);
    return hit;
  }

  private cacheSet(key: string, handle: FileSystemDirectoryHandle): void {
    if (this.dirCache.has(key)) this.dirCache.delete(key);
    this.dirCache.set(key, handle);
    while (this.dirCache.size > this.dirCacheMax) {
      // Map iteration order is insertion order, so the first key is the LRU.
      const oldest = this.dirCache.keys().next();
      if (oldest.done) break;
      this.dirCache.delete(oldest.value);
    }
  }

  /**
   * Drop `key` and everything beneath it. Called whenever this backend
   * changes the shape of the tree (`remove`), because a handle for a removed
   * directory would otherwise keep answering `getDirectoryHandle` walks that
   * should now fail. Changes made *outside* the backend need no invalidation:
   * Chrome resolves a handle against the live directory on each use, so a
   * stale handle surfaces the same `NotFoundError` a fresh walk would.
   */
  private invalidate(key: string): void {
    if (key === '') {
      this.dirCache.clear();
      return;
    }
    const prefix = `${key}/`;
    for (const cached of [...this.dirCache.keys()]) {
      if (cached === key || cached.startsWith(prefix)) this.dirCache.delete(cached);
    }
  }

  /** Test/internal view of the cache size. */
  getDirCacheSize(): number {
    return this.dirCache.size;
  }

  /**
   * Resolve a directory, reusing cached handles for every prefix already
   * seen. A cold walk of `a/b/c` costs three `getDirectoryHandle` calls and
   * caches `a`, `a/b`, `a/b/c`; the next op anywhere under `a/b` starts from
   * the cached handle instead of the mount root.
   *
   * A `create` walk that fails from a cached prefix drops that prefix and
   * retries once from the mount root, because that is the one case where
   * cached and cold resolution disagree: if an ancestor vanished outside
   * SLICC, a cold `mkdir -p` would re-create it and the cached one would
   * not. A read walk deliberately does *not* retry — a miss under a cached
   * directory almost always means the path really is absent (isomorphic-git
   * probes for loose objects constantly), and invalidating an ancestor on
   * every such miss would flush the hot `.git/objects` entries.
   */
  private async resolveDirFrom(
    segments: string[],
    path: string,
    create: boolean,
    useCache = true
  ): Promise<FileSystemDirectoryHandle> {
    let dir = this.handle;
    let key = '';
    let index = 0;
    // Longest cached prefix first — skip the IPCs we already paid for.
    if (useCache) {
      for (let i = segments.length; i > 0; i--) {
        const candidate = segments.slice(0, i).join('/');
        const hit = this.cacheGet(candidate);
        if (hit) {
          dir = hit;
          key = candidate;
          index = i;
          break;
        }
      }
    }
    const startedFrom = key;
    for (; index < segments.length; index++) {
      const seg = segments[index];
      try {
        dir = await dir.getDirectoryHandle(seg, { create });
      } catch (err) {
        if (create && startedFrom !== '') {
          this.invalidate(startedFrom);
          return this.resolveDirFrom(segments, path, create, false);
        }
        throw this.toFsError(err, path);
      }
      key = key === '' ? seg : `${key}/${seg}`;
      this.cacheSet(key, dir);
    }
    return dir;
  }

  private async resolveDir(path: string, create = false): Promise<FileSystemDirectoryHandle> {
    return this.resolveDirFrom(this.splitPath(path), path, create);
  }

  /** Resolve the parent directory of `path` plus the leaf name. */
  private async resolveParent(
    path: string,
    create: boolean
  ): Promise<{ parent: FileSystemDirectoryHandle; name: string }> {
    const segments = this.splitPath(path);
    if (segments.length === 0) {
      throw new FsError('EISDIR', 'is a directory', path);
    }
    const name = segments.pop()!;
    return { parent: await this.resolveDirFrom(segments, path, create), name };
  }

  private async resolveFile(path: string, create = false): Promise<FileSystemFileHandle> {
    const { parent, name } = await this.resolveParent(path, create);
    try {
      return await parent.getFileHandle(name, { create });
    } catch (err) {
      throw this.toFsError(err, path);
    }
  }

  private toFsError(err: unknown, path: string): FsError {
    if (err instanceof FsError) return err;
    if (err instanceof DOMException) {
      if (err.name === 'NotFoundError')
        return new FsError('ENOENT', 'no such file or directory', path);
      if (err.name === 'TypeMismatchError') return new FsError('ENOTDIR', 'not a directory', path);
      if (err.name === 'NotAllowedError') return new FsError('EACCES', 'permission denied', path);
      // FSA throws InvalidModificationError from removeEntry() when the
      // target is a non-empty directory and `recursive` was not requested.
      // Surface that as ENOTEMPTY so callers (notably isomorphic-git's
      // checkout/reset cleanup path) can tolerate untracked files.
      if (err.name === 'InvalidModificationError')
        return new FsError('ENOTEMPTY', 'directory not empty', path);
    }
    // Mock helpers may throw a plain Error with name='NotFound' (no -Error suffix).
    if (err instanceof Error) {
      if (err.name === 'NotFound' || err.name === 'NotFoundError')
        return new FsError('ENOENT', 'no such file or directory', path);
      if (err.name === 'TypeMismatch' || err.name === 'TypeMismatchError')
        return new FsError('ENOTDIR', 'not a directory', path);
      if (err.name === 'InvalidModification' || err.name === 'InvalidModificationError')
        return new FsError('ENOTEMPTY', 'directory not empty', path);
    }
    return new FsError('EINVAL', err instanceof Error ? err.message : String(err), path);
  }

  // --- MountBackend implementation ---

  /**
   * List a directory. `size`/`lastModified` are omitted unless
   * `opts.includeStats` is set — filling them costs one `getFile()` IPC per
   * file entry, and the dominant caller (isomorphic-git's names-only
   * `readdir`) throws them away (#2733).
   */
  async readDir(path: string, opts?: ReadDirOptions): Promise<MountDirEntry[]> {
    this.assertOpen(path);
    const dir = await this.resolveDir(path);
    const out: MountDirEntry[] = [];
    for await (const [name, child] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
      if (child.kind !== 'file') {
        out.push({ name, kind: 'directory' });
        continue;
      }
      if (!opts?.includeStats) {
        out.push({ name, kind: 'file' });
        continue;
      }
      const file = await (child as FileSystemFileHandle).getFile();
      out.push({ name, kind: 'file', size: file.size, lastModified: file.lastModified });
    }
    return out;
  }

  async readFile(path: string): Promise<Uint8Array> {
    this.assertOpen(path);
    const fh = await this.resolveFile(path);
    const file = await fh.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  async writeFile(path: string, body: Uint8Array): Promise<void> {
    this.assertOpen(path);
    const fh = await this.resolveFile(path, true);
    const writable = await fh.createWritable();
    // TS 5.7 narrowed BufferSource's ArrayBufferLike to ArrayBuffer; our
    // Uint8Array may carry a SharedArrayBuffer in the type, so cast.
    await writable.write(body as unknown as BufferSource);
    await writable.close();
  }

  /**
   * Stat one path. Resolves the parent once (cached) and asks it for a file
   * handle, then a directory handle — where the old code walked the whole
   * path from the mount root twice.
   */
  async stat(path: string): Promise<MountStat> {
    this.assertOpen(path);
    const segments = this.splitPath(path);
    if (segments.length === 0) {
      return { kind: 'directory', size: 0, mtime: 0 };
    }
    const name = segments.pop()!;
    const parent = await this.resolveDirFrom(segments, path, false);
    // Try as a file first. "Not there" (ENOENT) and "not a file" (ENOTDIR,
    // from FSA's TypeMismatchError) are the two answers that mean *ask the
    // directory branch instead*. Anything else — a permission denial on a
    // file that does exist, above all — IS the answer, so re-throw it rather
    // than fall through and have `getDirectoryHandle` relabel it ENOTDIR.
    try {
      const fh = await parent.getFileHandle(name);
      const file = await fh.getFile();
      return { kind: 'file', size: file.size, mtime: file.lastModified };
    } catch (err) {
      const mapped = this.toFsError(err, path);
      if (mapped.code !== 'ENOENT' && mapped.code !== 'ENOTDIR') throw mapped;
      // fall through
    }
    try {
      const dir = await parent.getDirectoryHandle(name);
      this.cacheSet(segments.length === 0 ? name : `${segments.join('/')}/${name}`, dir);
    } catch (err) {
      throw this.toFsError(err, path);
    }
    return { kind: 'directory', size: 0, mtime: 0 };
  }

  async mkdir(path: string): Promise<void> {
    this.assertOpen(path);
    await this.resolveDir(path, true);
  }

  async remove(path: string, opts?: { recursive?: boolean }): Promise<void> {
    this.assertOpen(path);
    const segments = this.splitPath(path);
    if (segments.length === 0) {
      throw new FsError('EINVAL', 'cannot remove mount root', path);
    }
    const name = segments.pop()!;
    const parent = await this.resolveDirFrom(segments, path, false);
    try {
      await (
        parent as unknown as {
          removeEntry: (n: string, o?: { recursive?: boolean }) => Promise<void>;
        }
      ).removeEntry(name, { recursive: opts?.recursive ?? false });
    } catch (err) {
      throw this.toFsError(err, path);
    }
    this.invalidate(segments.length === 0 ? name : `${segments.join('/')}/${name}`);
  }

  async refresh(): Promise<RefreshReport> {
    // Local mounts have no body cache to revalidate; refresh is a no-op
    // beyond what `MountIndex` does (re-walk for fast-discovery cache).
    // `MountIndex` re-walking lives in mount-index.ts and is triggered by
    // virtual-fs.ts; not the backend's job to drive it.
    this.assertOpen('/');
    // Drop resolved handles so a re-walk starts from the live tree.
    this.dirCache.clear();
    return { added: [], removed: [], changed: [], unchanged: 0, errors: [] };
  }

  describe(): MountDescription {
    return { displayName: this.handle.name };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.dirCache.clear();
  }
}
