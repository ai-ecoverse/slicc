/**
 * VirtualFS — POSIX-like virtual filesystem.
 *
 * Backed by `@zenfs/core`: `WebAccess` (from `@zenfs/dom`) rooted at an
 * OPFS subdirectory (`backend: 'opfs'`, the production default) in
 * browsers, or `InMemory` (`backend: 'memory'`) in Node/Vitest where
 * OPFS is unavailable. Both backends present the same Node-fs-promises
 * surface, so the rest of this file is backend-agnostic past the
 * constructor.
 *
 * This is the single unified filesystem used throughout the application:
 * - Shell operations (just-bash via VfsAdapter)
 * - Git operations (isomorphic-git)
 * - File browser UI
 * - Agent tools
 */

import type { FsWatcher } from './fs-watcher.js';
import type { MountBackend, RefreshReport } from './mount/backend.js';
import { LocalMountBackend } from './mount/backend-local.js';
import { MountIndex } from './mount-index.js';
import type { BackendDescriptor, MountTableEntry } from './mount-table-store.js';
import {
  clearMountEntries,
  loadMountHandle,
  removeMountEntry,
  saveMountEntry,
} from './mount-table-store.js';
import { joinPath, normalizePath, splitPath } from './path-utils.js';
import type {
  DirEntry,
  EntryType,
  FileContent,
  FsErrorCode,
  MkdirOptions,
  ReadFileOptions,
  RmOptions,
  Stats,
} from './types.js';
import { FsError } from './types.js';

/**
 * Maximum number of symlink hops {@link VirtualFS.realpath} will follow
 * before throwing `ELOOP`. ZenFS' own `vfs/async.js#resolve` recurses
 * without a hop counter, so a `/a → /b → /a` cycle explodes the async
 * stack and OOMs the process — see {@link VirtualFS.realpath} for the
 * bounded loop that protects against that.
 */
const MAX_SYMLINK_DEPTH = 10;

/** Backend identifier for {@link VirtualFS}. */
export type VfsBackend = 'memory' | 'opfs';

/**
 * Resolve the default VFS backend. Production browsers always select
 * OPFS via `navigator.storage.getDirectory`; Node/Vitest environments
 * without OPFS fall back to ZenFS' `InMemory` backend so tests stay
 * self-contained (no IDB shim, no FS-Access mock).
 */
export function resolveVfsBackendFromEnv(): VfsBackend {
  try {
    const storage = (globalThis as { navigator?: { storage?: { getDirectory?: unknown } } })
      .navigator?.storage;
    if (typeof storage?.getDirectory === 'function') return 'opfs';
  } catch {
    /* navigator may be unavailable in some test contexts */
  }
  return 'memory';
}

export interface VirtualFsOptions {
  /**
   * Identifier for this VFS instance. On `'opfs'` it names the OPFS
   * subdirectory the backend roots at; on `'memory'` it's a label
   * carried into the InMemory store (informational only — InMemory
   * does not persist across reloads).
   */
  dbName?: string;
  /** Wipe existing data on init. */
  wipe?: boolean;
  /**
   * Backend selection. Defaults to `'opfs'` in browsers; environments
   * without OPFS (Node tests) fall through to `'memory'`. Explicit
   * `backend` overrides resolution.
   */
  backend?: VfsBackend;
}

/**
 * Structural subset of `node:fs/promises` consumed by VirtualFS. Kept
 * loose intentionally — `@isomorphic-git/lightning-fs`'s legacy stats
 * shape (`isDirectory()` / `isSymbolicLink()` / `mode` / `mtimeMs`) and
 * ZenFS' Node-compatible `Stats` both satisfy it without further
 * adaptation. `readFile` returns string or Uint8Array depending on the
 * options.encoding; callers branch on the type they expect.
 */
interface FsPromisesLike {
  readFile(path: string, options?: unknown): Promise<unknown>;
  writeFile(path: string, data: unknown, options?: unknown): Promise<void>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string, options?: unknown): Promise<unknown>;
  rmdir(path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  stat(path: string): Promise<FsStatsLike>;
  lstat(path: string): Promise<FsStatsLike>;
  symlink(target: string, path: string): Promise<void>;
  readlink(path: string): Promise<string>;
  realpath?(path: string): Promise<string>;
}

interface FsStatsLike {
  size: number;
  mode: number;
  mtimeMs: number;
  ctimeMs: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** Structural subset of `node:fs` sync methods we lean on for the fast path. */
interface FsSyncLike {
  readdirSync?(path: string): string[];
  statSync?(path: string): FsStatsLike;
  lstatSync?(path: string): FsStatsLike;
  readlinkSync?(path: string): string;
}

export class VirtualFS {
  /**
   * Node-fs-promises-shaped client used by every public VirtualFS
   * method. Created in the constructor as a *deferred + prefixed*
   * proxy: each call awaits {@link _ready} (so callers that bypass
   * `VirtualFS.create` and use the constructor synchronously still
   * work), then forwards to {@link rawLfs} with paths translated
   * through {@link prefix}. Empty `mountRoot` (OPFS) skips
   * translation; non-empty `mountRoot` (memory) prepends it.
   */
  private lfs: FsPromisesLike;
  /** Sync counterpart to {@link lfs} — used by the sync fast paths. */
  private lfsSync: FsSyncLike;
  /**
   * Raw ZenFS `fs.promises` (assigned by `init*Backend`). The {@link
   * lfs} proxy looks this up lazily on every call so callers don't
   * need to re-acquire the reference after init.
   */
  private rawLfs: FsPromisesLike | null = null;
  /** Raw ZenFS sync surface (assigned by `init*Backend`). */
  private rawLfsSync: FsSyncLike | null = null;
  private _ready: Promise<void>;
  /**
   * Flips to `true` once {@link _ready} resolves so the {@link lfs}
   * proxy can skip `await this._ready` on the hot path. `await` on an
   * already-resolved promise still costs a microtask; for tens of
   * thousands of fs ops that adds measurable latency.
   */
  private _readyResolved = false;
  /** Backend selection — see {@link VfsBackend}. */
  public readonly backend: VfsBackend;
  /**
   * Map from absolute mount path → MountBackend instance. The backend
   * abstracts over local FS Access handles (`LocalMountBackend`), S3
   * (`S3MountBackend`), and DA (`DaMountBackend`); read/write paths in this
   * file route operations through `backend.method()` rather than reaching
   * into a handle directly.
   */
  private mountPoints = new Map<string, MountBackend>();
  /**
   * Live `WebAccessFS` instance for the OPFS backend (null on memory).
   * Captured from `@zenfs/core`'s mount registry right after `configure()`
   * so {@link flush} / {@link dispose} can serialize its in-memory index
   * (`index.toJSON()`) back to the metadata sidecar — ZenFS only READS
   * the sidecar on boot (`@zenfs/dom` `WebAccessFS._loadMetadata`) and
   * never writes it (`IndexFS.sync()` is a no-op), so VirtualFS owns the
   * write-back. The structural type matches the parts we touch
   * (`index.toJSON()`); the full class lives in `@zenfs/dom`.
   */
  private opfsBackendFs: { index: { toJSON: () => unknown } } | null = null;
  /** OPFS subdir handle for the current OPFS backend (null on memory). */
  private opfsHandle: FileSystemDirectoryHandle | null = null;
  /**
   * Path prefix prepended to every `this.lfs`/`this.lfsSync` call.
   * Empty on the OPFS backend (single global '/' mount). On the memory
   * backend each VirtualFS instance is mounted at `/__zenfs__/<dbName>`
   * so multiple instances can coexist without `configureSingle`
   * clobbering each other. {@link prefix} / {@link unprefix} translate
   * between VFS-visible (`/foo`) and underlying-ZenFS
   * (`/__zenfs__/<dbName>/foo`) paths.
   */
  private mountRoot: string = '';
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

  private constructor(
    dbName: string,
    wipe?: boolean,
    backend?: VfsBackend,
    opfsHandle?: FileSystemDirectoryHandle
  ) {
    this.dbName = dbName;
    // Default to InMemory for any non-'opfs' value (including `undefined`)
    // so callers that bypass `VirtualFS.create` and reach the constructor
    // directly (a handful of test fixtures) come up on the Node-safe
    // backend rather than failing on missing OPFS APIs.
    this.backend = backend === 'opfs' ? 'opfs' : 'memory';
    // `lfs` is a deferred+prefixing proxy created here so callers can
    // use the VFS immediately after `new VirtualFS(...)` without
    // awaiting `create()`. Each method on the proxy awaits `_ready`
    // before forwarding to `rawLfs` (which `init*Backend` populates).
    this.lfs = this.makeDeferredLfs();
    this.lfsSync = this.makeDeferredLfsSync();
    this._ready =
      this.backend === 'opfs'
        ? VirtualFS.initOpfsBackend(this, opfsHandle, wipe === true)
        : VirtualFS.initMemoryBackend(this, dbName, wipe === true);
    this._ready.then(
      () => {
        this._readyResolved = true;
      },
      () => {
        /* error path leaves _readyResolved false; ops will rethrow via await */
      }
    );

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

  /**
   * Mount an OPFS-backed `WebAccessFS` at a per-`dbName` subpath
   * (`/__opfs__/<dbName>`) so multiple OPFS-backed VirtualFS instances
   * with different `dbName`s coexist without clobbering each other.
   *
   * Earlier revisions called `configure({ mounts: { '/': … } })`, which
   * installs a GLOBAL `/` mount on the shared ZenFS module. A second
   * `initOpfsBackend` for a different `dbName` (e.g. the helper VFS at
   * `slicc-fs-global` used by git/MCP/OAuth) would then replace `/`
   * and silently disconnect the orchestrator's primary `slicc-fs`
   * instance from its OPFS tree (`/workspace` would resolve into the
   * helper's subdir). To avoid that, we:
   *
   *   1. Initialize a stub `InMemory` root once per realm via
   *      {@link ensureRootMount} so per-dbName sub-mounts have a root
   *      to attach to.
   *   2. Resolve a `WebAccessFS` instance directly via
   *      `resolveMountConfig(...)` (the same helper `configure` uses
   *      internally) so we can hand it to `mount(point, fs)` without
   *      replacing existing mounts.
   *   3. Mount at `/__opfs__/<dbName>` and route VirtualFS-visible
   *      paths through {@link prefix}/{@link unprefix} just like the
   *      memory backend does.
   *
   * Same-`dbName` instances share the resolved `WebAccessFS` via the
   * {@link opfsBackends} refcount cache (mirrors the memory backend's
   * per-`dbName` semantics); the last `dispose()` umounts the subpath.
   */
  private static async initOpfsBackend(
    vfs: VirtualFS,
    providedHandle: FileSystemDirectoryHandle | undefined,
    wipe: boolean
  ): Promise<void> {
    const handle = providedHandle ?? (await VirtualFS.acquireOpfsHandle(vfs.dbName, wipe));
    // ZenFS' `WebAccessFS._loadMetadata` reads `/.metadata.json` eagerly when
    // a `metadata` path is configured and throws ENOENT on first boot of a
    // fresh OPFS subdir. Seed an empty-but-valid sidecar before
    // `resolveMountConfig()` so the file exists. The shape mirrors
    // `Index.toJSON()` in `@zenfs/core/internal/file_index.js`
    // (`{ version, maxSize, entries }`) so ZenFS can overwrite it
    // byte-compatibly. Only seed when absent — an existing sidecar (the
    // reload case) is left untouched so persisted metadata survives.
    await VirtualFS.seedOpfsMetadataSidecarIfMissing(handle);
    const [zenfs, { WebAccess }] = await Promise.all([import('@zenfs/core'), import('@zenfs/dom')]);
    await VirtualFS.ensureRootMount(zenfs);
    const mountPoint = `/__opfs__/${vfs.dbName}`;
    let entry = VirtualFS.opfsBackends.get(vfs.dbName);
    if (entry && wipe) {
      try {
        zenfs.umount(mountPoint);
      } catch {
        /* not mounted yet */
      }
      VirtualFS.opfsBackends.delete(vfs.dbName);
      entry = undefined;
    }
    if (!entry) {
      const backendFs = (await (
        zenfs as unknown as {
          resolveMountConfig: (opts: unknown) => Promise<unknown>;
        }
      ).resolveMountConfig({
        backend: WebAccess,
        handle,
        metadata: '/.metadata.json',
      })) as { index?: { toJSON: () => unknown } };
      try {
        (zenfs.mount as unknown as (p: string, fs: unknown) => void)(mountPoint, backendFs);
      } catch {
        /* already mounted with this backend — safe to ignore */
      }
      entry = { backendFs, refs: 0 };
      VirtualFS.opfsBackends.set(vfs.dbName, entry);
    }
    entry.refs += 1;
    vfs.opfsBackendFs = entry.backendFs.index
      ? (entry.backendFs as { index: { toJSON: () => unknown } })
      : null;
    vfs.opfsHandle = handle;
    vfs.mountRoot = mountPoint;
    vfs.rawLfs = zenfs.promises as unknown as FsPromisesLike;
    vfs.rawLfsSync = zenfs as unknown as FsSyncLike;
  }

  /**
   * Configure `@zenfs/core` with an `InMemory` backend mounted at a
   * per-instance subpath (`/__zenfs__/<dbName>`). Used in Node/Vitest
   * environments (and any browser context where OPFS is unavailable).
   *
   * Why a sub-mount instead of `configureSingle('/')`: `configureSingle`
   * replaces the root mount globally, so two VirtualFS instances with
   * different `dbName`s would clobber each other (LightningFS, the
   * pre-F2 backend, isolated by IDB name so multi-instance was free).
   * Mounting each instance at `/__zenfs__/<dbName>` lets multiple
   * memory VFS instances coexist; the {@link prefix} / {@link unprefix}
   * helpers translate VFS-visible paths to/from the underlying ZenFS
   * paths.
   *
   * Same-dbName VFS instances share state via the {@link
   * memoryBackends} cache (mirrors LFS' per-IDB-name semantics).
   * `wipe: true` clears the cached store before re-mounting.
   */
  private static async initMemoryBackend(
    vfs: VirtualFS,
    dbName: string,
    wipe: boolean
  ): Promise<void> {
    const zenfs = await import('@zenfs/core');
    await VirtualFS.ensureRootMount(zenfs);
    const mountPoint = `/__zenfs__/${dbName}`;
    let entry = VirtualFS.memoryBackends.get(dbName);
    if (entry && wipe) {
      try {
        zenfs.umount(mountPoint);
      } catch {
        /* not mounted yet */
      }
      VirtualFS.memoryBackends.delete(dbName);
      entry = undefined;
    }
    if (!entry) {
      entry = { store: zenfs.InMemory.create({ label: dbName }), refs: 0 };
      VirtualFS.memoryBackends.set(dbName, entry);
    }
    entry.refs += 1;
    try {
      // ZenFS `mount` expects a `FileSystem`; `InMemory.create` returns
      // a `StoreFS<InMemoryStore>` which structurally satisfies it.
      // Cast through `unknown` so we don't have to import the internal
      // `FileSystem` type just for this argument.
      (zenfs.mount as unknown as (p: string, fs: unknown) => void)(mountPoint, entry.store);
    } catch {
      /* already mounted with this store — safe to ignore */
    }
    vfs.mountRoot = mountPoint;
    vfs.rawLfs = zenfs.promises as unknown as FsPromisesLike;
    vfs.rawLfsSync = zenfs as unknown as FsSyncLike;
    vfs.opfsBackendFs = null;
    vfs.opfsHandle = null;
  }

  /**
   * Bootstrap the global ZenFS root once per process so per-instance
   * `mount('/__zenfs__/<dbName>', …)` / `mount('/__opfs__/<dbName>', …)`
   * calls have a root to attach to. Idempotent — subsequent inits
   * short-circuit after the first `configureSingle` resolves. The root
   * is `InMemory`; per-`dbName` sub-mounts (memory or OPFS) are
   * installed on top via `mount()`, so this never replaces the
   * existing mount registry. Called from both
   * {@link initMemoryBackend} and {@link initOpfsBackend} so OPFS
   * instances no longer remount the global `/`.
   */
  private static rootMountReady: Promise<void> | null = null;
  /**
   * Per-`dbName` cache of `InMemory` stores so multiple alive VirtualFS
   * instances with the same `dbName` share state (mirrors the legacy
   * LightningFS-per-IDB-name semantics). Reference-counted so a
   * `dispose()` on the last live holder drops the store and the next
   * `create()` for that name starts fresh — without the count, a
   * sequential test pattern (`create → write → dispose → create`)
   * would inherit the previous test's residual data.
   */
  private static memoryBackends: Map<string, { store: unknown; refs: number }> = new Map();
  /**
   * Per-`dbName` cache of resolved `WebAccessFS` backends so multiple
   * alive OPFS-backed VirtualFS instances with the same `dbName` share
   * one mount + one in-memory index. Refcounted with the same
   * semantics as {@link memoryBackends}: the last `dispose()` for a
   * name umounts `/__opfs__/<dbName>` and drops the entry so a fresh
   * `create()` re-resolves the backend.
   */
  private static opfsBackends: Map<
    string,
    { backendFs: { index?: { toJSON: () => unknown } }; refs: number }
  > = new Map();
  private static async ensureRootMount(zenfs: typeof import('@zenfs/core')): Promise<void> {
    if (VirtualFS.rootMountReady) return VirtualFS.rootMountReady;
    VirtualFS.rootMountReady = (async () => {
      await zenfs.configureSingle({ backend: zenfs.InMemory, label: '__vfs_root__' });
    })();
    return VirtualFS.rootMountReady;
  }

  /** Translate a VFS-visible path to the underlying ZenFS path (memory backend only). */
  private prefix(p: string): string {
    if (!this.mountRoot) return p;
    return p === '/' ? this.mountRoot : this.mountRoot + p;
  }

  /** Strip the mount-root prefix from a ZenFS path (memory backend only). */
  private unprefix(p: string): string {
    if (!this.mountRoot || !p.startsWith(this.mountRoot)) return p;
    const tail = p.slice(this.mountRoot.length);
    return tail || '/';
  }

  /**
   * Build the deferred+prefixing `fs.promises` proxy stored in
   * {@link lfs}. Each method awaits {@link _ready} (so
   * pre-init callers don't crash) then forwards to {@link rawLfs} with
   * paths translated through {@link prefix}/{@link unprefix}.
   *
   * `rawLfs` is looked up at call time, so this proxy survives any
   * subsequent reassignment by `init*Backend`.
   */
  private makeDeferredLfs(): FsPromisesLike {
    const pf = (p: string) => this.prefix(p);
    const upf = (p: string) => this.unprefix(p);
    const raw = (): FsPromisesLike => {
      if (!this.rawLfs) throw new Error('VirtualFS used before init resolved');
      return this.rawLfs;
    };
    // Awaiting an already-resolved promise still costs a microtask
    // per call; the `_readyResolved` short-circuit cuts that overhead
    // out of the hot path (skill discovery scans ~10k mkdirs in tests).
    return {
      readFile: (p, opts) =>
        this._readyResolved
          ? raw().readFile(pf(p), opts)
          : this._ready.then(() => raw().readFile(pf(p), opts)),
      writeFile: (p, data, opts) =>
        this._readyResolved
          ? raw().writeFile(pf(p), data, opts)
          : this._ready.then(() => raw().writeFile(pf(p), data, opts)),
      readdir: (p) =>
        this._readyResolved ? raw().readdir(pf(p)) : this._ready.then(() => raw().readdir(pf(p))),
      mkdir: (p, opts) =>
        this._readyResolved
          ? raw().mkdir(pf(p), opts)
          : this._ready.then(() => raw().mkdir(pf(p), opts)),
      rmdir: (p) =>
        this._readyResolved ? raw().rmdir(pf(p)) : this._ready.then(() => raw().rmdir(pf(p))),
      unlink: (p) =>
        this._readyResolved ? raw().unlink(pf(p)) : this._ready.then(() => raw().unlink(pf(p))),
      rename: (a, b) =>
        this._readyResolved
          ? raw().rename(pf(a), pf(b))
          : this._ready.then(() => raw().rename(pf(a), pf(b))),
      stat: (p) =>
        this._readyResolved ? raw().stat(pf(p)) : this._ready.then(() => raw().stat(pf(p))),
      lstat: (p) =>
        this._readyResolved ? raw().lstat(pf(p)) : this._ready.then(() => raw().lstat(pf(p))),
      symlink: (target, p) => {
        const t = target.startsWith('/') ? pf(target) : target;
        return this._readyResolved
          ? raw().symlink(t, pf(p))
          : this._ready.then(() => raw().symlink(t, pf(p)));
      },
      readlink: async (p) => {
        if (!this._readyResolved) await this._ready;
        return upf(await raw().readlink(pf(p)));
      },
      realpath: async (p) => {
        if (!this._readyResolved) await this._ready;
        const r = raw();
        if (typeof r.realpath !== 'function') return pf(p);
        return upf(await r.realpath(pf(p)));
      },
    };
  }

  /**
   * Sync counterpart to {@link makeDeferredLfs}. Cannot await
   * `_ready`; if a caller invokes these before init resolves they
   * receive `undefined` for the missing methods and the public
   * `statSync` / `lstatSync` / `readDirSync` fall through to null.
   */
  private makeDeferredLfsSync(): FsSyncLike {
    const pf = (p: string) => this.prefix(p);
    const upf = (p: string) => this.unprefix(p);
    return {
      readdirSync: (p: string): string[] | undefined => {
        const r = this.rawLfsSync;
        return r?.readdirSync ? r.readdirSync(pf(p)) : undefined;
      },
      statSync: (p: string): FsStatsLike | undefined => {
        const r = this.rawLfsSync;
        return r?.statSync ? r.statSync(pf(p)) : undefined;
      },
      lstatSync: (p: string): FsStatsLike | undefined => {
        const r = this.rawLfsSync;
        return r?.lstatSync ? r.lstatSync(pf(p)) : undefined;
      },
      readlinkSync: (p: string): string | undefined => {
        const r = this.rawLfsSync;
        return r?.readlinkSync ? upf(r.readlinkSync(pf(p))) : undefined;
      },
    } as unknown as FsSyncLike;
  }

  /**
   * Seed `/.metadata.json` in the OPFS subdir handle with an empty-but-valid
   * ZenFS `Index.toJSON()` payload if the file is missing. No-op when the
   * sidecar already exists (reload case — persisted metadata must survive).
   *
   * The shape `{ version: 1, maxSize: 0xffffffff, entries: {} }` matches
   * `Index.toJSON()` in `@zenfs/core/internal/file_index.js`; `maxSize`
   * comes from `size_max = 0xffffffff` in `@zenfs/core/constants.js`.
   * `WebAccessFS._loadMetadata` reads this with `JSON.parse` +
   * `index.fromJSON(...)`. Empty entries means the root `/` inode is
   * created on-demand by `WebAccessFS.stat`'s ENOENT recovery path
   * (lines ~84-110 of `@zenfs/dom/access.js`), same as the no-metadata
   * boot path.
   */
  private static async seedOpfsMetadataSidecarIfMissing(
    handle: FileSystemDirectoryHandle
  ): Promise<void> {
    const SIDECAR_NAME = '.metadata.json';
    try {
      await handle.getFileHandle(SIDECAR_NAME);
      return;
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      if (name !== 'NotFoundError') throw err;
    }
    const fileHandle = await handle.getFileHandle(SIDECAR_NAME, { create: true });
    const writable = await fileHandle.createWritable();
    const initial = JSON.stringify({
      version: 1,
      maxSize: 0xffffffff,
      entries: {},
    });
    await writable.write(initial);
    await writable.close();
  }

  /**
   * Resolve an OPFS subdirectory handle for the given `dbName`. If
   * `wipe` is true, removes the subdirectory first (best-effort) before
   * re-creating it.
   */
  private static async acquireOpfsHandle(
    dbName: string,
    wipe: boolean
  ): Promise<FileSystemDirectoryHandle> {
    const storage = (navigator as unknown as { storage?: StorageManager }).storage;
    if (!storage?.getDirectory) {
      throw new FsError('EINVAL', 'OPFS is not available in this environment');
    }
    const root = await storage.getDirectory();
    if (wipe) {
      try {
        await (
          root as unknown as {
            removeEntry: (n: string, o?: { recursive: boolean }) => Promise<void>;
          }
        ).removeEntry(dbName, { recursive: true });
      } catch {
        /* missing entry is fine */
      }
    }
    return root.getDirectoryHandle(dbName, { create: true });
  }

  /** Create a VirtualFS instance. */
  static async create(options?: VirtualFsOptions): Promise<VirtualFS> {
    const dbName = options?.dbName ?? 'browser-fs';
    const wipe = options?.wipe === true;
    const backend: VfsBackend = options?.backend ?? resolveVfsBackendFromEnv();
    const vfs = new VirtualFS(dbName, wipe, backend);
    await vfs._ready;
    if (wipe) {
      await clearMountEntries().catch(() => {});
    }
    return vfs;
  }

  /**
   * Force any backend-owned metadata to durable storage immediately.
   * On the OPFS backend this serializes the in-memory `WebAccessFS`
   * index to the `/.metadata.json` sidecar so filemode bits and
   * symlinks survive a page reload. On the InMemory backend this is a
   * no-op (the store is process-local and not persisted).
   *
   * Call this before any operation that may kill the page
   * (`location.reload`, navigation away, tab close) when newly-created
   * paths must survive.
   */
  async flush(): Promise<void> {
    await this.writeOpfsMetadataSidecar();
  }

  /**
   * Serialize the live OPFS WebAccessFS index back to `/.metadata.json`
   * in the OPFS subdir so filemode bits and symlinks survive a reload.
   * No-op on the InMemory backend, on backends without a captured index
   * reference (defensive — should not happen after a successful
   * `initOpfsBackend`), or if the OPFS handle was never captured. See
   * {@link opfsBackendFs}.
   */
  private async writeOpfsMetadataSidecar(): Promise<void> {
    if (this.backend !== 'opfs') return;
    const backendFs = this.opfsBackendFs;
    const handle = this.opfsHandle;
    if (!backendFs || !handle) return;
    const json = JSON.stringify(backendFs.index.toJSON());
    const fileHandle = await handle.getFileHandle('.metadata.json', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(json);
    await writable.close();
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
   * Close watchers/channels and persist any pending OPFS metadata.
   * On the memory backend, decrement the per-`dbName` refcount and
   * drop the cached store when the last live holder disposes — keeps
   * concurrent same-name instances sharing state while preventing
   * stale data from leaking into the next create-after-dispose
   * sequence.
   */
  async dispose(): Promise<void> {
    this.mountSyncChannel?.close();
    this.mountSyncChannel = null;
    this.watcher?.dispose();
    this.watcher = null;
    this.mountIndex.dispose();
    // Persist the metadata sidecar so filemode/symlink state survives
    // the dispose (same mechanism as `flush()` on the OPFS path; no-op
    // on InMemory).
    await this.writeOpfsMetadataSidecar();
    if (this.mountRoot) {
      // OPFS and memory share the same refcount-then-umount lifecycle;
      // pick the right backend cache and apply it.
      const cache: Map<string, { refs: number }> =
        this.backend === 'opfs' ? VirtualFS.opfsBackends : VirtualFS.memoryBackends;
      const entry = cache.get(this.dbName);
      if (entry) {
        entry.refs -= 1;
        if (entry.refs <= 0) {
          cache.delete(this.dbName);
          try {
            const zenfs = await import('@zenfs/core');
            zenfs.umount(this.mountRoot);
          } catch {
            /* best-effort — module may already be GCed in tests */
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Synchronous fast-path (VfsAdapter / RestrictedFS contract)
  // ---------------------------------------------------------------------------
  //
  // These methods historically reached into LightningFS' in-memory
  // CacheFS tree. They now route through ZenFS' Node-compatible
  // sync API (`fs.statSync` / `fs.lstatSync` / `fs.readdirSync`).
  // Behavior:
  //   * On the `'memory'` backend (InMemory) sync ops succeed — tests
  //     keep getting non-null Stats for valid paths.
  //   * On the `'opfs'` backend (WebAccessFS) sync ops are not
  //     available outside a SharedWorker context and throw at call
  //     time; we catch and return null so callers fall back to async.
  // Mount paths always return null (mounts are async-only).

  readDirSync(path: string): DirEntry[] | null {
    const normalized = normalizePath(path);
    if (this.findMount(normalized)) return null;
    const sync = this.lfsSync;
    if (typeof sync.readdirSync !== 'function' || typeof sync.lstatSync !== 'function') return null;
    try {
      const names = sync.readdirSync(normalized);
      const entries: DirEntry[] = [];
      for (const name of names) {
        const childPath = normalized === '/' ? `/${name}` : `${normalized}/${name}`;
        try {
          const s = sync.lstatSync(childPath);
          const type: EntryType = s.isSymbolicLink()
            ? 'symlink'
            : s.isDirectory()
              ? 'directory'
              : 'file';
          entries.push({ name, type });
        } catch {
          /* skip entries we can't stat */
        }
      }
      return entries;
    } catch {
      return null;
    }
  }

  statSync(path: string): Stats | null {
    const normalized = normalizePath(path);
    if (this.findMount(normalized)) return null;
    const sync = this.lfsSync;
    if (
      typeof sync.statSync !== 'function' ||
      typeof sync.lstatSync !== 'function' ||
      typeof sync.readlinkSync !== 'function'
    ) {
      return null;
    }
    // Resolve symlinks with a bounded hop counter — ZenFS' native
    // `statSync` follows symlinks via unbounded recursion and a `/a → /b
    // → /a` cycle blows the stack. Mirrors {@link realpath}'s bounded
    // walk on the sync surface; returns null on ELOOP so callers can
    // fall back to async (which throws the explicit ELOOP).
    let current = normalized;
    for (let hops = 0; hops <= MAX_SYMLINK_DEPTH; hops++) {
      let s: FsStatsLike;
      try {
        s = sync.lstatSync(current);
      } catch {
        return null;
      }
      if (!s.isSymbolicLink()) {
        return {
          type: s.isDirectory() ? 'directory' : 'file',
          size: s.size,
          mtime: s.mtimeMs,
          ctime: s.ctimeMs,
        };
      }
      let target: string;
      try {
        target = sync.readlinkSync(current);
      } catch {
        return null;
      }
      current = target.startsWith('/')
        ? normalizePath(target)
        : normalizePath(joinPath(splitPath(current).dir, target));
    }
    return null;
  }

  lstatSync(path: string): Stats | null {
    const normalized = normalizePath(path);
    if (this.findMount(normalized)) return null;
    const sync = this.lfsSync;
    if (typeof sync.lstatSync !== 'function') return null;
    try {
      const s = sync.lstatSync(normalized);
      if (s.isSymbolicLink()) {
        const target = sync.readlinkSync ? sync.readlinkSync(normalized) : '';
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
        const { S3MountBackend, RemoteMountCache, makeSignedFetchS3 } = await import(
          './mount/index.js'
        );
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
        const { DaMountBackend, RemoteMountCache, makeSignedFetchDa } = await import(
          './mount/index.js'
        );
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
   * Like {@link listMounts}, but also returns each mount's backend
   * `kind` ('local' | 's3' | 'da' | 'proc'). Used by the `python`
   * command to compute the overlap of user mounts with the realm sync
   * dirs and tag remote ones for the remote-mount size cap. Internal
   * mounts are excluded for the same reason `listMounts()` hides them.
   */
  listMountPoints(): { path: string; kind: MountBackend['kind'] }[] {
    const out: { path: string; kind: MountBackend['kind'] }[] = [];
    for (const [path, backend] of this.mountPoints) {
      if (this.internalMounts.has(path)) continue;
      out.push({ path, kind: backend.kind });
    }
    return out;
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
        return (await this.lfs.readFile(resolved, { encoding: 'utf8' })) as string;
      }
      return (await this.lfs.readFile(resolved)) as Uint8Array;
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
   *
   * Walks the path component-by-component (so intermediate directory
   * symlinks like `/alias → /real` are resolved when reading
   * `/alias/file.txt`) and bounds total hops by {@link
   * MAX_SYMLINK_DEPTH}; a circular chain surfaces as `ELOOP`. We can't
   * delegate to ZenFS' native `realpath` because `@zenfs/core`'s
   * `vfs/async.js#resolve` recurses without a hop counter — a `/a →
   * /b → /a` cycle blows the async stack and exhausts the heap before
   * any error is raised. This bounded loop mirrors the POSIX realpath
   * contract and keeps the InMemory test backend (and OPFS in
   * production) from OOM-ing on cycles.
   */
  async realpath(path: string): Promise<string> {
    const normalized = normalizePath(path);
    const mount = this.findMount(normalized);
    if (mount) return normalized; // Mount paths are already real
    let hops = 0;
    // Component-walk: build the resolved path one segment at a time,
    // resolving any symlink encountered against the already-resolved
    // prefix so directory-component symlinks (`/alias/file.txt`) work.
    const parts = normalized.split('/').filter(Boolean);
    let resolved = '/';
    for (let i = 0; i < parts.length; i++) {
      let next = resolved === '/' ? `/${parts[i]}` : `${resolved}/${parts[i]}`;
      // Follow symlinks at this component up to the hop limit.
      while (true) {
        let stats: FsStatsLike;
        try {
          stats = await this.lfs.lstat(next);
        } catch (err) {
          // Non-existent tail component is allowed (realpath of a
          // not-yet-created file still has a canonical form); rethrow
          // for ENOTDIR/EACCES/etc.
          const converted = this.convertError(err, normalized);
          if (converted.code === 'ENOENT' && i === parts.length - 1) {
            resolved = next;
            return resolved;
          }
          throw converted;
        }
        if (!stats.isSymbolicLink()) {
          resolved = next;
          break;
        }
        if (++hops > MAX_SYMLINK_DEPTH) {
          throw new FsError('ELOOP', 'too many symbolic links encountered', normalized);
        }
        let target: string;
        try {
          target = await this.lfs.readlink(next);
        } catch (err) {
          throw this.convertError(err, normalized);
        }
        next = target.startsWith('/')
          ? normalizePath(target)
          : normalizePath(joinPath(splitPath(next).dir, target));
      }
    }
    return resolved;
  }

  /**
   * Internal helper: resolve symlinks in a path before an operation.
   * Used by readFile, writeFile, stat, etc. to follow symlinks transparently.
   * Mount points are returned as-is (mount backends do not support symlinks).
   */
  private async resolveSymlinks(path: string): Promise<string> {
    const mount = this.findMount(path);
    if (mount) return path; // Mount points don't have symlinks
    return this.realpath(path);
  }

  /**
   * Convert LightningFS / ZenFS errors to {@link FsError}.
   *
   * ZenFS throws `ErrnoError` instances with a `.code` POSIX string
   * field (and `.errno: number`); LightningFS embeds the code in the
   * message text. Try the structured `.code` form first so we carry
   * through codes ZenFS reports verbatim, then fall back to
   * substring matching for LightningFS.
   */
  private convertError(err: unknown, path: string): FsError {
    if (err instanceof FsError) return err;
    // ZenFS ErrnoError carries `.code` directly (POSIX string).
    const structured = (err as { code?: unknown })?.code;
    if (typeof structured === 'string') {
      const code = structured as FsErrorCode;
      const known: FsErrorCode[] = [
        'ENOENT',
        'EEXIST',
        'ENOTDIR',
        'EISDIR',
        'ENOTEMPTY',
        'EINVAL',
        'EACCES',
        'ELOOP',
        'EBUSY',
        'EFBIG',
        'EBADF',
        'EIO',
      ];
      if ((known as string[]).includes(code)) {
        const msg = err instanceof Error ? err.message : String(err);
        return new FsError(code, msg || code, path);
      }
    }
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
