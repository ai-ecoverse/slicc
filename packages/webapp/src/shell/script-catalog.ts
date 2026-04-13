import type { FsWatcher } from '../fs/index.js';
import {
  discoverBshScripts,
  findMatchingScripts,
  type BshDiscoveryFS,
  type BshEntry,
} from './bsh-discovery.js';
import { discoverJshCommands, type JshDiscoveryFS } from './jsh-discovery.js';

const BSH_ROOTS = ['/workspace', '/shared'] as const;

interface MountAwareFs {
  listMounts?(): string[];
}

interface UnderlyingFsProvider {
  getUnderlyingFS?(): unknown;
}

export interface ScriptCatalogOptions {
  jshFs: JshDiscoveryFS;
  bshFs?: BshDiscoveryFS;
  watcher?: FsWatcher | null;
}

function cloneJshCommands(commands: Map<string, string>): Map<string, string> {
  return new Map(commands);
}

function cloneBshEntries(entries: readonly BshEntry[]): BshEntry[] {
  return entries.map((entry) => ({
    ...entry,
    matchPatterns: [...entry.matchPatterns],
  }));
}

function getMountAwareFs(fs: unknown): MountAwareFs | null {
  if (fs && typeof (fs as MountAwareFs).listMounts === 'function') {
    return fs as MountAwareFs;
  }

  if (fs && typeof (fs as UnderlyingFsProvider).getUnderlyingFS === 'function') {
    const underlying = (fs as UnderlyingFsProvider).getUnderlyingFS?.();
    if (underlying && typeof (underlying as MountAwareFs).listMounts === 'function') {
      return underlying as MountAwareFs;
    }
  }

  return null;
}

function hasAnyMounts(fs: JshDiscoveryFS): boolean {
  return (getMountAwareFs(fs)?.listMounts?.().length ?? 0) > 0;
}

function hasRelevantBshMounts(fs?: BshDiscoveryFS): boolean {
  if (!fs) return false;
  const mounts = getMountAwareFs(fs)?.listMounts?.() ?? [];
  return mounts.some((mountPath) =>
    BSH_ROOTS.some((root) => mountPath === root || mountPath.startsWith(root + '/'))
  );
}

export class ScriptCatalog {
  private readonly jshFs: JshDiscoveryFS;
  private readonly bshFs?: BshDiscoveryFS;
  private readonly watcher: FsWatcher | null;
  private readonly watcherUnsubs: Array<() => void> = [];

  private jshCache: Map<string, string> | null = null;
  private jshInflight: Promise<Map<string, string>> | null = null;
  private bshCache: BshEntry[] | null = null;
  private bshInflight: Promise<BshEntry[]> | null = null;
  private jshGeneration = 0;
  private bshGeneration = 0;

  constructor(options: ScriptCatalogOptions) {
    this.jshFs = options.jshFs;
    this.bshFs = options.bshFs;
    this.watcher = options.watcher ?? null;

    if (this.watcher) {
      this.watcherUnsubs.push(
        this.watcher.watch(
          '/',
          () => true,
          () => this.invalidateJsh()
        )
      );

      if (this.bshFs) {
        for (const root of BSH_ROOTS) {
          this.watcherUnsubs.push(
            this.watcher.watch(
              root,
              () => true,
              () => this.invalidateBsh()
            )
          );
        }
      }
    }
  }

  dispose(): void {
    for (const unsub of this.watcherUnsubs) unsub();
    this.watcherUnsubs.length = 0;
    this.invalidateAll();
  }

  invalidateAll(): void {
    this.invalidateJsh();
    this.invalidateBsh();
  }

  invalidateJsh(): void {
    this.jshGeneration++;
    this.jshCache = null;
    this.jshInflight = null;
  }

  invalidateBsh(): void {
    this.bshGeneration++;
    this.bshCache = null;
    this.bshInflight = null;
  }

  async getJshCommands(): Promise<Map<string, string>> {
    const commands = await this.loadJshCommands();
    return cloneJshCommands(commands);
  }

  async getJshCommandNames(): Promise<string[]> {
    return [...(await this.getJshCommands()).keys()];
  }

  async getBshEntries(): Promise<BshEntry[]> {
    if (!this.bshFs) return [];
    const entries = await this.loadBshEntries();
    return cloneBshEntries(entries);
  }

  async findMatchingBshScripts(url: string): Promise<BshEntry[]> {
    if (!this.bshFs) return [];
    const entries = await this.loadBshEntries();
    return cloneBshEntries(findMatchingScripts(entries, url));
  }

  private shouldCacheJsh(): boolean {
    return !!this.watcher && !hasAnyMounts(this.jshFs);
  }

  private shouldCacheBsh(): boolean {
    return !!this.watcher && !!this.bshFs && !hasRelevantBshMounts(this.bshFs);
  }

  private async loadJshCommands(): Promise<Map<string, string>> {
    const shouldCache = this.shouldCacheJsh();
    if (shouldCache && this.jshCache) return this.jshCache;

    if (!this.jshInflight) {
      const generation = this.jshGeneration;
      const inflight = discoverJshCommands(this.jshFs)
        .then((commands) => {
          const cloned = cloneJshCommands(commands);
          if (shouldCache && this.jshGeneration === generation) {
            this.jshCache = cloned;
          }
          return cloned;
        })
        .finally(() => {
          if (this.jshInflight === inflight) {
            this.jshInflight = null;
          }
        });
      this.jshInflight = inflight;
    }

    return this.jshInflight;
  }

  private async loadBshEntries(): Promise<BshEntry[]> {
    if (!this.bshFs) return [];

    const shouldCache = this.shouldCacheBsh();
    if (shouldCache && this.bshCache) return this.bshCache;

    if (!this.bshInflight) {
      const generation = this.bshGeneration;
      const inflight = discoverBshScripts(this.bshFs)
        .then((entries) => {
          const cloned = cloneBshEntries(entries);
          if (shouldCache && this.bshGeneration === generation) {
            this.bshCache = cloned;
          }
          return cloned;
        })
        .finally(() => {
          if (this.bshInflight === inflight) {
            this.bshInflight = null;
          }
        });
      this.bshInflight = inflight;
    }

    return this.bshInflight;
  }
}
