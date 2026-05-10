/**
 * VirtualFS — POSIX-like virtual filesystem backed by LightningFS.
 *
 * This is the single unified filesystem used throughout the application:
 * - Shell operations (just-bash via VfsAdapter)
 * - Git operations (isomorphic-git)
 * - File browser UI
 * - Agent tools
 */

import FS from '@isomorphic-git/lightning-fs';
import type {
  DirEntry,
  Encoding,
  EntryType,
  FileContent,
  MkdirOptions,
  ReadFileOptions,
  RmOptions,
  Stats,
} from './types.js';
import { FsError } from './types.js';
import { normalizePath, splitPath, joinPath } from './path-utils.js';
import type { FsWatcher } from './fs-watcher.js';
import {
  saveMountEntry,
  removeMountEntry,
  clearMountEntries,
  loadMountHandle,
} from './mount-table-store.js';
import type { BackendDescriptor, MountTableEntry } from './mount-table-store.js';
import type { MountBackend, RefreshReport } from './mount/backend.js';
import { LocalMountBackend } from './mount/backend-local.js';
import { MountIndex } from './mount-index.js';

/** Maximum number of symlink hops before throwing ELOOP. */
const MAX_SYMLINK_DEPTH = 10;

export interface VirtualFsOptions {
  /** Database name for LightningFS IndexedDB storage. */
  dbName?: string;
  /** Wipe existing data on init. */
  wipe?: boolean;
}

export class VirtualFS {
  private lfs: FS.PromisifiedFS;
  private rawFs: FS;
  private _ready: Promise<void>;
  /**
   * Map from absolute mount path → MountBackend instance. The backend
   * abstracts over local FS Access handles (`LocalMountBackend`), S3
   * (`S3MountBackend`), and DA (`DaMountBackend`); read/write paths in this
   * file route operations through `backend.method()` rather than reaching
   * into a handle directly.
   */
  private mountPoints = new Map<string, MountBackend>();
  /**
   * Paths that were registered via `mountInternal` instead of the
   * user-facing `mount()`. Hidden from `listMounts()` (so
   * `RestrictedFS` can't see them, scoops can't browse them, and they
   * don't appear in `mount list` output) but still routed through
   * `mountPoints` for path resolution. Used today only for the
   * kernel `/proc` mount.
   */
  private internalMounts = new Set<string>();
  private watcher: FsWatcher | null = null;
  private readonly dbName: string;
  /** BroadcastChannel for syncing mount registrations across VFS instances with the same dbName. */
  private mountSyncChannel: BroadcastChannel | null = null;
  /** Index of files in mounted directories for fast discovery. */
  private mountIndex = new MountIndex();

  private constructor(dbName: string, wipe: boolean) {
    this.dbName = dbName;
    const fs = new FS(dbName, { wipe });
    this.rawFs = fs;
    this.lfs = fs.promises;
    // LightningFS initializes asynchronously; wait for first stat to complete
    this._ready = this.lfs
      .stat('/')
      .then(() => {})
      .catch(() => {});

    // Set up BroadcastChannel for mount point synchronization. Messages
    // carry a `BackendDescriptor` (not the live backend, which isn't
    // structured-cloneable for remote backends); peer instances reconstruct
    // the backend per descriptor kind via `reconstructBackendFromDescriptor`.
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        this.mountSyncChannel = new BroadcastChannel(`vfs-mount-sync:${dbName}`);
        this.mountSyncChannel.onmessage = (event: MessageEvent) => {
          const { type, path, descriptor } = event.data ?? {};
          if (type === 'mount' && typeof path === 'string' && descriptor) {
            void this.reconstructBackendFromDescriptor(descriptor as BackendDescriptor)
              .then((backend) => {
                this.mountPoints.set(path, backend);
                if (backend.kind === 'local') {
                  this.mountIndex.registerMount(path, (backend as LocalMountBackend).getHandle());
                }
                this.watcher?.notify([{ type: 'modify', path, entryType: 'directory' }]);
              })
              .catch(() => {
                // Peer reconstruction is best-effort; if we can't rebuild
                // the backend (e.g. handle GCed, profile missing), the
                // mount is unavailable on this instance until a fresh
                // mount() call.
              });
          } else if (type === 'unmount' && typeof path === 'string') {
            const backend = this.mountPoints.get(path);
            this.mountPoints.delete(path);
            this.mountIndex.unregisterMount(path);
            void backend?.close();
            this.watcher?.notify([{ type: 'modify', path, entryType: 'directory' }]);
          }
        };
      } catch {
        // BroadcastChannel may fail in some contexts — mount sync is best-effort
      }
    }
  }

  /** Create a VirtualFS instance. */
  static async create(options?: VirtualFsOptions): Promise<VirtualFS> {
    const dbName = options?.dbName ?? 'browser-fs';
    const wipe = options?.wipe ?? false;
    const vfs = new VirtualFS(dbName, wipe);
    await vfs._ready;
    if (wipe) {
      await clearMountEntries().catch(() => {});
    }
    return vfs;
  }

  /** Get the underlying LightningFS promises API (for isomorphic-git). */
  getLightningFS(): FS.PromisifiedFS {
    return this.lfs;
  }

  /**
   * Writability predicate — the unrestricted VirtualFS has no ACL, so every
   * path is writable. Exists to mirror {@link RestrictedFS.canWrite} so
   * callers (e.g., the `agent` shell command) can duck-type across both
   * without checking which instance they hold.
   */
  canWrite(_path: string): boolean {
    return true;
  }

  /** Attach a file system watcher for change notifications. */
  setWatcher(watcher: FsWatcher | null): void {
    this.watcher = watcher;
  }

  /** Get the attached watcher, or null. */
  getWatcher(): FsWatcher | null {
    return this.watcher;
  }

  /**
   * Close the underlying IndexedDB connection and release resources.
   * Must be called when the VirtualFS instance is no longer needed (e.g., in test cleanup).
   */
  async dispose(): Promise<void> {
    this.mountSyncChannel?.close();
    this.mountSyncChannel = null;
    this.watcher?.dispose();
    this.watcher = null;
    this.mountIndex.dispose();

    const pfs = this.lfs as any;

    // 1. Cancel any pending deactivation timeout
    if (pfs._deactivationTimeout) {
      clearTimeout(pfs._deactivationTimeout);
      pfs._deactivationTimeout = null;
    }

    // 2. Wait for any pending operations to complete
    if (pfs._operations?.size > 0) {
      await pfs._gracefulShutdown?.();
    }

    // 3. Cancel the debounced saveSuperblock timer in DefaultBackend
    if (pfs._backend?.saveSuperblock?.cancel) {
      pfs._backend.saveSuperblock.cancel();
    }

    // 4. Flush pending writes then deactivate (closes IDB via IdbBackend.close())
    if (pfs._backend) {
      try {
        if (pfs._backend.flush) await pfs._backend.flush();
      } catch {
        /* may fail if not activated */
      }
      if (pfs._backend.deactivate) {
        await pfs._backend.deactivate();
      }
    }

    // 5. Null out retained references so the entire LFS tree can be GC'd
    pfs._backend = null;
    pfs._activationPromise = null;
    pfs._deactivationPromise = null;
    pfs._initPromise = null;

    // 6. Delete the IndexedDB database to free memory (critical for fake-indexeddb in tests)
    if (typeof indexedDB !== 'undefined' && indexedDB.deleteDatabase) {
      try {
        const req = indexedDB.deleteDatabase(this.dbName);
        await new Promise<void>((resolve, reject) => {
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        });
      } catch {
        // Best effort — may fail if IndexedDB is not available
      }
    }
  }

  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // Synchronous fast-path: direct CacheFS access for non-mounted paths
  // ---------------------------------------------------------------------------

  /**
   * Access the LightningFS in-memory CacheFS tree directly.
   * Returns null if the cache is not activated or the internal structure
   * doesn't match expectations (e.g. after a LightningFS upgrade).
   *
   * The CacheFS tree is a nested Map where:
   * - Key 0 (STAT) holds { mode, type, size, ino, mtimeMs }
   * - String keys are child entry names mapping to sub-Maps
   *
   * This is a private LightningFS internal. The `cachefs-internals` test
   * suite validates the structure so upgrades that break it are caught.
   */
  private getCacheFS(): any | null {
    try {
      const cache = (this.lfs as any)._backend?._cache;
      if (cache?.activated && cache._root instanceof Map) return cache;
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Synchronous readDir for non-mounted LightningFS paths.
   * Returns null if the path is under a mount or the CacheFS fast path is
   * unavailable — callers must fall back to the async `readDir()`.
   */
  readDirSync(path: string): DirEntry[] | null {
    const normalized = normalizePath(path);
    if (this.findMount(normalized)) return null;
    const cache = this.getCacheFS();
    if (!cache) return null;
    try {
      // CacheFS.readdir follows symlinks in the path (via _lookup with follow=true)
      const names: string[] = cache.readdir(normalized);
      const entries: DirEntry[] = [];
      for (const name of names) {
        const childPath = normalized === '/' ? `/${name}` : `${normalized}/${name}`;
        try {
          // lstat does NOT follow the leaf symlink — gives us the entry's own type
          const stat = cache.lstat(childPath);
          const type: EntryType =
            stat.type === 'symlink' ? 'symlink' : stat.type === 'dir' ? 'directory' : 'file';
          entries.push({ name, type });
        } catch {
          // Skip entries we can't stat (shouldn't happen in CacheFS)
        }
      }
      return entries;
    } catch {
      return null;
    }
  }

  /**
   * Synchronous stat (follows symlinks) for non-mounted LightningFS paths.
   * Returns null if the path is under a mount, the CacheFS fast path is
   * unavailable, or the symlink target is in a mounted tree.
   *
   * Enforces MAX_SYMLINK_DEPTH to stay consistent with the async realpath().
   * CacheFS._lookup follows symlinks internally without a depth limit, so we
   * manually resolve symlinks with a hop counter before calling stat.
   */
  statSync(path: string): Stats | null {
    const normalized = normalizePath(path);
    if (this.findMount(normalized)) return null;
    const cache = this.getCacheFS();
    if (!cache) return null;
    try {
      // Manually resolve symlinks with a depth limit matching the async path.
      const resolved = this.resolveSymlinksSync(cache, normalized);
      if (resolved === null) return null;
      const s = cache.lstat(resolved);
      // After full resolution, result should be file or dir, not symlink.
      return {
        type: s.type === 'dir' ? 'directory' : 'file',
        size: s.size ?? 0,
        mtime: s.mtimeMs ?? Date.now(),
        ctime: s.mtimeMs ?? Date.now(),
      };
    } catch {
      return null;
    }
  }

  /**
   * Synchronously resolve all symlinks in a path using CacheFS, with a hop
   * limit matching MAX_SYMLINK_DEPTH. Returns null if the limit is exceeded
   * or the target is unresolvable (e.g. in a mount).
   *
   * Uses a shared mutable counter so that hops accumulate across recursive
   * calls (matching the async realpath behavior).
   */
  private resolveSymlinksSync(
    cache: any,
    path: string,
    hops: { count: number } = { count: 0 }
  ): string | null {
    const parts = path.split('/').filter(Boolean);
    let resolved = '/';
    for (const part of parts) {
      resolved = resolved === '/' ? `/${part}` : `${resolved}/${part}`;
      try {
        const s = cache.lstat(resolved);
        if (s.type === 'symlink') {
          if (++hops.count > MAX_SYMLINK_DEPTH) return null;
          const target = s.target;
          if (target.startsWith('/')) {
            resolved = normalizePath(target);
          } else {
            const { dir } = splitPath(resolved);
            resolved = normalizePath(joinPath(dir, target));
          }
          // Recursively resolve — shared hops object accumulates across calls
          const full = this.resolveSymlinksSync(cache, resolved, hops);
          if (full === null) return null;
          resolved = full;
        }
      } catch {
        return null;
      }
    }
    return resolved;
  }

  /**
   * Synchronous lstat (does NOT follow symlinks) for non-mounted paths.
   * Returns null if the fast path is unavailable.
   */
  lstatSync(path: string): Stats | null {
    const normalized = normalizePath(path);
    if (this.findMount(normalized)) return null;
    const cache = this.getCacheFS();
    if (!cache) return null;
    try {
      const s = cache.lstat(normalized);
      if (s.type === 'symlink') {
        return {
          type: 'symlink',
          size: s.size ?? 0,
          mtime: s.mtimeMs ?? Date.now(),
          ctime: s.mtimeMs ?? Date.now(),
          isSymlink: true,
          symlinkTarget: s.target,
        };
      }
      return {
        type: s.type === 'dir' ? 'directory' : 'file',
        size: s.size ?? 0,
        mtime: s.mtimeMs ?? Date.now(),
        ctime: s.mtimeMs ?? Date.now(),
      };
    } catch {
      return null;
    }
  }

  // File System Access API mount support
  // ---------------------------------------------------------------------------

  /**
   * Mount a real filesystem directory (from File System Access API) at an
   * absolute VirtualFS path. All reads and writes under that path are
   * transparently bridged to the real directory handle — no copying occurs.
   *
   * A placeholder directory is created in LightningFS so that ancestor paths
   * (e.g. `cd /workspace`) resolve correctly.
   */
  async mount(absolutePath: string, backend: MountBackend): Promise<void> {
    const normalized = normalizePath(absolutePath);
    if (this.mountPoints.has(normalized)) {
      throw new FsError('EEXIST', 'mount point is already mounted', normalized);
    }

    try {
      const existing = await this.lstat(normalized);
      if (existing.type !== 'directory') {
        throw new FsError('ENOTDIR', 'mount point must be a directory', normalized);
      }
      const entries = await this.readDir(normalized);
      if (entries.length > 0) {
        throw new FsError(
          'ENOTEMPTY',
          'mount point must be empty to avoid shadowing existing files',
          normalized
        );
      }
    } catch (err) {
      if (!(err instanceof FsError) || err.code !== 'ENOENT') {
        throw err;
      }
    }

    // Ensure parent dirs exist in LFS, then create placeholder for mount root
    const { dir } = splitPath(normalized);
    if (dir !== '/') await this.mkdir(dir, { recursive: true });
    try {
      await this.lfs.mkdir(normalized);
    } catch {
      /* EEXIST is fine */
    }
    this.mountPoints.set(normalized, backend);
    // For local backends, register the underlying handle with MountIndex
    // so fast directory walks work. Remote backends have their own
    // listing cache (RemoteMountCache); MountIndex stays local-only.
    if (backend.kind === 'local') {
      this.mountIndex.registerMount(normalized, (backend as LocalMountBackend).getHandle());
    }
    // Build the persistence descriptor.
    const descriptor: BackendDescriptor =
      backend.kind === 'local'
        ? { kind: 'local', mountId: backend.mountId, idbHandleKey: normalized }
        : backend.kind === 's3'
          ? {
              kind: 's3',
              mountId: backend.mountId,
              source: backend.source!,
              profile: backend.profile ?? 'default',
            }
          : {
              kind: 'da',
              mountId: backend.mountId,
              source: backend.source!,
              profile: backend.profile ?? 'default',
            };
    try {
      this.mountSyncChannel?.postMessage({ type: 'mount', path: normalized, descriptor });
    } catch {
      /* Best-effort sync: local mount is already registered */
    }
    this.watcher?.notify([{ type: 'modify', path: normalized, entryType: 'directory' }]);
    // Persist to IndexedDB (best-effort)
    try {
      const entry: MountTableEntry = {
        targetPath: normalized,
        descriptor,
        createdAt: Date.now(),
      };
      const handle =
        backend.kind === 'local' ? (backend as LocalMountBackend).getHandle() : undefined;
      await saveMountEntry(entry, handle);
    } catch {
      /* best-effort persistence */
    }
  }

  /** Remove a mount point (the LFS placeholder directory is left in place). */
  async unmount(absolutePath: string): Promise<void> {
    const normalized = normalizePath(absolutePath);
    const backend = this.mountPoints.get(normalized);
    this.mountPoints.delete(normalized);
    this.mountIndex.unregisterMount(normalized);
    // Sync to peers and notify watchers BEFORE awaiting close, so callers
    // who don't await unmount() still propagate the removal synchronously.
    try {
      this.mountSyncChannel?.postMessage({ type: 'unmount', path: normalized });
    } catch {
      /* best-effort sync */
    }
    this.watcher?.notify([{ type: 'modify', path: normalized, entryType: 'directory' }]);
    // close() aborts in-flight requests and marks the backend closed; any
    // pending op against it now throws EBADF.
    await backend?.close();
    // Remove from IndexedDB (best-effort)
    try {
      await removeMountEntry(normalized);
    } catch {
      /* best-effort persistence */
    }
  }

  /**
   * Reconstruct a `MountBackend` from a persisted descriptor. Used by
   * BroadcastChannel peer sync.
   */
  private async reconstructBackendFromDescriptor(
    descriptor: BackendDescriptor
  ): Promise<MountBackend> {
    switch (descriptor.kind) {
      case 'local': {
        const handle = await loadMountHandle(descriptor.idbHandleKey);
        if (!handle) throw new Error(`no handle stored for ${descriptor.idbHandleKey}`);
        return LocalMountBackend.fromHandle(handle, { mountId: descriptor.mountId });
      }
      case 's3': {
        const { S3MountBackend, RemoteMountCache, makeSignedFetchS3 } =
          await import('./mount/index.js');
        const cache = new RemoteMountCache({ mountId: descriptor.mountId, ttlMs: 30_000 });
        return new S3MountBackend({
          source: descriptor.source,
          profile: descriptor.profile,
          cache,
          mountId: descriptor.mountId,
          signedFetch: makeSignedFetchS3(descriptor.profile),
        });
      }
      case 'da': {
        const { DaMountBackend, RemoteMountCache, makeSignedFetchDa } =
          await import('./mount/index.js');
        const cache = new RemoteMountCache({ mountId: descriptor.mountId, ttlMs: 30_000 });
        return new DaMountBackend({
          source: descriptor.source,
          profile: descriptor.profile,
          cache,
          mountId: descriptor.mountId,
          signedFetch: makeSignedFetchDa(),
        });
      }
    }
  }

  /**
   * Return the list of user-visible mount paths. Internal mounts
   * (registered via `mountInternal`) are deliberately excluded —
   * `RestrictedFS` reads from this list to enumerate scoop-readable
   * prefixes, and `mount list` displays it directly.
   */
  listMounts(): string[] {
    const out: string[] = [];
    for (const path of this.mountPoints.keys()) {
      if (!this.internalMounts.has(path)) out.push(path);
    }
    return out;
  }

  /**
   * Return internal mount paths. For introspection / debugging
   * only; not exposed to `RestrictedFS` or `mount list`.
   */
  listInternalMounts(): string[] {
    return [...this.internalMounts];
  }

  /**
   * Register a backend at `absolutePath` without persistence or
   * peer-sync. Used by the kernel for `/proc` and reserved for
   * any future kernel-only mount (`/dev`, `/sys`, …) that should
   * not be visible to scoops or survive a reload.
   *
   * Differences from `mount()`:
   *   - skips `saveMountEntry` (no IDB row);
   *   - skips `mountSyncChannel.postMessage` (no peer sync);
   *   - tags the path in `internalMounts` so `listMounts()` /
   *     `RestrictedFS.getAllPrefixes()` exclude it;
   *   - skips `mountIndex.registerMount` (kernel mounts have no
   *     `FileSystemDirectoryHandle` to walk).
   *
   * Same as `mount()`: the path's parent dirs are created in
   * LightningFS, and a placeholder directory at `absolutePath` is
   * created so ancestor lookups (`cd /proc`) resolve. Throws
   * `EEXIST` if the path is already a mount point (regular or
   * internal).
   */
  async mountInternal(absolutePath: string, backend: MountBackend): Promise<void> {
    const normalized = normalizePath(absolutePath);
    if (this.mountPoints.has(normalized)) {
      throw new FsError('EEXIST', 'mount point is already mounted', normalized);
    }
    // Create parent + placeholder so path resolution works.
    const { dir } = splitPath(normalized);
    if (dir !== '/') await this.mkdir(dir, { recursive: true });
    try {
      await this.lfs.mkdir(normalized);
    } catch {
      /* EEXIST is fine */
    }
    this.mountPoints.set(normalized, backend);
    this.internalMounts.add(normalized);
    this.watcher?.notify([{ type: 'modify', path: normalized, entryType: 'directory' }]);
  }

  /**
   * Unregister an internal mount. Idempotent; throws
   * `ENOENT` if the path was never registered as internal.
   */
  async unmountInternal(absolutePath: string): Promise<void> {
    const normalized = normalizePath(absolutePath);
    if (!this.internalMounts.has(normalized)) {
      throw new FsError('ENOENT', 'not an internal mount point', normalized);
    }
    const backend = this.mountPoints.get(normalized);
    this.mountPoints.delete(normalized);
    this.internalMounts.delete(normalized);
    this.watcher?.notify([{ type: 'modify', path: normalized, entryType: 'directory' }]);
    await backend?.close();
  }

  /**
   * Get the mount index for fast file discovery in mounted directories.
   */
  getMountIndex(): MountIndex {
    return this.mountIndex;
  }

  /**
   * Re-index a mounted directory. Use after external changes.
   * @throws Error if the path is not a mount point
   */
  async refreshMount(mountPath: string, opts?: { bodies?: boolean }): Promise<RefreshReport> {
    const normalized = normalizePath(mountPath);
    const backend = this.mountPoints.get(normalized);
    if (!backend) {
      throw new FsError('ENOENT', 'not a mount point', normalized);
    }
    const report = await backend.refresh(opts);
    // Local backend's refresh is a no-op; existing MountIndex re-walk still
    // happens here for local mounts.
    if (backend.kind === 'local') {
      await this.mountIndex.refreshMount(normalized);
    }
    return report;
  }

  /**
   * Check whether an absolute path is under any active mount point.
   * Non-allocating (iterates the mount map directly) — safe to call on a hot
   * path such as the per-operation check in the isomorphic-git fs adapter.
   */
  isPathUnderMount(path: string): boolean {
    for (const mountPath of this.mountPoints.keys()) {
      if (path === mountPath || path.startsWith(mountPath + '/')) return true;
    }
    return false;
  }

  /**
   * Find the mount point that owns `path`.
   * Returns the mount path, handle, and the path segments relative to the mount root,
   * or null if the path is not under any mount.
   */
  /**
   * Re-throw an `FsError` from a backend with the VFS-absolute path. Backend
   * implementations are agnostic to where they're mounted, so they throw with
   * mount-relative paths (e.g. `'pack'`); callers expect the path they passed
   * in (e.g. `'/mnt/repo/pack'`).
   */
  private static rebrandFsError(err: unknown, normalizedPath: string): never {
    if (err instanceof FsError) {
      // FsError's `message` field is the constructor parameter; the displayed
      // Error.message is `${code}: ${message}${path ? ` '${path}'` : ''}`.
      // Extract the inner message so the rebranded error keeps the same text.
      const codePrefix = `${err.code}: `;
      let inner = err.message;
      if (inner.startsWith(codePrefix)) inner = inner.slice(codePrefix.length);
      if (err.path && inner.endsWith(` '${err.path}'`)) {
        inner = inner.slice(0, inner.length - ` '${err.path}'`.length);
      }
      throw new FsError(err.code, inner, normalizedPath);
    }
    throw err;
  }

  private findMount(
    path: string
  ): { path: string; backend: MountBackend; relParts: string[] } | null {
    let bestMatch: { mountPath: string; backend: MountBackend } | null = null;

    for (const [mountPath, backend] of this.mountPoints) {
      const isMatch = path === mountPath || path.startsWith(mountPath + '/');
      if (!isMatch) continue;
      if (!bestMatch || mountPath.length > bestMatch.mountPath.length) {
        bestMatch = { mountPath, backend };
      }
    }

    if (!bestMatch) return null;

    if (path === bestMatch.mountPath) {
      return { path: bestMatch.mountPath, backend: bestMatch.backend, relParts: [] };
    }

    return {
      path: bestMatch.mountPath,
      backend: bestMatch.backend,
      relParts: path
        .slice(bestMatch.mountPath.length + 1)
        .split('/')
        .filter(Boolean),
    };
  }

  /**
   * Read a file's content.
   * @throws FsError ENOENT if file doesn't exist, EISDIR if path is a directory
   */
  async readFile(path: string, options?: ReadFileOptions): Promise<FileContent> {
    const normalized = normalizePath(path);
    const mount = this.findMount(normalized);
    if (mount) {
      if (mount.relParts.length === 0) throw new FsError('EISDIR', 'is a directory', normalized);
      const relPath = mount.relParts.join('/');
      try {
        const body = await mount.backend.readFile(relPath);
        const encoding = options?.encoding ?? 'utf-8';
        if (encoding === 'utf-8') return new TextDecoder('utf-8').decode(body);
        return body;
      } catch (err) {
        VirtualFS.rebrandFsError(err, normalized);
      }
    }
    // Resolve symlinks before reading
    const resolved = await this.resolveSymlinks(normalized);
    try {
      const encoding = options?.encoding ?? 'utf-8';
      if (encoding === 'utf-8') {
        return await this.lfs.readFile(resolved, { encoding: 'utf8' });
      } else {
        return await this.lfs.readFile(resolved);
      }
    } catch (err) {
      throw this.convertError(err, normalized);
    }
  }

  /**
   * Write content to a file. Creates the file if it doesn't exist.
   * Parent directories are created automatically.
   * @throws FsError EISDIR if path is an existing directory
   */
  async writeFile(
    path: string,
    content: FileContent,
    _options?: { recursive?: boolean }
  ): Promise<void> {
    const normalized = normalizePath(path);
    const mount = this.findMount(normalized);
    if (mount) {
      if (mount.relParts.length === 0) throw new FsError('EISDIR', 'is a directory', normalized);
      const relPath = mount.relParts.join('/');
      let wasExisting = false;
      try {
        await this.stat(normalized);
        wasExisting = true;
      } catch {
        /* file doesn't exist yet */
      }
      // Preserve byteOffset/byteLength: pooled Buffer instances share a
      // backing ArrayBuffer with other allocations, so `content.buffer`
      // alone would write the whole pool.
      const data =
        typeof content === 'string'
          ? new TextEncoder().encode(content)
          : content instanceof Uint8Array
            ? new Uint8Array(content.buffer, content.byteOffset, content.byteLength)
            : new Uint8Array(content as ArrayBuffer);
      try {
        await mount.backend.writeFile(relPath, data);
      } catch (err) {
        VirtualFS.rebrandFsError(err, normalized);
      }
      this.watcher?.notify([
        {
          type: wasExisting ? 'modify' : 'create',
          path: normalized,
          entryType: 'file',
        },
      ]);
      // Update mount index for fast discovery (idempotent, safe to call always)
      this.mountIndex.notifyWrite(normalized);
      return;
    }
    // Resolve symlinks before writing
    let resolved: string;
    try {
      resolved = await this.resolveSymlinks(normalized);
    } catch {
      // Path doesn't exist yet — that's fine for new files, use the original path
      resolved = normalized;
    }
    // Check existence before write to determine create vs modify.
    // Use lfs.stat() directly instead of this.exists() to avoid extra
    // symlink-resolution IDB round-trips that leave pending LFS background ops.
    let wasExisting = false;
    try {
      await this.lfs.stat(resolved);
      wasExisting = true;
    } catch {
      /* file doesn't exist yet */
    }
    // Ensure parent directory exists
    const { dir } = splitPath(resolved);
    if (dir !== '/') {
      await this.mkdir(dir, { recursive: true });
    }
    try {
      await this.lfs.writeFile(resolved, content);
    } catch (err) {
      throw this.convertError(err, normalized);
    }
    this.watcher?.notify([
      {
        type: wasExisting ? 'modify' : 'create',
        path: resolved,
        entryType: 'file',
      },
    ]);
  }

  /**
   * List entries in a directory.
   * @throws FsError ENOENT if directory doesn't exist, ENOTDIR if path is a file
   */
  async readDir(path: string): Promise<DirEntry[]> {
    const normalized = normalizePath(path);
    const mount = this.findMount(normalized);
    if (mount) {
      // Fast path: use MountIndex if available
      const indexedEntries = this.mountIndex.getDirectoryEntries(mount.path, normalized);
      if (indexedEntries !== undefined) {
        const entries = new Map<string, DirEntry>();
        for (const entry of indexedEntries) {
          entries.set(entry.name, { name: entry.name, type: entry.type });
        }
        // Also include nested mount points as virtual directories
        const childPrefix = normalized === '/' ? '/' : `${normalized}/`;
        for (const mountPath of this.mountPoints.keys()) {
          if (mountPath === normalized || !mountPath.startsWith(childPrefix)) continue;
          const relPath = mountPath.slice(childPrefix.length);
          if (!relPath || relPath.includes('/')) continue;
          if (!entries.has(relPath)) {
            entries.set(relPath, { name: relPath, type: 'directory' });
          }
        }
        return [...entries.values()];
      }

      // Slow path: backend.readDir
      const relPath = mount.relParts.join('/') || '/';
      let dirEntries;
      try {
        dirEntries = await mount.backend.readDir(relPath);
      } catch (err) {
        VirtualFS.rebrandFsError(err, normalized);
      }
      const entries = new Map<string, DirEntry>();
      for (const entry of dirEntries) {
        entries.set(entry.name, {
          name: entry.name,
          type: entry.kind === 'directory' ? 'directory' : 'file',
        });
      }

      const childPrefix = normalized === '/' ? '/' : `${normalized}/`;
      for (const mountPath of this.mountPoints.keys()) {
        if (mountPath === normalized || !mountPath.startsWith(childPrefix)) continue;
        const relPath2 = mountPath.slice(childPrefix.length);
        if (!relPath2 || relPath2.includes('/')) continue;
        if (!entries.has(relPath2)) {
          entries.set(relPath2, { name: relPath2, type: 'directory' });
        }
      }
      return [...entries.values()];
    }
    // Resolve symlinks in the directory path itself
    const resolved = await this.resolveSymlinks(normalized);
    try {
      const names = await this.lfs.readdir(resolved);
      const entries: DirEntry[] = [];
      for (const name of names) {
        const childPath = resolved === '/' ? `/${name}` : `${resolved}/${name}`;
        try {
          const s = await this.lfs.lstat(childPath);
          if (s.isSymbolicLink()) {
            entries.push({ name, type: 'symlink' });
          } else {
            entries.push({
              name,
              type: s.isDirectory() ? 'directory' : 'file',
            });
          }
        } catch {
          // Skip entries we can't stat
        }
      }
      return entries;
    } catch (err) {
      throw this.convertError(err, normalized);
    }
  }

  /**
   * Create a directory.
   * @throws FsError EEXIST if directory already exists (non-recursive),
   *                 ENOENT if parent doesn't exist (non-recursive)
   */
  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const normalized = normalizePath(path);
    if (normalized === '/') return; // Root always exists

    const mount = this.findMount(normalized);
    if (mount) {
      if (mount.relParts.length === 0) return; // mount root placeholder already exists
      const relPath = mount.relParts.join('/');
      const existed = await this.exists(normalized);
      try {
        await mount.backend.mkdir(relPath);
      } catch (err) {
        VirtualFS.rebrandFsError(err, normalized);
      }
      if (!existed) {
        this.watcher?.notify([{ type: 'create', path: normalized, entryType: 'directory' }]);
      }
      return;
    }

    if (options?.recursive) {
      // Create all parent directories
      const parts = normalized.split('/').filter(Boolean);
      let current = '';
      for (const part of parts) {
        current += '/' + part;
        try {
          await this.lfs.mkdir(current);
        } catch (err: unknown) {
          // Ignore EEXIST errors in recursive mode
          if (err instanceof Error && !err.message.includes('EEXIST')) {
            throw this.convertError(err, current);
          }
        }
      }
    } else {
      try {
        await this.lfs.mkdir(normalized);
      } catch (err) {
        throw this.convertError(err, normalized);
      }
      this.watcher?.notify([{ type: 'create', path: normalized, entryType: 'directory' }]);
    }
  }

  /**
   * Remove a file or directory.
   * @throws FsError ENOENT if path doesn't exist,
   *                 ENOTEMPTY if directory is not empty (non-recursive)
   */
  async rm(path: string, options?: RmOptions): Promise<void> {
    const normalized = normalizePath(path);
    const mount = this.findMount(normalized);
    if (mount) {
      if (mount.relParts.length === 0) {
        throw new FsError('EINVAL', 'cannot remove a mount point — use unmount', normalized);
      }
      let entryType: EntryType | undefined;
      try {
        entryType = (await this.stat(normalized)).type;
      } catch {
        /* best effort */
      }
      const relPath = mount.relParts.join('/');
      try {
        await mount.backend.remove(relPath, { recursive: options?.recursive });
      } catch (err) {
        VirtualFS.rebrandFsError(err, normalized);
      }
      this.watcher?.notify([{ type: 'delete', path: normalized, entryType }]);
      // Update mount index
      this.mountIndex.notifyDelete(normalized);
      return;
    }
    try {
      // Use lstat to detect symlinks — if it's a symlink, just unlink it
      // (don't follow the link or recurse into a target directory)
      const s = await this.lfs.lstat(normalized);
      if (s.isSymbolicLink()) {
        await this.lfs.unlink(normalized);
      } else if (s.isDirectory()) {
        if (options?.recursive) {
          await this.rmRecursive(normalized);
        } else {
          await this.lfs.rmdir(normalized);
        }
      } else {
        await this.lfs.unlink(normalized);
      }
    } catch (err) {
      throw this.convertError(err, normalized);
    }
    this.watcher?.notify([{ type: 'delete', path: normalized }]);
  }

  private async rmRecursive(path: string): Promise<void> {
    const entries = await this.lfs.readdir(path);
    for (const name of entries) {
      const childPath = path === '/' ? `/${name}` : `${path}/${name}`;
      const stat = await this.lfs.stat(childPath);
      if (stat.isDirectory()) {
        await this.rmRecursive(childPath);
      } else {
        await this.lfs.unlink(childPath);
      }
    }
    await this.lfs.rmdir(path);
  }

  /**
   * Get metadata about a file or directory.
   * @throws FsError ENOENT if path doesn't exist
   */
  async stat(path: string): Promise<Stats> {
    const normalized = normalizePath(path);
    const mount = this.findMount(normalized);
    if (mount) {
      if (mount.relParts.length === 0) {
        // Mount root: LFS has a placeholder dir — just use it
        try {
          const s = await this.lfs.stat(normalized);
          return { type: 'directory', size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs };
        } catch {
          return { type: 'directory', size: 0, mtime: Date.now(), ctime: Date.now() };
        }
      }
      const relPath = mount.relParts.join('/');
      try {
        const ms = await mount.backend.stat(relPath);
        return {
          type: ms.kind === 'directory' ? 'directory' : 'file',
          size: ms.size,
          mtime: ms.mtime,
          ctime: ms.mtime,
        };
      } catch (err) {
        VirtualFS.rebrandFsError(err, normalized);
      }
    }
    // Resolve symlinks before stat — stat follows symlinks
    const resolved = await this.resolveSymlinks(normalized);
    try {
      const s = await this.lfs.stat(resolved);
      return {
        type: s.isDirectory() ? 'directory' : 'file',
        size: s.size,
        mtime: s.mtimeMs,
        ctime: s.ctimeMs,
      };
    } catch (err) {
      throw this.convertError(err, normalized);
    }
  }

  /** Check if a path exists. */
  async exists(path: string): Promise<boolean> {
    const normalized = normalizePath(path);
    const mount = this.findMount(normalized);
    if (mount) {
      if (mount.relParts.length === 0) return true;
      try {
        await this.stat(normalized);
        return true;
      } catch {
        return false;
      }
    }
    try {
      // Try following symlinks first (stat follows them)
      await this.stat(normalized);
      return true;
    } catch {
      // If stat fails (e.g., dangling symlink), check if the link itself exists
      try {
        await this.lfs.lstat(normalized);
        return true;
      } catch {
        return false;
      }
    }
  }

  /**
   * Rename or move a file/directory.
   * @throws FsError ENOENT if source doesn't exist
   */
  async rename(oldPath: string, newPath: string): Promise<void> {
    const normalizedOld = normalizePath(oldPath);
    const normalizedNew = normalizePath(newPath);
    let entryType: EntryType | undefined;
    try {
      entryType = (await this.lstat(normalizedOld)).type;
    } catch {
      /* best effort */
    }
    try {
      await this.lfs.rename(normalizedOld, normalizedNew);
    } catch (err) {
      throw this.convertError(err, normalizedOld);
    }
    this.watcher?.notify([
      { type: 'delete', path: normalizedOld, entryType },
      { type: 'create', path: normalizedNew, entryType },
    ]);
    // Update mount index if paths are under mounts
    this.mountIndex.notifyRename(normalizedOld, normalizedNew);
  }

  /**
   * Read a file as a string (convenience method).
   * @throws FsError ENOENT if file doesn't exist
   */
  async readTextFile(path: string): Promise<string> {
    const content = await this.readFile(path, { encoding: 'utf-8' });
    return content as string;
  }

  /**
   * Recursively walk a directory tree, yielding all file paths.
   * Follows symlinks to directories but tracks visited real paths to avoid infinite loops.
   *
   * For mounted directories with a ready index, uses the fast path (O(n) iteration
   * over cached file list). Falls back to slow recursive readDir otherwise.
   */
  async *walk(path: string, _visited?: Set<string>): AsyncGenerator<string> {
    const normalized = normalizePath(path);

    // Fast path: check if this path is exactly a mount point with a ready index.
    // We check on every call (including recursive) so that walking from '/' can
    // switch to indexed iteration when it enters a mounted subtree.
    // Only use fast path when:
    // 1. The path IS the mount point (not a subdirectory of it)
    // 2. The mount's index is ready
    // 3. There are no nested mounts under this path
    if (this.mountPoints.size > 0 && this.mountPoints.has(normalized)) {
      const hasNestedMounts = [...this.mountPoints.keys()].some(
        (mp) => mp !== normalized && mp.startsWith(normalized + '/')
      );

      if (!hasNestedMounts && this.mountIndex.isReady(normalized)) {
        const files = this.mountIndex.getFiles(normalized);
        if (files) {
          for (const filePath of files) {
            yield filePath;
          }
          return;
        }
      }
    }

    // Slow path: recursive readDir
    const visited = _visited ?? new Set<string>();

    // Track the real path to detect symlink loops
    let realPath: string;
    try {
      realPath = await this.realpath(normalized);
    } catch {
      realPath = normalized;
    }
    if (visited.has(realPath)) return; // Avoid infinite loops
    visited.add(realPath);

    const entries = await this.readDir(normalized);

    for (const entry of entries) {
      const childPath = normalized === '/' ? `/${entry.name}` : `${normalized}/${entry.name}`;
      if (entry.type === 'file') {
        yield childPath;
      } else if (entry.type === 'symlink') {
        // Determine if symlink points to a file or directory
        try {
          const targetStat = await this.stat(childPath);
          if (targetStat.type === 'file') {
            yield childPath;
          } else if (targetStat.type === 'directory') {
            yield* this.walk(childPath, visited);
          }
        } catch {
          // Dangling symlink — skip
        }
      } else {
        yield* this.walk(childPath, visited);
      }
    }
  }

  /**
   * Copy a file from one path to another.
   * @throws FsError ENOENT if source doesn't exist, EISDIR if source is a directory
   */
  async copyFile(src: string, dest: string): Promise<void> {
    const stat = await this.stat(src);
    if (stat.type === 'directory') {
      throw new FsError('EISDIR', 'is a directory', src);
    }
    const content = await this.readFile(src, { encoding: 'binary' });
    await this.writeFile(dest, content);
  }

  /**
   * Get the parent directory of a path.
   */
  dirname(path: string): string {
    return splitPath(normalizePath(path)).dir;
  }

  /**
   * Get the base name of a path.
   */
  basename(path: string): string {
    return splitPath(normalizePath(path)).base;
  }

  // ---------------------------------------------------------------------------
  // Symlink support
  // ---------------------------------------------------------------------------

  /**
   * Create a symbolic link at `linkPath` pointing to `target`.
   * Target can be absolute or relative (relative to the directory containing the link).
   * @throws FsError EEXIST if linkPath already exists
   */
  async symlink(target: string, linkPath: string): Promise<void> {
    const normalizedLinkPath = normalizePath(linkPath);
    const mount = this.findMount(normalizedLinkPath);
    if (mount) {
      throw new FsError(
        'EINVAL',
        'symlinks not supported on mounted filesystems',
        normalizedLinkPath
      );
    }
    // Ensure parent directory exists
    const { dir } = splitPath(normalizedLinkPath);
    if (dir !== '/') {
      await this.mkdir(dir, { recursive: true });
    }
    try {
      await this.lfs.symlink(target, normalizedLinkPath);
    } catch (err) {
      throw this.convertError(err, normalizedLinkPath);
    }
    this.watcher?.notify([{ type: 'create', path: normalizedLinkPath, entryType: 'symlink' }]);
  }

  /**
   * Read the target of a symbolic link without following it.
   * @throws FsError ENOENT if path doesn't exist, EINVAL if path is not a symlink
   */
  async readlink(path: string): Promise<string> {
    const normalized = normalizePath(path);
    try {
      return await this.lfs.readlink(normalized);
    } catch (err) {
      throw this.convertError(err, normalized);
    }
  }

  /**
   * Stat a path without following symlinks.
   * If the path is a symlink, returns type: 'symlink' with isSymlink and symlinkTarget set.
   */
  async lstat(path: string): Promise<Stats> {
    const normalized = normalizePath(path);
    const mount = this.findMount(normalized);
    if (mount) {
      // Mount points don't support symlinks — fall through to regular stat
      return this.stat(normalized);
    }
    try {
      const s = await this.lfs.lstat(normalized);
      if (s.isSymbolicLink()) {
        const target = await this.lfs.readlink(normalized);
        return {
          type: 'symlink',
          size: s.size,
          mtime: s.mtimeMs,
          ctime: s.ctimeMs,
          isSymlink: true,
          symlinkTarget: target,
        };
      }
      return {
        type: s.isDirectory() ? 'directory' : 'file',
        size: s.size,
        mtime: s.mtimeMs,
        ctime: s.ctimeMs,
      };
    } catch (err) {
      throw this.convertError(err, normalized);
    }
  }

  /**
   * Resolve all symlinks in a path to produce the final canonical path.
   * @throws FsError ELOOP if more than MAX_SYMLINK_DEPTH symlinks are encountered
   */
  async realpath(path: string, _hops = 0): Promise<string> {
    const normalized = normalizePath(path);
    const mount = this.findMount(normalized);
    if (mount) return normalized; // Mount paths are already real

    const parts = normalized.split('/').filter(Boolean);
    let resolved = '/';
    let hops = _hops;

    for (const part of parts) {
      resolved = resolved === '/' ? `/${part}` : `${resolved}/${part}`;
      try {
        const s = await this.lfs.lstat(resolved);
        if (s.isSymbolicLink()) {
          if (++hops > MAX_SYMLINK_DEPTH) {
            throw new FsError('ELOOP', 'too many levels of symbolic links', path);
          }
          const target = await this.lfs.readlink(resolved);
          if (target.startsWith('/')) {
            // Absolute symlink — restart resolution from the target
            resolved = normalizePath(target);
          } else {
            // Relative symlink — resolve relative to the link's parent directory
            const { dir } = splitPath(resolved);
            resolved = normalizePath(joinPath(dir, target));
          }
          // The resolved path itself may contain more symlinks — resolve it fully
          resolved = await this.realpath(resolved, hops);
        }
      } catch (err) {
        if (err instanceof FsError) throw err;
        throw this.convertError(err, resolved);
      }
    }

    return resolved;
  }

  /**
   * Internal helper: resolve symlinks in a path before an operation.
   * Used by readFile, writeFile, stat, etc. to follow symlinks transparently.
   * Only applies to LFS-backed paths (mount points are returned as-is).
   */
  private async resolveSymlinks(path: string): Promise<string> {
    const mount = this.findMount(path);
    if (mount) return path; // Mount points don't have symlinks
    return this.realpath(path);
  }

  /**
   * Convert LightningFS errors to FsError.
   */
  private convertError(err: unknown, path: string): FsError {
    if (err instanceof FsError) return err;
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ENOENT')) {
      return new FsError('ENOENT', 'no such file or directory', path);
    }
    if (msg.includes('EEXIST')) {
      return new FsError('EEXIST', 'file already exists', path);
    }
    if (msg.includes('ENOTDIR')) {
      return new FsError('ENOTDIR', 'not a directory', path);
    }
    if (msg.includes('EISDIR')) {
      return new FsError('EISDIR', 'is a directory', path);
    }
    if (msg.includes('ENOTEMPTY')) {
      return new FsError('ENOTEMPTY', 'directory not empty', path);
    }
    if (msg.includes('ELOOP')) {
      return new FsError('ELOOP', 'too many levels of symbolic links', path);
    }
    // Default to EINVAL for unknown errors
    return new FsError('EINVAL', msg, path);
  }
}

// For backwards compatibility, keep BackendType but it's no longer used
export type BackendType = 'lightningfs';
