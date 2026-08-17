import type { FsWatcher } from '../fs/index.js';
import {
  type BshDiscoveryFS,
  type BshEntry,
  discoverBshScripts,
  findMatchingScripts,
} from './bsh-discovery.js';
import {
  DEFAULT_JSH_SEARCH_ROOTS,
  discoverJshCommands,
  type JshDiscoveryFS,
} from './jsh-discovery.js';
import {
  discoverWorkflowCommands,
  WORKFLOW_DISCOVERY_ROOTS,
  type WorkflowCommandEntry,
} from './workflow-discovery.js';

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

function cloneWorkflowCommands(
  commands: Map<string, WorkflowCommandEntry>
): Map<string, WorkflowCommandEntry> {
  return new Map([...commands].map(([k, v]) => [k, { ...v }]));
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

function hasMountsUnderRoots(fs: JshDiscoveryFS, roots: readonly string[]): boolean {
  const mounts = getMountAwareFs(fs)?.listMounts?.() ?? [];
  return mounts.some((mountPath) =>
    roots.some(
      (root) =>
        mountPath === root || mountPath.startsWith(`${root}/`) || root.startsWith(`${mountPath}/`)
    )
  );
}

function hasRelevantBshMounts(fs?: BshDiscoveryFS): boolean {
  if (!fs) return false;
  const mounts = getMountAwareFs(fs)?.listMounts?.() ?? [];
  return mounts.some((mountPath) =>
    BSH_ROOTS.some((root) => mountPath === root || mountPath.startsWith(root + '/'))
  );
}

interface CachedSource<T> {
  cache: T | null;
  inflight: Promise<T> | null;
  generation: number;
}

function createCachedSource<T>(): CachedSource<T> {
  return { cache: null, inflight: null, generation: 0 };
}

function bumpGeneration<T>(src: CachedSource<T>): void {
  src.generation++;
  src.cache = null;
  src.inflight = null;
}

export class ScriptCatalog {
  private readonly jshFs: JshDiscoveryFS;
  private readonly bshFs?: BshDiscoveryFS;
  private readonly watcher: FsWatcher | null;
  private readonly watcherUnsubs: Array<() => void> = [];

  // One cache per distinct root set: shells share this catalog but can have
  // different $PATH values (cone vs scoops vs a user-extended PATH). The map
  // stays tiny in practice — a handful of PATH shapes per instance.
  private readonly jshByRoots = new Map<string, CachedSource<Map<string, string>>>();
  private readonly bsh: CachedSource<BshEntry[]> = createCachedSource();
  private readonly workflow: CachedSource<Map<string, WorkflowCommandEntry>> = createCachedSource();

  constructor(options: ScriptCatalogOptions) {
    this.jshFs = options.jshFs;
    this.bshFs = options.bshFs;
    this.watcher = options.watcher ?? null;

    if (this.watcher) {
      this.watcherUnsubs.push(
        this.watcher.watch(
          '/',
          () => true,
          () => {
            this.invalidateJsh();
            this.invalidateWorkflows();
          }
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
    this.invalidateWorkflows();
  }

  invalidateJsh(): void {
    for (const src of this.jshByRoots.values()) {
      bumpGeneration(src);
    }
  }

  invalidateBsh(): void {
    bumpGeneration(this.bsh);
  }

  invalidateWorkflows(): void {
    bumpGeneration(this.workflow);
  }

  async getJshCommands(
    roots: readonly string[] = DEFAULT_JSH_SEARCH_ROOTS
  ): Promise<Map<string, string>> {
    const commands = await this.loadJshCommands(roots);
    return cloneJshCommands(commands);
  }

  async getJshCommandNames(roots?: readonly string[]): Promise<string[]> {
    return [...(await this.getJshCommands(roots)).keys()];
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

  async getWorkflowCommands(): Promise<Map<string, WorkflowCommandEntry>> {
    const commands = await this.loadWorkflowCommands();
    return cloneWorkflowCommands(commands);
  }

  // A mount overlapping a search root makes external changes invisible to
  // the FsWatcher, so those root sets stay uncached. Before #2085 ANY mount
  // disabled the cache — because the scan itself covered the whole VFS.
  private shouldCacheJsh(roots: readonly string[]): boolean {
    return !!this.watcher && !hasMountsUnderRoots(this.jshFs, roots);
  }

  private shouldCacheBsh(): boolean {
    return !!this.watcher && !!this.bshFs && !hasRelevantBshMounts(this.bshFs);
  }

  // Workflows are discovered from `jshFs`, so their cache eligibility tracks
  // the same mount-awareness as jsh commands. We expose this as its own method
  // (rather than reusing `shouldCacheJsh` at the call site) to make the
  // intent explicit and to give the predicate room to diverge later.
  private shouldCacheWorkflows(): boolean {
    return !!this.watcher && !hasMountsUnderRoots(this.jshFs, WORKFLOW_DISCOVERY_ROOTS);
  }

  private loadCached<T>(
    src: CachedSource<T>,
    shouldCache: boolean,
    load: () => Promise<T>,
    clone: (value: T) => T
  ): Promise<T> {
    if (shouldCache && src.cache) return Promise.resolve(src.cache);

    if (!src.inflight) {
      const generation = src.generation;
      const inflight = load()
        .then((value) => {
          const cloned = clone(value);
          if (shouldCache && src.generation === generation) {
            src.cache = cloned;
          }
          return cloned;
        })
        .finally(() => {
          if (src.inflight === inflight) {
            src.inflight = null;
          }
        });
      src.inflight = inflight;
    }

    return src.inflight;
  }

  private loadJshCommands(roots: readonly string[]): Promise<Map<string, string>> {
    const key = roots.join(':');
    let src = this.jshByRoots.get(key);
    if (!src) {
      src = createCachedSource();
      this.jshByRoots.set(key, src);
    }
    const frozenRoots = [...roots];
    return this.loadCached(
      src,
      this.shouldCacheJsh(frozenRoots),
      () => discoverJshCommands(this.jshFs, frozenRoots),
      cloneJshCommands
    );
  }

  private loadBshEntries(): Promise<BshEntry[]> {
    if (!this.bshFs) return Promise.resolve([]);
    const bshFs = this.bshFs;
    return this.loadCached(
      this.bsh,
      this.shouldCacheBsh(),
      () => discoverBshScripts(bshFs),
      cloneBshEntries
    );
  }

  private loadWorkflowCommands(): Promise<Map<string, WorkflowCommandEntry>> {
    return this.loadCached(
      this.workflow,
      this.shouldCacheWorkflows(),
      () => discoverWorkflowCommands(this.jshFs),
      cloneWorkflowCommands
    );
  }
}
