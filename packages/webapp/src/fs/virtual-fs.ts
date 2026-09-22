import { convertError, rebrandFsError } from './error-rebrand.js';
import type { FsChangeEvent, FsWatcher } from './fs-watcher.js';
import { findDirtyKindFlips, memoryKindOfMode, shouldReconcileKind } from './kind-reconcile.js';
import type {
  MountBackend,
  MountDirEntry,
  ReadDirOptions,
  RefreshReport,
} from './mount/backend.js';
import type { HostFsMountBackend } from './mount/backend-hostfs.js';
import { LocalMountBackend } from './mount/backend-local.js';
import {
  MountIndex,
  type MountIndexEnv,
  type MountIndexLimits,
  resolveMountIndexLimits,
} from './mount-index.js';
import type { BackendDescriptor, MountTableEntry } from './mount-table-store.js';
import {
  clearMountEntries,
  loadMountHandle,
  removeMountEntry,
  saveMountEntry,
} from './mount-table-store.js';
import { fileFromDirectoryHandle } from './native-file.js';
import { joinPath, normalizePath, splitPath } from './path-utils.js';
import { sameFileIdentity } from './same-file-identity.js';
import {
  mergeSidecarEntries,
  type SidecarDirtyState,
  type SidecarIndexJson,
  stripSidecarSelfEntry,
} from './sidecar-merge.js';
import { invalidateSidecarConsistency } from './sidecar-probe.js';
import { makeOpfsProbe } from './sidecar-repair.js';
import { inodeIdentity } from './stat-identity.js';
import { MAX_SYMLINK_DEPTH, realpath, resolveSymlinks } from './symlink-resolver.js';
import type {
  DirEntry,
  EntryType,
  FileContent,
  FsStatsLike,
  MkdirOptions,
  ReadFileOptions,
  RmOptions,
  Stats,
} from './types.js';
import { FsError } from './types.js';
import { walk } from './walker.js';

interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

export type VfsBackend = 'memory' | 'opfs';

export function resolveVfsBackendFromEnv(): VfsBackend {
  try {
    const storage = (globalThis as { navigator?: { storage?: { getDirectory?: unknown } } })
      .navigator?.storage;
    if (typeof storage?.getDirectory === 'function') return 'opfs';
  } catch {}
  return 'memory';
}

export interface VirtualFsOptions {
  dbName?: string;

  wipe?: boolean;

  backend?: VfsBackend;

  onRepairProgress?: () => void;

  opfsAsyncCache?: boolean;
}

interface FsPromisesLike {
  readFile(path: string, options?: unknown): Promise<unknown>;
  writeFile(path: string, data: unknown, options?: unknown): Promise<void>;
  appendFile(path: string, data: unknown): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  utimes(path: string, atime: Date, mtime: Date): Promise<void>;
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
  truncate?(path: string, len: number): Promise<void>;
}

interface FsSyncLike {
  readdirSync?(path: string): string[];
  statSync?(path: string): FsStatsLike;
  lstatSync?(path: string): FsStatsLike;
  readlinkSync?(path: string): string;
}

function dirEntryFromMount(entry: MountDirEntry, withStats: boolean): DirEntry {
  const type = entry.kind === 'directory' ? 'directory' : 'file';
  if (!withStats) return { name: entry.name, type };
  return {
    name: entry.name,
    type,
    ...(entry.size !== undefined ? { size: entry.size } : {}),
    ...(entry.lastModified !== undefined ? { mtime: entry.lastModified } : {}),
    ...(entry.ctime !== undefined ? { ctime: entry.ctime } : {}),
    ...(entry.ino !== undefined ? { ino: entry.ino } : {}),
    ...(entry.identity !== undefined ? { identity: entry.identity } : {}),
    ...(entry.dev !== undefined ? { dev: entry.dev } : {}),
    ...(entry.uid !== undefined ? { uid: entry.uid } : {}),
    ...(entry.gid !== undefined ? { gid: entry.gid } : {}),
    ...(entry.mode !== undefined ? { mode: entry.mode } : {}),
  };
}

function buildBackendDescriptor(backend: MountBackend, normalizedPath: string): BackendDescriptor {
  switch (backend.kind) {
    case 'local':
    case 'proc':
      return { kind: 'local', mountId: backend.mountId, idbHandleKey: normalizedPath };
    case 'hostfs':
      return {
        kind: 'hostfs',
        mountId: backend.mountId,
        hostPath: (backend as HostFsMountBackend).getHostPath(),
      };
    default:
      return {
        kind: backend.kind === 's3' ? 's3' : backend.kind === 'aem' ? 'aem' : 'da',
        mountId: backend.mountId,
        source: backend.source!,
        profile: backend.profile ?? 'default',
      };
  }
}

export class VirtualFS {
  private lfs: FsPromisesLike;

  private lfsSync: FsSyncLike;

  private rawLfs: FsPromisesLike | null = null;

  private rawLfsSync: FsSyncLike | null = null;
  private _ready: Promise<void>;

  private _readyResolved = false;

  public readonly backend: VfsBackend;

  private mountPoints = new Map<string, MountBackend>();

  private opfsBackendFs: { index: { toJSON: () => unknown } } | null = null;

  private opfsHandle: FileSystemDirectoryHandle | null = null;

  private mountRoot: string = '';

  private internalMounts = new Set<string>();
  private watcher: FsWatcher | null = null;
  private readonly dbName: string;

  private mountSyncChannel: BroadcastChannel | null = null;

  private mountIndex = new MountIndex();

  private static writeChains = new Map<string, Promise<void>>();

  private readonly onRepairProgress: (() => void) | undefined;

  private constructor(
    dbName: string,
    wipe?: boolean,
    backend?: VfsBackend,
    opfsHandle?: FileSystemDirectoryHandle,
    onRepairProgress?: () => void,
    opfsAsyncCache?: boolean
  ) {
    this.dbName = dbName;

    this.onRepairProgress = onRepairProgress;

    this.backend = backend === 'opfs' ? 'opfs' : 'memory';

    this.lfs = this.makeDeferredLfs();
    this.lfsSync = this.makeDeferredLfsSync();
    this._ready =
      this.backend === 'opfs'
        ? VirtualFS.initOpfsBackend(this, opfsHandle, wipe === true, opfsAsyncCache)
        : VirtualFS.initMemoryBackend(this, dbName, wipe === true);
    this._ready.then(
      () => {
        this._readyResolved = true;
      },
      () => {}
    );

    if (typeof BroadcastChannel !== 'undefined') {
      try {
        this.mountSyncChannel = new BroadcastChannel(`vfs-mount-sync:${dbName}`);
        this.mountSyncChannel.onmessage = (event: MessageEvent) => {
          const { type, path, descriptor } = event.data ?? {};
          if (type === 'mount' && typeof path === 'string' && descriptor) {
            void this.reconstructBackendFromDescriptor(descriptor as BackendDescriptor, path)
              .then((backend) => {
                this.mountPoints.set(path, backend);
                if (backend.kind === 'local') {
                  this.mountIndex.registerMount(path, (backend as LocalMountBackend).getHandle());
                }
                this.watcher?.notify([{ type: 'modify', path, entryType: 'directory' }]);
              })
              .catch(() => {});
          } else if (type === 'unmount' && typeof path === 'string') {
            const backend = this.mountPoints.get(path);
            this.mountPoints.delete(path);
            this.mountIndex.unregisterMount(path);
            void backend?.close();
            this.watcher?.notify([{ type: 'modify', path, entryType: 'directory' }]);
          }
        };
      } catch {}
    }
  }

  private static opfsInitChains = new Map<string, Promise<void>>();

  private static async initOpfsBackend(
    vfs: VirtualFS,
    providedHandle: FileSystemDirectoryHandle | undefined,
    wipe: boolean,
    asyncCache?: boolean
  ): Promise<void> {
    const previous = VirtualFS.opfsInitChains.get(vfs.dbName) ?? Promise.resolve();
    const pending = previous
      .catch(() => {})
      .then(() => VirtualFS.resolveOpfsBackend(vfs, providedHandle, wipe, asyncCache));
    VirtualFS.opfsInitChains.set(vfs.dbName, pending);
    try {
      await pending;
    } finally {
      if (VirtualFS.opfsInitChains.get(vfs.dbName) === pending) {
        VirtualFS.opfsInitChains.delete(vfs.dbName);
      }
    }
  }

  private static async resolveOpfsBackend(
    vfs: VirtualFS,
    providedHandle: FileSystemDirectoryHandle | undefined,
    wipe: boolean,
    asyncCache?: boolean
  ): Promise<void> {
    const shared = VirtualFS.opfsBackends.get(vfs.dbName);
    if (shared && wipe) {
      throw new FsError('EBUSY', 'Cannot wipe an OPFS backend with live holders', vfs.dbName);
    }
    if (shared && asyncCache !== undefined && shared.asyncCache !== asyncCache) {
      throw new FsError(
        'EBUSY',
        'OPFS async cache setting conflicts with the live backend',
        vfs.dbName
      );
    }
    const handle = providedHandle ?? (await VirtualFS.acquireOpfsHandle(vfs.dbName, wipe));

    await vfs.withWriteLock(() => VirtualFS.seedOpfsMetadataSidecarIfMissing(handle));
    const zenfs = await import('@zenfs/core');
    await VirtualFS.ensureRootMount(zenfs);
    const mountPoint = `/__opfs__/${vfs.dbName}`;
    let entry = VirtualFS.opfsBackends.get(vfs.dbName);
    if (!entry) {
      const { resolveOpfsMount } = await import('./opfs-mount.js');
      const backendFs = await resolveOpfsMount({
        handle,
        dbName: vfs.dbName,
        asyncCache,
        onRepairProgress: vfs.onRepairProgress,
        withWriteLock: (operation) => vfs.withWriteLock(operation),
      });
      try {
        (zenfs.mount as unknown as (p: string, fs: unknown) => void)(mountPoint, backendFs);
      } catch {}
      entry = {
        backendFs,
        refs: 0,
        asyncCache: asyncCache !== false,
        sidecarDirty: { paths: new Set(), prefixes: new Set() },
      };
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
      } catch {}
      VirtualFS.memoryBackends.delete(dbName);
      entry = undefined;
    }
    if (!entry) {
      entry = { store: zenfs.InMemory.create({ label: dbName }), refs: 0 };
      VirtualFS.memoryBackends.set(dbName, entry);
    }
    entry.refs += 1;
    try {
      (zenfs.mount as unknown as (p: string, fs: unknown) => void)(mountPoint, entry.store);
    } catch {}
    vfs.mountRoot = mountPoint;
    vfs.rawLfs = zenfs.promises as unknown as FsPromisesLike;
    vfs.rawLfsSync = zenfs as unknown as FsSyncLike;
    vfs.opfsBackendFs = null;
    vfs.opfsHandle = null;
  }

  private static rootMountReady: Promise<void> | null = null;

  private static memoryBackends: Map<string, { store: unknown; refs: number }> = new Map();

  private static opfsBackends: Map<
    string,
    {
      backendFs: { index?: { toJSON: () => unknown } };
      refs: number;
      asyncCache: boolean;

      sidecarDirty: SidecarDirtyState;
    }
  > = new Map();
  private static async ensureRootMount(zenfs: typeof import('@zenfs/core')): Promise<void> {
    if (VirtualFS.rootMountReady !== null) return VirtualFS.rootMountReady;
    VirtualFS.rootMountReady = (async () => {
      await zenfs.configureSingle({ backend: zenfs.InMemory, label: '__vfs_root__' });
    })();
    return VirtualFS.rootMountReady;
  }

  private prefix(p: string): string {
    if (!this.mountRoot) return p;
    return p === '/' ? this.mountRoot : this.mountRoot + p;
  }

  private unprefix(p: string): string {
    if (!this.mountRoot || !p.startsWith(this.mountRoot)) return p;
    const tail = p.slice(this.mountRoot.length);
    return tail || '/';
  }

  private makeDeferredLfs(): FsPromisesLike {
    const pf = (p: string) => this.prefix(p);
    const upf = (p: string) => this.unprefix(p);
    const raw = (): FsPromisesLike => {
      if (!this.rawLfs) throw new Error('VirtualFS used before init resolved');
      return this.rawLfs;
    };

    return {
      readFile: (p, opts) =>
        this._readyResolved
          ? raw().readFile(pf(p), opts)
          : this._ready.then(() => raw().readFile(pf(p), opts)),
      writeFile: (p, data, opts) =>
        this._readyResolved
          ? raw().writeFile(pf(p), data, opts)
          : this._ready.then(() => raw().writeFile(pf(p), data, opts)),
      appendFile: async (p, data) => {
        if (!this._readyResolved) await this._ready;
        await raw().appendFile(pf(p), data);
      },
      chmod: async (p, mode) => {
        if (!this._readyResolved) await this._ready;
        await raw().chmod(pf(p), mode);
      },
      utimes: async (p, atime, mtime) => {
        if (!this._readyResolved) await this._ready;
        await raw().utimes(pf(p), atime, mtime);
      },
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
      truncate: async (p, len) => {
        if (!this._readyResolved) await this._ready;
        const r = raw();
        if (typeof r.truncate === 'function') await r.truncate(pf(p), len);
      },
      realpath: async (p) => {
        if (!this._readyResolved) await this._ready;
        const r = raw();
        if (typeof r.realpath !== 'function') return pf(p);
        return upf(await r.realpath(pf(p)));
      },
    };
  }

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

  private static async seedOpfsMetadataSidecarIfMissing(
    handle: FileSystemDirectoryHandle
  ): Promise<void> {
    const SIDECAR_NAME = '.metadata.json';
    try {
      const existing = await handle.getFileHandle(SIDECAR_NAME);

      if (VirtualFS.isUsableMetadataDocument(await VirtualFS.readSidecarText(existing))) return;
      console.warn(
        '[virtual-fs] metadata sidecar is unparseable (torn write?); reseeding an empty index'
      );
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

  private static async readSidecarText(fileHandle: FileSystemFileHandle): Promise<string> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await (await fileHandle.getFile()).text();
      } catch (err) {
        if ((err as { name?: string } | null)?.name !== 'NotReadableError') throw err;
        lastErr = err;
      }
    }
    throw lastErr;
  }

  private static isUsableMetadataDocument(text: string): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return false;
    }
    if (!parsed || typeof parsed !== 'object') return false;
    const entries = (parsed as { entries?: unknown }).entries;
    return !!entries && typeof entries === 'object';
  }

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
      } catch {}
    }
    return root.getDirectoryHandle(dbName, { create: true });
  }

  static _createSyncForTests(dbName: string): VirtualFS {
    return new VirtualFS(dbName);
  }

  static async create(options?: VirtualFsOptions): Promise<VirtualFS> {
    const dbName = options?.dbName ?? 'browser-fs';
    const wipe = options?.wipe === true;
    const backend: VfsBackend = options?.backend ?? resolveVfsBackendFromEnv();
    const vfs = new VirtualFS(
      dbName,
      wipe,
      backend,
      undefined,
      options?.onRepairProgress,
      options?.opfsAsyncCache
    );
    try {
      await vfs._ready;
    } catch (error) {
      vfs.mountSyncChannel?.close();
      throw error;
    }
    if (wipe) {
      await clearMountEntries().catch(() => {});
    }
    return vfs;
  }

  async flush(): Promise<void> {
    await this.writeOpfsMetadataSidecar();
  }

  private async writeOpfsMetadataSidecar(): Promise<void> {
    if (this.backend !== 'opfs') return;
    await this.withWriteLock(() => this.writeOpfsMetadataSidecarUnlocked());
  }

  private async writeOpfsMetadataSidecarUnlocked(): Promise<void> {
    if (this.backend !== 'opfs') return;
    const backendFs = this.opfsBackendFs;
    const handle = this.opfsHandle;
    if (!backendFs || !handle) return;
    const own = backendFs.index.toJSON() as SidecarIndexJson;
    const dirty = VirtualFS.opfsBackends.get(this.dbName)?.sidecarDirty;
    let merged: SidecarIndexJson = own;
    if (dirty) {
      let onDisk: SidecarIndexJson | null = null;
      try {
        const existing = await handle.getFileHandle('.metadata.json');
        const parsed: unknown = JSON.parse(await (await existing.getFile()).text());
        if (parsed && typeof parsed === 'object' && (parsed as SidecarIndexJson).entries) {
          onDisk = parsed as SidecarIndexJson;
        }
      } catch {}
      if (onDisk) {
        await this.auditDirtyKindFlips(own, onDisk, dirty, handle);
        merged = mergeSidecarEntries(onDisk, own, dirty);
      }
    }

    const json = JSON.stringify(stripSidecarSelfEntry(merged));
    const fileHandle = await handle.getFileHandle('.metadata.json', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(json);
    await writable.close();

    if (dirty) {
      dirty.paths.clear();
      dirty.prefixes.clear();
    }
  }

  private async auditDirtyKindFlips(
    own: SidecarIndexJson,
    onDisk: SidecarIndexJson,
    dirty: SidecarDirtyState,
    handle: FileSystemDirectoryHandle
  ): Promise<void> {
    const flips = findDirtyKindFlips(own, onDisk, dirty.paths, dirty.prefixes);
    if (flips.length === 0) return;
    const probe = makeOpfsProbe(handle);
    const backendFs = this.opfsBackendFs as unknown as {
      index?: Map<string, unknown>;
      _handles?: Map<string, unknown>;
    } | null;
    for (const flip of flips) {
      const truth = await probe(flip.path).catch(() => null);
      const verifiedOwnCorrect =
        truth !== null &&
        truth.kind !== 'missing' &&
        (truth.kind === 'directory') === flip.ownIsDirectory;
      if (verifiedOwnCorrect) continue;

      const diskEntry = onDisk.entries?.[flip.path];
      if (own.entries && diskEntry !== undefined) own.entries[flip.path] = diskEntry;
      const contradicted = truth !== null && truth.kind !== 'missing';
      if (contradicted) {
        backendFs?.index?.delete(flip.path);
        backendFs?._handles?.delete(flip.path);
      }
      console.warn(
        '[virtual-fs] refused to flush in-memory kind flip over sidecar record (#2006)',
        { path: flip.path, reality: truth?.kind ?? 'unverifiable', evicted: contradicted }
      );
    }
  }

  private markSidecarDirty(path: string, kind: 'path' | 'prefix' = 'path'): void {
    if (this.backend !== 'opfs') return;
    const dirty = VirtualFS.opfsBackends.get(this.dbName)?.sidecarDirty;
    if (!dirty) return;
    const normalized = normalizePath(path);
    (kind === 'prefix' ? dirty.prefixes : dirty.paths).add(normalized);
    let { dir } = splitPath(normalized);
    while (dir !== '/') {
      dirty.paths.add(dir);
      dir = splitPath(dir).dir;
    }
  }

  async forgetSidecarConsistency(): Promise<void> {
    await this.dropSidecarConsistency();
  }

  private sidecarConsistencyDrop: Promise<void> | null = null;

  private dropSidecarConsistency(): Promise<void> {
    if (this.backend !== 'opfs' || !this.opfsHandle) return Promise.resolve();
    if (!this.sidecarConsistencyDrop) {
      const handle = this.opfsHandle;
      this.sidecarConsistencyDrop = invalidateSidecarConsistency(handle).catch((err: unknown) => {
        this.sidecarConsistencyDrop = null;
        throw err;
      });
    }
    return this.sidecarConsistencyDrop;
  }

  invalidatePaths(paths: string[]): void {
    if (this.backend !== 'opfs' || !this.opfsBackendFs) return;
    if (paths.length > 0) {
      void this.dropSidecarConsistency().catch(() => undefined);
    }
    const fs = this.opfsBackendFs as unknown as {
      index: { delete: (path: string) => boolean };

      _handles?: Map<string, unknown>;
    };
    for (const raw of paths) {
      const path = normalizePath(raw);
      fs.index.delete(path);
      fs._handles?.delete(path);

      this.markSidecarDirty(path);
    }
  }

  private async withKindMismatchRetry<T>(path: string, op: () => Promise<T>): Promise<T> {
    return this.withKindMismatchRetryPaths([path], op);
  }

  private async withKindMismatchRetryPaths<T>(
    paths: readonly string[],
    op: () => Promise<T>
  ): Promise<T> {
    try {
      return await op();
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code !== 'EISDIR' && code !== 'ENOTDIR' && code !== 'EINVAL') throw err;
      for (const path of paths) {
        const healed = await this.reconcileKindMismatch(path).catch(() => false);
        if (healed) return await op();
      }
      throw err;
    }
  }

  private async reconcileKindMismatch(rawPath: string): Promise<boolean> {
    if (this.backend !== 'opfs') return false;
    const backendFs = this.opfsBackendFs as unknown as {
      index?: Map<string, { mode?: number }>;

      _handles?: Map<string, { kind?: string }>;
    } | null;
    const handle = this.opfsHandle;
    if (!backendFs?.index || !handle) return false;
    const normalized = normalizePath(rawPath);

    let target = normalized;
    try {
      target = await this.resolveSymlinks(normalized);
    } catch {}
    const truth = await makeOpfsProbe(handle)(target);
    const indexKind = memoryKindOfMode(backendFs.index.get(target)?.mode);
    const cachedHandle = backendFs._handles?.get(target);
    const cachedKind: ReturnType<typeof memoryKindOfMode> =
      cachedHandle?.kind === 'directory'
        ? 'directory'
        : cachedHandle?.kind === 'file'
          ? 'file'
          : 'absent';
    const indexLies = shouldReconcileKind(truth, indexKind);
    const handleLies = shouldReconcileKind(truth, cachedKind);
    if (!indexLies && !handleLies) return false;

    backendFs.index.delete(target);
    backendFs._handles?.delete(target);

    if (indexKind === 'directory' || cachedKind === 'directory') {
      const prefix = `${target}/`;
      for (const key of [...backendFs.index.keys()]) {
        if (key.startsWith(prefix)) backendFs.index.delete(key);
      }
      if (backendFs._handles) {
        for (const key of [...backendFs._handles.keys()]) {
          if (key.startsWith(prefix)) backendFs._handles.delete(key);
        }
      }
    }

    this.markSidecarDirty(target);
    console.warn('[virtual-fs] reconciled in-memory kind mismatch (#2006)', {
      path: target,
      reality: truth.kind,
      indexHeld: indexKind,
      handleHeld: cachedKind,
    });
    return true;
  }

  private localIdentity(ino?: number): string | undefined {
    return inodeIdentity(`zenfs:${this.backend}:${this.dbName}`, ino);
  }

  canWrite(_path: string): boolean {
    return true;
  }

  setWatcher(watcher: FsWatcher | null): void {
    this.watcher = watcher;
  }

  getWatcher(): FsWatcher | null {
    return this.watcher;
  }

  async watch(
    basePaths: readonly string[],
    callback: (events: FsChangeEvent[]) => void
  ): Promise<() => void> {
    const watcher = this.watcher;
    if (!watcher) throw new FsError('ENOSYS', 'no FsWatcher attached to this VirtualFS');
    const unsubs = basePaths.map((basePath) => watcher.watch(basePath, () => true, callback));
    return () => {
      for (const off of unsubs) off();
    };
  }

  async dispose(): Promise<void> {
    this.mountSyncChannel?.close();
    this.mountSyncChannel = null;
    this.watcher?.dispose();
    this.watcher = null;
    this.mountIndex.dispose();

    await this.writeOpfsMetadataSidecar();
    if (this.mountRoot) {
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
          } catch {}
        }
      }
    }
  }

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

          entries.push(
            type === 'symlink'
              ? { name, type }
              : {
                  name,
                  type,
                  size: s.size,
                  mtime: s.mtimeMs,
                  ctime: s.ctimeMs,
                  ...(s.ino !== undefined
                    ? { ino: s.ino, identity: this.localIdentity(s.ino), dev: s.dev }
                    : {}),
                  ...(s.uid !== undefined ? { uid: s.uid } : {}),
                  ...(s.gid !== undefined ? { gid: s.gid } : {}),
                  mode: s.mode,
                }
          );
        } catch {}
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

    if (normalized === '/') {
      try {
        const s = sync.statSync(normalized);
        return {
          type: s.isDirectory() ? 'directory' : 'file',
          size: s.size,
          mtime: s.mtimeMs,
          ctime: s.ctimeMs,
          ino: s.ino,
          identity: this.localIdentity(s.ino),
          dev: s.dev,
          mode: s.mode,
        };
      } catch {
        return null;
      }
    }

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
          ino: s.ino,
          identity: this.localIdentity(s.ino),
          dev: s.dev,
          mode: s.mode,
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

    if (normalized === '/') return this.statSync(normalized);
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
          ino: s.ino,
          identity: this.localIdentity(s.ino),
          dev: s.dev,
          mode: s.mode,
        };
      }
      return {
        type: s.isDirectory() ? 'directory' : 'file',
        size: s.size,
        mtime: s.mtimeMs,
        ctime: s.ctimeMs,
        ino: s.ino,
        identity: this.localIdentity(s.ino),
        dev: s.dev,
        mode: s.mode,
      };
    } catch {
      return null;
    }
  }

  async mount(
    absolutePath: string,
    backend: MountBackend,
    opts?: { env?: MountIndexEnv; limits?: MountIndexLimits }
  ): Promise<void> {
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

    const { dir } = splitPath(normalized);
    if (dir !== '/') await this.mkdir(dir, { recursive: true });
    await this.dropSidecarConsistency();
    try {
      await this.lfs.mkdir(normalized);
    } catch {}
    this.mountPoints.set(normalized, backend);

    if (backend.kind === 'local') {
      const limits = opts?.limits ?? resolveMountIndexLimits(opts?.env ?? {});
      this.mountIndex.registerMount(normalized, (backend as LocalMountBackend).getHandle(), limits);
    }

    const descriptor = buildBackendDescriptor(backend, normalized);
    try {
      this.mountSyncChannel?.postMessage({ type: 'mount', path: normalized, descriptor });
    } catch {}
    this.watcher?.notify([{ type: 'modify', path: normalized, entryType: 'directory' }]);

    if (backend.kind === 'hostfs') return;
    try {
      const entry: MountTableEntry = {
        targetPath: normalized,
        descriptor,
        createdAt: Date.now(),
      };
      const handle =
        backend.kind === 'local' ? (backend as LocalMountBackend).getHandle() : undefined;
      await saveMountEntry(entry, handle);
    } catch {}
  }

  async unmount(absolutePath: string): Promise<void> {
    const normalized = normalizePath(absolutePath);
    const backend = this.mountPoints.get(normalized);
    this.mountPoints.delete(normalized);
    this.mountIndex.unregisterMount(normalized);

    try {
      this.mountSyncChannel?.postMessage({ type: 'unmount', path: normalized });
    } catch {}
    this.watcher?.notify([{ type: 'modify', path: normalized, entryType: 'directory' }]);

    await backend?.close();

    try {
      await removeMountEntry(normalized);
    } catch {}
  }

  private async reconstructBackendFromDescriptor(
    descriptor: BackendDescriptor,
    path: string
  ): Promise<MountBackend> {
    switch (descriptor.kind) {
      case 'local': {
        const handle = await loadMountHandle(descriptor.idbHandleKey);
        if (!handle) throw new Error(`no handle stored for ${descriptor.idbHandleKey}`);
        return LocalMountBackend.fromHandle(handle, { mountId: descriptor.mountId });
      }
      case 'hostfs': {
        const { HostFsMountBackend } = await import('./mount/backend-hostfs.js');
        return new HostFsMountBackend({
          targetPath: path,
          hostPath: descriptor.hostPath,
          mountId: descriptor.mountId,
        });
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
      case 'aem': {
        const { AemMountBackend, RemoteMountCache, makeSignedFetchDa } = await import(
          './mount/index.js'
        );
        const cache = new RemoteMountCache({ mountId: descriptor.mountId, ttlMs: 30_000 });
        return new AemMountBackend({
          source: descriptor.source,
          profile: descriptor.profile,
          cache,
          mountId: descriptor.mountId,
          signedFetch: makeSignedFetchDa(),
        });
      }
    }
  }

  listMounts(): string[] {
    const out: string[] = [];
    for (const path of this.mountPoints.keys()) {
      if (!this.internalMounts.has(path)) out.push(path);
    }
    return out;
  }

  listInternalMounts(): string[] {
    return [...this.internalMounts];
  }

  listMountPoints(): { path: string; kind: MountBackend['kind'] }[] {
    const out: { path: string; kind: MountBackend['kind'] }[] = [];
    for (const [path, backend] of this.mountPoints) {
      if (this.internalMounts.has(path)) continue;
      out.push({ path, kind: backend.kind });
    }
    return out;
  }

  getMountBackend(absolutePath: string): MountBackend | null {
    const normalized = normalizePath(absolutePath);
    return this.mountPoints.get(normalized) ?? null;
  }

  async mountInternal(absolutePath: string, backend: MountBackend): Promise<void> {
    const normalized = normalizePath(absolutePath);
    if (this.mountPoints.has(normalized)) {
      throw new FsError('EEXIST', 'mount point is already mounted', normalized);
    }

    const { dir } = splitPath(normalized);
    if (dir !== '/') await this.mkdir(dir, { recursive: true });
    await this.dropSidecarConsistency();
    try {
      await this.lfs.mkdir(normalized);
    } catch {}
    this.mountPoints.set(normalized, backend);
    this.internalMounts.add(normalized);
    this.watcher?.notify([{ type: 'modify', path: normalized, entryType: 'directory' }]);
  }

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

  getMountIndex(): MountIndex {
    return this.mountIndex;
  }

  async refreshMount(
    mountPath: string,
    opts?: { bodies?: boolean; env?: MountIndexEnv }
  ): Promise<RefreshReport> {
    const normalized = normalizePath(mountPath);
    const backend = this.mountPoints.get(normalized);
    if (!backend) {
      throw new FsError('ENOENT', 'not a mount point', normalized);
    }
    const report = await backend.refresh(opts);

    if (backend.kind === 'local') {
      await this.mountIndex.refreshMount(normalized, resolveMountIndexLimits(opts?.env ?? {}));
    }

    this.watcher?.notify([{ type: 'modify', path: normalized, entryType: 'directory' }]);
    return report;
  }

  isPathUnderMount(path: string): boolean {
    for (const mountPath of this.mountPoints.keys()) {
      if (path === mountPath || path.startsWith(mountPath + '/')) return true;
    }
    return false;
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

  async readFile(path: string, options?: ReadFileOptions): Promise<FileContent> {
    return this.withKindMismatchRetry(path, () => this.readFileInner(path, options));
  }

  private async readFileInner(path: string, options?: ReadFileOptions): Promise<FileContent> {
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
        rebrandFsError(err, normalized);
      }
    }

    const resolved = await this.resolveSymlinks(normalized);
    try {
      const encoding = options?.encoding ?? 'utf-8';
      if (encoding === 'utf-8') {
        return (await this.lfs.readFile(resolved, { encoding: 'utf8' })) as string;
      }
      return (await this.lfs.readFile(resolved)) as Uint8Array;
    } catch (err) {
      throw convertError(err, normalized);
    }
  }

  async readFileRange(path: string, start: number, end: number): Promise<Uint8Array> {
    const normalized = normalizePath(path);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
      throw new FsError('EINVAL', `invalid byte range ${start}-${end}`, normalized);
    }
    if (start === end) return new Uint8Array(0);
    const mount = this.findMount(normalized);
    const ranged = mount?.backend.readFileRange;
    if (mount && ranged) {
      if (mount.relParts.length === 0) throw new FsError('EISDIR', 'is a directory', normalized);
      try {
        return await ranged.call(mount.backend, mount.relParts.join('/'), start, end);
      } catch (err) {
        rebrandFsError(err, normalized);
      }
    }
    const sliced = await this.sliceNativeFile(normalized, start, end);
    if (sliced) return sliced;
    const whole = (await this.readFile(normalized, { encoding: 'binary' })) as Uint8Array;

    return new Uint8Array(whole.subarray(start, Math.min(end, whole.byteLength)));
  }

  private async sliceNativeFile(
    normalized: string,
    start: number,
    end: number
  ): Promise<Uint8Array | null> {
    try {
      const native = await this.getNativeFile(normalized);
      if (!native) return null;
      const blob = native.slice(start, Math.min(end, native.size));
      return new Uint8Array(await blob.arrayBuffer());
    } catch {
      return null;
    }
  }

  async getNativeFile(path: string): Promise<File | null> {
    const normalized = normalizePath(path);
    const mount = this.findMount(normalized);
    if (mount) {
      const native = mount.backend.getNativeFile;
      if (!native || mount.relParts.length === 0) return null;
      try {
        return await native.call(mount.backend, mount.relParts.join('/'));
      } catch {
        return null;
      }
    }
    const root = this.opfsHandle;
    if (!root) return null;
    try {
      return await fileFromDirectoryHandle(root, await this.resolveSymlinks(normalized));
    } catch {
      return null;
    }
  }

  async writeFile(
    path: string,
    content: FileContent,
    _options?: { recursive?: boolean }
  ): Promise<void> {
    return this.withKindMismatchRetry(path, () => this.writeFileInner(path, content, _options));
  }

  private async writeFileInner(
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
      } catch {}

      const data =
        typeof content === 'string'
          ? new TextEncoder().encode(content)
          : content instanceof Uint8Array
            ? new Uint8Array(content.buffer, content.byteOffset, content.byteLength)
            : new Uint8Array(content as ArrayBuffer);
      try {
        await mount.backend.writeFile(relPath, data);
      } catch (err) {
        rebrandFsError(err, normalized);
      }
      this.watcher?.notify([
        {
          type: wasExisting ? 'modify' : 'create',
          path: normalized,
          entryType: 'file',
        },
      ]);

      this.mountIndex.notifyWrite(normalized);
      return;
    }

    let resolved: string;
    try {
      resolved = await this.resolveSymlinks(normalized);
    } catch {
      resolved = normalized;
    }

    let wasExisting = false;
    try {
      await this.lfs.stat(resolved);
      wasExisting = true;
    } catch {}

    const { dir } = splitPath(resolved);
    await this.withWriteLock(async () => {
      await this.dropSidecarConsistency();
      this.markSidecarDirty(resolved);
      if (dir !== '/') {
        await this.mkdirRecursiveUnlocked(dir);
      }

      const byteLength =
        typeof content === 'string'
          ? new TextEncoder().encode(content).byteLength
          : content instanceof Uint8Array
            ? content.byteLength
            : (content as ArrayBuffer).byteLength;
      try {
        await this.lfs.writeFile(resolved, content);
      } catch (err) {
        if (dir !== '/' && err instanceof Error && err.message.includes('ENOENT')) {
          await this.mkdirRecursiveUnlocked(dir);
          try {
            await this.lfs.writeFile(resolved, content);
          } catch (retryErr) {
            throw convertError(retryErr, normalized);
          }
        } else {
          throw convertError(err, normalized);
        }
      }
      try {
        await this.lfs.truncate?.(resolved, byteLength);
      } catch (err) {
        throw convertError(err, normalized);
      }
    });
    this.watcher?.notify([
      {
        type: wasExisting ? 'modify' : 'create',
        path: resolved,
        entryType: 'file',
      },
    ]);
  }

  async appendFile(path: string, content: FileContent): Promise<void> {
    const normalized = normalizePath(path);
    await this.withKindMismatchRetry(normalized, () =>
      this.withWriteLock(async () => {
        const mount = this.findMount(normalized);
        if (mount) {
          await this.appendMounted(normalized, content);
          return;
        }
        await this.dropSidecarConsistency();
        let resolved = normalized;
        let wasExisting = false;
        try {
          resolved = await this.resolveSymlinks(normalized);
          const stat = await this.lfs.stat(resolved);
          if (stat.isDirectory()) throw new FsError('EISDIR', 'is a directory', normalized);
          wasExisting = true;
        } catch (err) {
          const error = convertError(err, normalized);
          if (error.code !== 'ENOENT') throw error;
        }
        this.markSidecarDirty(resolved);
        const { dir } = splitPath(resolved);
        await this.mkdirRecursiveUnlocked(dir);
        try {
          await this.lfs.appendFile(resolved, content);
        } catch (err) {
          throw convertError(err, normalized);
        }
        this.watcher?.notify([
          {
            type: wasExisting ? 'modify' : 'create',
            path: resolved,
            entryType: 'file',
          },
        ]);
      })
    );
  }

  private async appendMounted(path: string, content: FileContent): Promise<void> {
    let existing = new Uint8Array(0);
    try {
      const read = await this.readFileInner(path, { encoding: 'binary' });
      existing = typeof read === 'string' ? new TextEncoder().encode(read) : new Uint8Array(read);
    } catch (err) {
      const error = convertError(err, path);
      if (error.code !== 'ENOENT') throw error;
    }
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    const combined = new Uint8Array(existing.length + bytes.length);
    combined.set(existing);
    combined.set(bytes, existing.length);
    await this.writeFileInner(path, combined);
  }

  async chmod(path: string, mode: number): Promise<void> {
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) {
      throw new FsError('EINVAL', 'invalid file mode', normalizePath(path));
    }
    await this.changeMetadata(path, (resolved) => this.lfs.chmod(resolved, mode));
  }

  async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    if (!Number.isFinite(atime.getTime()) || !Number.isFinite(mtime.getTime())) {
      throw new FsError('EINVAL', 'invalid file time', normalizePath(path));
    }
    await this.changeMetadata(path, (resolved) => this.lfs.utimes(resolved, atime, mtime));
  }

  private async changeMetadata(
    path: string,
    update: (resolved: string) => Promise<void>
  ): Promise<void> {
    const normalized = normalizePath(path);
    if (this.findMount(normalized)) {
      await this.stat(normalized);
      throw new FsError('ENOSYS', 'metadata changes are not supported by this mount', normalized);
    }
    await this.withKindMismatchRetry(normalized, () =>
      this.withWriteLock(async () => {
        await this.dropSidecarConsistency();
        const resolved = await this.resolveSymlinks(normalized);
        try {
          const stat = await this.lfs.stat(resolved);
          this.markSidecarDirty(resolved);
          await update(resolved);
          await this.writeOpfsMetadataSidecarUnlocked();
          this.watcher?.notify([
            {
              type: 'modify',
              path: resolved,
              entryType: stat.isDirectory() ? 'directory' : 'file',
            },
          ]);
        } catch (err) {
          throw convertError(err, normalized);
        }
      })
    );
  }

  async readDir(path: string, opts?: ReadDirOptions): Promise<DirEntry[]> {
    const normalized = normalizePath(path);
    const mount = this.findMount(normalized);
    if (mount) {
      return this.readDirMounted(normalized, mount, opts);
    }
    return this.readDirLocal(normalized);
  }

  private async readDirMounted(
    normalized: string,
    mount: { path: string; backend: MountBackend; relParts: string[] },
    opts?: ReadDirOptions
  ): Promise<DirEntry[]> {
    const indexedEntries =
      opts?.includeStats === true
        ? undefined
        : this.mountIndex.getDirectoryEntries(mount.path, normalized);
    if (indexedEntries !== undefined) {
      const entries = new Map<string, DirEntry>();
      for (const entry of indexedEntries) {
        entries.set(entry.name, { name: entry.name, type: entry.type });
      }
      this.addNestedMountEntries(entries, normalized);
      return [...entries.values()];
    }

    const relPath = mount.relParts.join('/') || '/';
    let dirEntries;
    try {
      dirEntries = await mount.backend.readDir(relPath, opts);
    } catch (err) {
      rebrandFsError(err, normalized);
    }
    const entries = new Map<string, DirEntry>();
    const withStats = mount.backend.listingStatsMatchStat === true;
    for (const entry of dirEntries) {
      entries.set(entry.name, dirEntryFromMount(entry, withStats));
    }
    this.addNestedMountEntries(entries, normalized);
    return [...entries.values()];
  }

  private async readDirLocal(normalized: string): Promise<DirEntry[]> {
    return this.withKindMismatchRetry(normalized, () => this.readDirLocalInner(normalized));
  }

  private async readDirLocalInner(normalized: string): Promise<DirEntry[]> {
    const resolved = await this.resolveSymlinks(normalized);
    try {
      const names = await this.lfs.readdir(resolved);
      const entries: DirEntry[] = [];
      for (const name of names) {
        const entry = await this.statDirEntry(resolved, name);
        if (entry) entries.push(entry);
      }
      return entries;
    } catch (err) {
      throw convertError(err, normalized);
    }
  }

  private async statDirEntry(parentResolved: string, name: string): Promise<DirEntry | null> {
    const childPath = parentResolved === '/' ? `/${name}` : `${parentResolved}/${name}`;
    try {
      const s = await this.lfs.lstat(childPath);
      if (s.isSymbolicLink()) return { name, type: 'symlink' };
      return {
        name,
        type: s.isDirectory() ? 'directory' : 'file',
        size: s.size,
        mtime: s.mtimeMs,
        ctime: s.ctimeMs,
        ...(s.ino !== undefined
          ? { ino: s.ino, identity: this.localIdentity(s.ino), dev: s.dev }
          : {}),
        ...(s.uid !== undefined ? { uid: s.uid } : {}),
        ...(s.gid !== undefined ? { gid: s.gid } : {}),
        mode: s.mode,
      };
    } catch {
      return null;
    }
  }

  private addNestedMountEntries(entries: Map<string, DirEntry>, normalized: string): void {
    const childPrefix = normalized === '/' ? '/' : `${normalized}/`;
    for (const mountPath of this.mountPoints.keys()) {
      if (mountPath === normalized || !mountPath.startsWith(childPrefix)) continue;
      const rel = mountPath.slice(childPrefix.length);
      if (!rel || rel.includes('/')) continue;
      if (!entries.has(rel)) {
        entries.set(rel, { name: rel, type: 'directory' });
      }
    }
  }

  private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const key = this.dbName;
    let release!: () => void;
    const next = new Promise<void>((r) => {
      release = r;
    });
    const prev = VirtualFS.writeChains.get(key) ?? Promise.resolve();
    VirtualFS.writeChains.set(key, next);
    await prev;
    try {
      const locks = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;
      if (this.backend !== 'opfs' || typeof locks?.request !== 'function') return await fn();
      return await locks.request(`slicc-vfs:${key}`, () => fn());
    } finally {
      release();

      if (VirtualFS.writeChains.get(key) === next) VirtualFS.writeChains.delete(key);
    }
  }

  private async mkdirRecursiveUnlocked(normalized: string): Promise<string[]> {
    const parts = normalized.split('/').filter(Boolean);
    const created: string[] = [];
    let current = '';
    for (const part of parts) {
      current += '/' + part;
      try {
        await this.lfs.mkdir(current);
        created.push(current);
      } catch (err: unknown) {
        if (err instanceof Error && !err.message.includes('EEXIST')) {
          throw convertError(err, current);
        }

        try {
          const existing = await this.lfs.lstat(current);
          if (!existing.isDirectory() && !existing.isSymbolicLink()) {
            throw new FsError('ENOTDIR', 'not a directory', current);
          }
        } catch (checkErr) {
          if (checkErr instanceof FsError && checkErr.code === 'ENOTDIR') throw checkErr;
        }
      }
    }
    return created;
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const normalized = normalizePath(path);
    if (normalized === '/') return;

    const mount = this.findMount(normalized);
    if (mount) {
      if (mount.relParts.length === 0) return;
      const relPath = mount.relParts.join('/');
      const existed = await this.exists(normalized);
      try {
        await mount.backend.mkdir(relPath);
      } catch (err) {
        rebrandFsError(err, normalized);
      }
      if (!existed) {
        this.watcher?.notify([{ type: 'create', path: normalized, entryType: 'directory' }]);
      }
      return;
    }

    if (options?.recursive) {
      const created = await this.withWriteLock(async () => {
        await this.dropSidecarConsistency();
        this.markSidecarDirty(normalized);
        return this.mkdirRecursiveUnlocked(normalized);
      });

      if (created.length > 0) {
        this.watcher?.notify(
          created.map((path) => ({
            type: 'create' as const,
            path,
            entryType: 'directory' as const,
          }))
        );
      }
    } else {
      await this.withWriteLock(async () => {
        await this.dropSidecarConsistency();
        this.markSidecarDirty(normalized);
        try {
          await this.lfs.mkdir(normalized);
        } catch (err) {
          throw convertError(err, normalized);
        }
      });
      this.watcher?.notify([{ type: 'create', path: normalized, entryType: 'directory' }]);
    }
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    return this.withKindMismatchRetry(normalizePath(path), () => this.rmInner(path, options));
  }

  private async rmInner(path: string, options?: RmOptions): Promise<void> {
    const normalized = normalizePath(path);
    const mount = this.findMount(normalized);
    if (mount) {
      if (mount.relParts.length === 0) {
        throw new FsError('EINVAL', 'cannot remove a mount point — use unmount', normalized);
      }
      let entryType: EntryType | undefined;
      try {
        entryType = (await this.stat(normalized)).type;
      } catch {}
      const relPath = mount.relParts.join('/');
      try {
        await mount.backend.remove(relPath, { recursive: options?.recursive });
      } catch (err) {
        rebrandFsError(err, normalized);
      }
      this.watcher?.notify([{ type: 'delete', path: normalized, entryType }]);

      this.mountIndex.notifyDelete(normalized);
      return;
    }
    try {
      const s = await this.lfs.lstat(normalized);
      await this.withWriteLock(async () => {
        await this.dropSidecarConsistency();
        if (s.isSymbolicLink()) {
          await this.lfs.unlink(normalized);
        } else if (s.isDirectory()) {
          if (options?.recursive) {
            await this.rmRecursiveUnlocked(normalized);
          } else {
            await this.lfs.rmdir(normalized);
          }
        } else {
          await this.lfs.unlink(normalized);
        }

        this.markSidecarDirty(normalized, 'prefix');
        await this.writeOpfsMetadataSidecarUnlocked();
      });
    } catch (err) {
      throw convertError(err, normalized);
    }
    this.watcher?.notify([{ type: 'delete', path: normalized }]);
  }

  private async rmRecursiveUnlocked(path: string): Promise<void> {
    const entries = await this.lfs.readdir(path);
    for (const name of entries) {
      const childPath = path === '/' ? `/${name}` : `${path}/${name}`;
      const stat = await this.lfs.lstat(childPath);
      if (stat.isSymbolicLink()) {
        await this.lfs.unlink(childPath);
      } else if (stat.isDirectory()) {
        await this.rmRecursiveUnlocked(childPath);
      } else {
        await this.lfs.unlink(childPath);
      }
    }
    await this.lfs.rmdir(path);
  }

  async stat(path: string): Promise<Stats> {
    return this.withKindMismatchRetry(path, () => this.statInner(path));
  }

  private async statInner(path: string): Promise<Stats> {
    const normalized = normalizePath(path);
    const mount = this.findMount(normalized);
    if (mount) {
      if (mount.relParts.length === 0) {
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
          ctime: ms.ctime ?? ms.mtime,
          ...(ms.ino !== undefined ? { ino: ms.ino } : {}),
          ...(ms.identity !== undefined ? { identity: ms.identity } : {}),
          ...(ms.dev !== undefined ? { dev: ms.dev } : {}),
          ...(ms.uid !== undefined ? { uid: ms.uid } : {}),
          ...(ms.gid !== undefined ? { gid: ms.gid } : {}),
          ...(ms.mode !== undefined ? { mode: ms.mode } : {}),
        };
      } catch (err) {
        rebrandFsError(err, normalized);
      }
    }

    const resolved = await this.resolveSymlinks(normalized);
    try {
      const s = await this.lfs.stat(resolved);
      return {
        type: s.isDirectory() ? 'directory' : 'file',
        size: s.size,
        mtime: s.mtimeMs,
        ctime: s.ctimeMs,
        ino: s.ino,
        dev: s.dev,
        identity: this.localIdentity(s.ino),
        uid: s.uid,
        gid: s.gid,
        mode: s.mode,
      };
    } catch (err) {
      throw convertError(err, normalized);
    }
  }

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
      await this.stat(normalized);
      return true;
    } catch {
      try {
        await this.lfs.lstat(normalized);
        return true;
      } catch {
        return false;
      }
    }
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    return this.withKindMismatchRetryPaths([normalizePath(oldPath), normalizePath(newPath)], () =>
      this.renameInner(oldPath, newPath)
    );
  }

  private async renameInner(oldPath: string, newPath: string): Promise<void> {
    const normalizedOld = normalizePath(oldPath);
    const normalizedNew = normalizePath(newPath);
    if (normalizedOld === normalizedNew) return;
    let oldStat: Stats | undefined;
    try {
      oldStat = await this.lstat(normalizedOld);
    } catch {}
    const entryType = oldStat?.type;

    const oldMount = this.findMount(normalizedOld);
    if (oldMount?.backend.rename) {
      const newMount = this.findMount(normalizedNew);
      if (newMount && newMount.backend === oldMount.backend) {
        let noop = false;
        try {
          const result = await oldMount.backend.rename(
            oldMount.relParts.join('/'),
            newMount.relParts.join('/')
          );
          noop = result?.noop === true;
        } catch (err) {
          rebrandFsError(err, normalizedOld);
        }
        if (!noop) {
          this.watcher?.notify([
            { type: 'delete', path: normalizedOld, entryType },
            { type: 'create', path: normalizedNew, entryType },
          ]);
          this.mountIndex.notifyRename(normalizedOld, normalizedNew);
        }
        return;
      }
    }

    if (oldStat) {
      try {
        const newStat = await this.lstat(normalizedNew);
        if (sameFileIdentity(oldStat, newStat)) return;
      } catch {}
    }
    try {
      await this.withWriteLock(async () => {
        await this.dropSidecarConsistency();
        this.markSidecarDirty(normalizedOld, 'prefix');
        this.markSidecarDirty(normalizedNew, 'prefix');
        await this.lfs.rename(normalizedOld, normalizedNew);
        await this.writeOpfsMetadataSidecarUnlocked();
      });
    } catch (err) {
      throw convertError(err, normalizedOld);
    }
    this.watcher?.notify([
      { type: 'delete', path: normalizedOld, entryType },
      { type: 'create', path: normalizedNew, entryType },
    ]);

    this.mountIndex.notifyRename(normalizedOld, normalizedNew);
  }

  async readTextFile(path: string): Promise<string> {
    const content = await this.readFile(path, { encoding: 'utf-8' });
    return content as string;
  }

  async *walk(path: string, visited?: Set<string>, depth = 0): AsyncGenerator<string> {
    yield* walk(
      {
        mountPoints: this.mountPoints,
        mountIndex: this.mountIndex,
        realpath: (p) => this.realpath(p),
        readDir: (p) => this.readDir(p),
        stat: (p) => this.stat(p),
      },
      path,
      visited,
      depth
    );
  }

  async copyFile(src: string, dest: string): Promise<void> {
    const srcStat = await this.stat(src);
    if (srcStat.type === 'directory') {
      throw new FsError('EISDIR', 'is a directory', src);
    }
    try {
      const destStat = await this.stat(dest);

      if (sameFileIdentity(srcStat, destStat)) return;
    } catch {}
    const content = await this.readFile(src, { encoding: 'binary' });
    await this.writeFile(dest, content);
  }

  dirname(path: string): string {
    return splitPath(normalizePath(path)).dir;
  }

  basename(path: string): string {
    return splitPath(normalizePath(path)).base;
  }

  private resolveSymlinkTargetPath(target: string, linkPath: string): string {
    return target.startsWith('/')
      ? normalizePath(target)
      : normalizePath(joinPath(splitPath(linkPath).dir, target));
  }

  private assertSymlinkCreateAllowed(target: string, linkPath: string): void {
    if (this.findMount(linkPath)) {
      throw new FsError('EINVAL', 'symlinks not supported on mounted filesystems', linkPath);
    }
    const absoluteTarget = this.resolveSymlinkTargetPath(target, linkPath);
    if (this.findMount(absoluteTarget)) {
      throw new FsError(
        'EXDEV',
        `cannot create a symlink across a mount boundary to '${absoluteTarget}'`,
        linkPath
      );
    }
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    const normalizedLinkPath = normalizePath(linkPath);
    this.assertSymlinkCreateAllowed(target, normalizedLinkPath);

    const { dir } = splitPath(normalizedLinkPath);
    await this.withWriteLock(async () => {
      await this.dropSidecarConsistency();
      if (dir !== '/') {
        await this.mkdirRecursiveUnlocked(dir);
      }
      try {
        await this.lfs.symlink(target, normalizedLinkPath);
      } catch (err) {
        if (dir !== '/' && err instanceof Error && err.message.includes('ENOENT')) {
          await this.mkdirRecursiveUnlocked(dir);
          try {
            await this.lfs.symlink(target, normalizedLinkPath);
          } catch (retryErr) {
            throw convertError(retryErr, normalizedLinkPath);
          }
        } else {
          throw convertError(err, normalizedLinkPath);
        }
      }

      this.markSidecarDirty(normalizedLinkPath);
      await this.writeOpfsMetadataSidecarUnlocked();
    });
    this.watcher?.notify([{ type: 'create', path: normalizedLinkPath, entryType: 'symlink' }]);
  }

  async readlink(path: string): Promise<string> {
    const normalized = normalizePath(path);
    try {
      return await this.lfs.readlink(normalized);
    } catch (err) {
      throw convertError(err, normalized);
    }
  }

  async lstat(path: string): Promise<Stats> {
    const normalized = normalizePath(path);
    const mount = this.findMount(normalized);
    if (mount) {
      return this.stat(normalized);
    }

    if (normalized === '/') return this.stat(normalized);
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
          ino: s.ino,
          dev: s.dev,
          identity: this.localIdentity(s.ino),
          uid: s.uid,
          gid: s.gid,
          mode: s.mode,
        };
      }
      return {
        type: s.isDirectory() ? 'directory' : 'file',
        size: s.size,
        mtime: s.mtimeMs,
        ctime: s.ctimeMs,
        ino: s.ino,
        dev: s.dev,
        identity: this.localIdentity(s.ino),
        uid: s.uid,
        gid: s.gid,
        mode: s.mode,
      };
    } catch (err) {
      throw convertError(err, normalized);
    }
  }

  async realpath(path: string): Promise<string> {
    return realpath(this.lfs, (p) => this.findMount(p) !== null, path);
  }

  private resolveSymlinks(path: string): Promise<string> {
    return resolveSymlinks(this.lfs, (p) => this.findMount(p) !== null, path);
  }
}
