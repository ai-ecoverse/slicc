/**
 * MountIndex — maintains a cached file listing for mounted directories.
 *
 * Problem: Walking mounted directories via FileSystemDirectoryHandle is slow
 * because each readDir requires an async IPC round-trip to the browser's file
 * system access layer. For large directories (e.g., node_modules), this can
 * take seconds.
 *
 * Solution: Build an in-memory index of all files in each mount when mounting.
 * The index is built asynchronously and non-blocking. While indexing is in
 * progress, callers fall back to the slow path. Once complete, file discovery
 * (jsh, bsh, skills, etc.) can query the index in O(1).
 *
 * The index is updated incrementally on write/delete operations that go through
 * VirtualFS. External changes (made outside the browser) are NOT automatically
 * detected — use `mount refresh` to re-index.
 */

import { createLogger } from '../core/logger.js';

const log = createLogger('mount-index');

// Bound the recursive mount-index walk so a self-referential mount — a tree that
// re-exposes one of its own ancestors (e.g. a repo checkout whose
// `.claude/worktrees/` nests further checkouts of itself) — cannot grow the
// index without limit and peg / OOM the kernel worker. See `walkHandle`.
// These are the defaults; both are overridable via env (see
// `resolveMountIndexLimits`).
const MAX_INDEX_DEPTH = 400;
const MAX_INDEX_ENTRIES = 2_000_000;

/** Env var overriding the recursion depth bound. */
const ENV_MAX_DEPTH = 'SLICC_MOUNT_INDEX_MAX_DEPTH';
/** Env var overriding the total-entry budget. */
const ENV_MAX_ENTRIES = 'SLICC_MOUNT_INDEX_MAX_ENTRIES';

/**
 * Cap on how many sorted `name+kind` tokens contribute to a directory's cheap
 * cycle-detection signature. Large directories are sampled to the first N tokens
 * so signature construction stays O(entries) rather than ballooning per level.
 */
const SIGNATURE_SAMPLE_CAP = 256;

/**
 * Classifies why a mount index aborted (set on `MountIndexState.abortCause` when
 * `status === 'error'`). Lets consumers (e.g. `mount list`) render a distinct,
 * actionable message per cause instead of conflating every abort into "likely
 * cyclic".
 */
export type MountIndexAbortCause =
  | 'depth-exceeded'
  | 'entries-exceeded'
  | 'cycle-detected'
  | 'indexing-error';

/**
 * Thrown by `walkHandle` when indexing must abort for a classified reason — a
 * depth / entry bound, or a confirmed self-referential cycle. `indexMount` reads
 * `cause` to populate `MountIndexState.abortCause`.
 */
class MountIndexAbortError extends Error {
  readonly cause: MountIndexAbortCause;
  constructor(message: string, cause: MountIndexAbortCause) {
    super(message);
    this.name = 'MountIndexAbortError';
    this.cause = cause;
  }
}

/**
 * One frame of the ancestor stack threaded through `walkHandle` for cycle
 * detection: the directory's VFS path, its live handle (the only thing
 * `isSameEntry()` can compare), and a cheap fingerprint of its entries.
 */
interface AncestorEntry {
  path: string;
  handle: FileSystemDirectoryHandle;
  signature: string;
}

/**
 * Compute a cheap, order-independent fingerprint of a directory from the
 * entries already read: sorted `name + kind` tokens plus the child count. Large
 * directories are sampled to the first `SIGNATURE_SAMPLE_CAP` tokens so this
 * stays O(entries) rather than O(entries·depth). This is a PREFILTER only — a
 * match merely narrows which ancestors are worth an exact `isSameEntry()` call.
 */
function computeDirSignature(children: Array<[string, FileSystemHandle]>): string {
  const tokens = children.map(([name, child]) => `${name}\u0000${child.kind}`).sort();
  const sampled =
    tokens.length > SIGNATURE_SAMPLE_CAP ? tokens.slice(0, SIGNATURE_SAMPLE_CAP) : tokens;
  return `${tokens.length}\u0001${sampled.join('\u0002')}`;
}

/**
 * Exact cycle confirmation. `FileSystemHandle.isSameEntry()` is the ONLY proof
 * of a real cycle. The in-memory Node test FS lacks it, so guard for a missing
 * method or a throwing call — when unavailable we report "not the same" and the
 * depth / entry caps remain the safety net.
 */
async function isSameEntrySafe(
  ancestor: FileSystemDirectoryHandle,
  candidate: FileSystemDirectoryHandle
): Promise<boolean> {
  const isSameEntry = (ancestor as { isSameEntry?: (other: FileSystemHandle) => Promise<boolean> })
    .isSameEntry;
  if (typeof isSameEntry !== 'function') return false;
  try {
    return await isSameEntry.call(ancestor, candidate);
  } catch {
    return false;
  }
}

/** Resolved mount-index walk bounds. */
export interface MountIndexLimits {
  maxDepth: number;
  maxEntries: number;
}

/**
 * The env shapes `resolveMountIndexLimits` accepts. The shell threads just-bash's
 * `CommandContext.env` (a `Map`, populated by `export`); plain records are still
 * accepted for non-shell callers and tests.
 */
export type MountIndexEnv = ReadonlyMap<string, string> | Record<string, string | undefined>;

/** Read a single key from either env shape. */
function readEnvValue(env: MountIndexEnv, name: string): string | undefined {
  return env instanceof Map ? env.get(name) : (env as Record<string, string | undefined>)[name];
}

/** Parse a positive-integer env value, or undefined when invalid. */
function parsePositiveIntLimit(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value <= 0) return undefined;
  return value;
}

function resolveLimit(env: MountIndexEnv, name: string, fallback: number): number {
  const raw = readEnvValue(env, name);
  // Absent (or empty) is normal — the worker/browser float has no OS env, so
  // stay silent and use the default.
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = parsePositiveIntLimit(raw);
  if (parsed === undefined) {
    log.warn(`Ignoring invalid ${name}; expected a positive integer, using default`, {
      value: raw,
      fallback,
    });
    return fallback;
  }
  return parsed;
}

/**
 * Pure resolver for the mount-index bounds. Reads `SLICC_MOUNT_INDEX_MAX_DEPTH`
 * and `SLICC_MOUNT_INDEX_MAX_ENTRIES` from the supplied env; each must parse to a
 * positive integer, otherwise it falls back to the default and warns. The env is
 * just-bash's shell `CommandContext.env` `Map` (populated by `export`), threaded
 * down from the `mount` command; pass `{}` for non-shell callers (reload/restore)
 * to get the defaults.
 */
export function resolveMountIndexLimits(env: MountIndexEnv): MountIndexLimits {
  return {
    maxDepth: resolveLimit(env, ENV_MAX_DEPTH, MAX_INDEX_DEPTH),
    maxEntries: resolveLimit(env, ENV_MAX_ENTRIES, MAX_INDEX_ENTRIES),
  };
}

export interface MountIndexEntry {
  /** Absolute VFS path */
  path: string;
  /** 'file' or 'directory' */
  type: 'file' | 'directory';
}

export type IndexingStatus = 'pending' | 'indexing' | 'ready' | 'error';

export interface MountIndexState {
  status: IndexingStatus;
  /** Number of entries indexed so far (for progress reporting) */
  indexed: number;
  /** Total entries if known, undefined while still discovering */
  total?: number;
  /** Error message if status is 'error' */
  error?: string;
  /** Set only when status === 'error'; classifies why indexing aborted. */
  abortCause?: MountIndexAbortCause;
}

interface MountData {
  handle: FileSystemDirectoryHandle;
  state: MountIndexState;
  /** Set of all file paths under this mount (absolute VFS paths) */
  files: Set<string>;
  /** Set of all directory paths under this mount (absolute VFS paths) */
  directories: Set<string>;
  /** Abort controller for cancelling in-progress indexing */
  abortController: AbortController | null;
  /**
   * Walk bounds for THIS mount, resolved from the shell env at register/refresh
   * time. `walkHandle`/`enforceWalkBounds`/`readChildren` compare against these
   * — not the module-level constants — so per-mount env overrides take effect.
   */
  limits: MountIndexLimits;
}

export class MountIndex {
  private mounts = new Map<string, MountData>();
  private listeners = new Set<() => void>();

  /**
   * Register a mount point and begin async indexing.
   * Returns immediately — indexing runs in the background.
   *
   * `limits` are the resolved walk bounds for this mount (the VFS resolves them
   * from the shell env at mount time); callers without a shell env should pass
   * `resolveMountIndexLimits({})` (the default).
   */
  registerMount(
    mountPath: string,
    handle: FileSystemDirectoryHandle,
    limits: MountIndexLimits = resolveMountIndexLimits({})
  ): void {
    // Cancel any existing indexing for this path
    this.mounts.get(mountPath)?.abortController?.abort();

    const abortController = new AbortController();
    const data: MountData = {
      handle,
      state: { status: 'pending', indexed: 0 },
      files: new Set(),
      directories: new Set(),
      abortController,
      limits,
    };

    this.mounts.set(mountPath, data);
    this.notifyListeners();

    // Start async indexing
    void this.indexMount(mountPath, data, abortController.signal);
  }

  /**
   * Unregister a mount point and clear its index.
   */
  unregisterMount(mountPath: string): void {
    const data = this.mounts.get(mountPath);
    if (data) {
      data.abortController?.abort();
      this.mounts.delete(mountPath);
      this.notifyListeners();
    }
  }

  /**
   * Re-index a mount point. Use after external changes. When `limits` are
   * supplied (e.g. a `mount refresh` after a new `export`), they replace the
   * stored bounds; otherwise the existing per-mount bounds are kept.
   */
  async refreshMount(mountPath: string, limits?: MountIndexLimits): Promise<void> {
    const data = this.mounts.get(mountPath);
    if (!data) {
      throw new Error(`No mount at ${mountPath}`);
    }

    // Cancel existing indexing
    data.abortController?.abort();

    // Reset and re-index
    const abortController = new AbortController();
    data.abortController = abortController;
    data.state = { status: 'pending', indexed: 0 };
    data.files.clear();
    data.directories.clear();
    if (limits) data.limits = limits;
    this.notifyListeners();

    await this.indexMount(mountPath, data, abortController.signal);
  }

  /**
   * Check if a mount's index is ready for fast queries.
   */
  isReady(mountPath: string): boolean {
    return this.mounts.get(mountPath)?.state.status === 'ready';
  }

  /**
   * Check if ANY mount is still indexing (for progress UI).
   */
  isAnyIndexing(): boolean {
    for (const data of this.mounts.values()) {
      if (data.state.status === 'indexing' || data.state.status === 'pending') {
        return true;
      }
    }
    return false;
  }

  /**
   * Dispose of all mounts and cancel any in-flight indexing.
   * Call this when the VirtualFS is disposed to avoid resource leaks.
   */
  dispose(): void {
    for (const data of this.mounts.values()) {
      data.abortController?.abort();
    }
    this.mounts.clear();
    this.listeners.clear();
  }

  /**
   * Get the indexing state for a mount.
   */
  getState(mountPath: string): MountIndexState | undefined {
    return this.mounts.get(mountPath)?.state;
  }

  /**
   * Get all file paths under a mount that match a filter.
   * Returns undefined if the index is not ready (caller should use slow path).
   */
  getFiles(mountPath: string, filter?: (path: string) => boolean): string[] | undefined {
    const data = this.mounts.get(mountPath);
    if (data?.state.status !== 'ready') {
      return undefined;
    }

    if (!filter) {
      return [...data.files];
    }

    const result: string[] = [];
    for (const path of data.files) {
      if (filter(path)) {
        result.push(path);
      }
    }
    return result;
  }

  /**
   * Get directory entries (immediate children) for a path within a mount.
   * Returns undefined if the index is not ready (caller should use slow path).
   */
  getDirectoryEntries(
    mountPath: string,
    dirPath: string
  ): Array<{ name: string; type: 'file' | 'directory' }> | undefined {
    const data = this.mounts.get(mountPath);
    if (data?.state.status !== 'ready') {
      return undefined;
    }

    const prefix = dirPath === '/' ? '/' : dirPath + '/';
    const entries = new Map<string, 'file' | 'directory'>();

    // Find all files that are immediate children of dirPath
    for (const path of data.files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (!rest.includes('/')) {
        entries.set(rest, 'file');
      }
    }

    // Find all directories that are immediate children of dirPath
    for (const path of data.directories) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (!rest.includes('/')) {
        entries.set(rest, 'directory');
      }
    }

    return [...entries.entries()].map(([name, type]) => ({ name, type }));
  }

  /**
   * Check if a path exists in the index.
   * Returns undefined if the index is not ready.
   */
  hasPath(mountPath: string, absolutePath: string): boolean | undefined {
    const data = this.mounts.get(mountPath);
    if (data?.state.status !== 'ready') {
      return undefined;
    }
    return data.files.has(absolutePath) || data.directories.has(absolutePath);
  }

  /**
   * Notify the index that a file was created/written.
   * Called by VirtualFS after write operations.
   */
  notifyWrite(absolutePath: string): void {
    const mountPath = this.findMountForPath(absolutePath);
    if (!mountPath) return;

    const data = this.mounts.get(mountPath);
    if (data?.state.status !== 'ready') return;

    data.files.add(absolutePath);

    // Ensure parent directories are indexed
    let parent = absolutePath;
    while (parent !== mountPath) {
      const lastSlash = parent.lastIndexOf('/');
      if (lastSlash <= 0) break;
      parent = parent.slice(0, lastSlash) || '/';
      if (parent.length >= mountPath.length) {
        data.directories.add(parent);
      }
    }
  }

  /**
   * Notify the index that a file/directory was deleted.
   * Called by VirtualFS after delete operations.
   */
  notifyDelete(absolutePath: string): void {
    const mountPath = this.findMountForPath(absolutePath);
    if (!mountPath) return;

    const data = this.mounts.get(mountPath);
    if (data?.state.status !== 'ready') return;

    // Remove the path and all children
    data.files.delete(absolutePath);
    data.directories.delete(absolutePath);

    const prefix = absolutePath + '/';
    for (const path of data.files) {
      if (path.startsWith(prefix)) {
        data.files.delete(path);
      }
    }
    for (const path of data.directories) {
      if (path.startsWith(prefix)) {
        data.directories.delete(path);
      }
    }
  }

  /**
   * Notify the index that a file/directory was renamed.
   */
  notifyRename(oldPath: string, newPath: string): void {
    const mountPath = this.findMountForPath(oldPath);
    if (!mountPath) return;

    const data = this.mounts.get(mountPath);
    if (data?.state.status !== 'ready') return;

    // Handle file rename
    if (data.files.has(oldPath)) {
      data.files.delete(oldPath);
      data.files.add(newPath);
      return;
    }

    // Handle directory rename (move all children)
    if (data.directories.has(oldPath)) {
      data.directories.delete(oldPath);
      data.directories.add(newPath);

      const oldPrefix = oldPath + '/';
      const newPrefix = newPath + '/';

      for (const path of [...data.files]) {
        if (path.startsWith(oldPrefix)) {
          data.files.delete(path);
          data.files.add(newPrefix + path.slice(oldPrefix.length));
        }
      }
      for (const path of [...data.directories]) {
        if (path.startsWith(oldPrefix)) {
          data.directories.delete(path);
          data.directories.add(newPrefix + path.slice(oldPrefix.length));
        }
      }
    }
  }

  /**
   * Subscribe to index state changes (for UI updates).
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Find which mount (if any) contains an absolute path.
   */
  /** Find the most specific mount that owns this path (longest prefix wins). */
  private findMountForPath(absolutePath: string): string | undefined {
    let bestMatch: string | undefined;
    for (const mountPath of this.mounts.keys()) {
      if (absolutePath === mountPath || absolutePath.startsWith(mountPath + '/')) {
        if (!bestMatch || mountPath.length > bestMatch.length) {
          bestMatch = mountPath;
        }
      }
    }
    return bestMatch;
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Ignore listener errors
      }
    }
  }

  /**
   * Perform the actual indexing of a mount point.
   */
  private async indexMount(mountPath: string, data: MountData, signal: AbortSignal): Promise<void> {
    data.state = { status: 'indexing', indexed: 0 };
    this.notifyListeners();

    try {
      await this.walkHandle(mountPath, data.handle, data, signal);

      if (signal.aborted) return;

      data.state = {
        status: 'ready',
        indexed: data.files.size + data.directories.size,
        total: data.files.size + data.directories.size,
      };
      data.abortController = null;

      log.info('Mount indexed', {
        path: mountPath,
        files: data.files.size,
        directories: data.directories.size,
      });
    } catch (err) {
      if (signal.aborted) return;

      const message = err instanceof Error ? err.message : String(err);
      const abortCause: MountIndexAbortCause =
        err instanceof MountIndexAbortError ? err.cause : 'indexing-error';
      data.state = { status: 'error', indexed: 0, error: message, abortCause };
      log.error('Mount indexing failed', { path: mountPath, error: message, abortCause });
    }

    this.notifyListeners();
  }

  /**
   * Recursively walk a FileSystemDirectoryHandle and index all entries.
   */
  private async walkHandle(
    basePath: string,
    handle: FileSystemDirectoryHandle,
    data: MountData,
    signal: AbortSignal,
    depth = 0,
    signatureBuckets: Map<string, AncestorEntry[]> = new Map()
  ): Promise<void> {
    if (signal.aborted) return;
    this.enforceWalkBounds(depth, data);

    data.directories.add(basePath);

    // Read this directory's entries up front so we can fingerprint it for cycle
    // detection before descending. `readChildren` enforces the entry budget as
    // it buffers so a single huge flat directory can't OOM before the bound.
    const children = await this.readChildren(handle, signal, data);
    if (signal.aborted) return;

    const signature = await this.confirmNoCycle(basePath, handle, children, signatureBuckets);

    // Push this directory onto its signature bucket for descendants, popping it
    // back off after — keeps the buckets scoped to the current ancestor chain.
    const bucket = this.pushAncestor(signatureBuckets, signature, basePath, handle);
    try {
      await this.walkChildren(basePath, children, data, signal, depth, signatureBuckets);
    } finally {
      this.popAncestor(signatureBuckets, signature, bucket);
    }
  }

  /**
   * Depth / entry caps are the unconditional safety net: even when cycle
   * detection can't run (no `isSameEntry`), a self-referential mount cannot grow
   * the index without limit and OOM / peg the kernel worker. Exceeding either
   * bound aborts indexing; `indexMount` marks the mount `error`, so reads fall
   * back to the slow per-`readDir` path instead of trusting a partial index.
   */
  private enforceWalkBounds(depth: number, data: MountData): void {
    if (depth > data.limits.maxDepth) {
      throw new MountIndexAbortError(
        `mount indexing aborted: directory nesting exceeded ${data.limits.maxDepth} levels`,
        'depth-exceeded'
      );
    }
    if (data.directories.size + data.files.size >= data.limits.maxEntries) {
      throw new MountIndexAbortError(
        `mount indexing aborted: exceeded ${data.limits.maxEntries} entries`,
        'entries-exceeded'
      );
    }
  }

  /**
   * Buffer a directory's entries (type assertion for async iteration). The entry
   * budget is re-checked against the running total as each child is read so a
   * single huge flat directory aborts with `entries-exceeded` immediately,
   * before its full listing is materialized in memory.
   */
  private async readChildren(
    handle: FileSystemDirectoryHandle,
    signal: AbortSignal,
    data: MountData
  ): Promise<Array<[string, FileSystemHandle]>> {
    const entries = handle as unknown as AsyncIterable<[string, FileSystemHandle]>;
    const children: Array<[string, FileSystemHandle]> = [];
    for await (const entry of entries) {
      if (signal.aborted) break;
      if (data.directories.size + data.files.size + children.length >= data.limits.maxEntries) {
        throw new MountIndexAbortError(
          `mount indexing aborted: exceeded ${data.limits.maxEntries} entries`,
          'entries-exceeded'
        );
      }
      children.push(entry);
    }
    return children;
  }

  /**
   * Best-effort cycle detection (approximate prefilter + exact confirmation): a
   * self-referential mount re-exposes one of its own ancestors. Only ancestors
   * sharing this directory's cheap signature are worth an exact `isSameEntry()`
   * check; a confirmed match is the only proof of a cycle. Returns the computed
   * signature so the caller can bucket this directory for its descendants.
   */
  private async confirmNoCycle(
    basePath: string,
    handle: FileSystemDirectoryHandle,
    children: Array<[string, FileSystemHandle]>,
    signatureBuckets: Map<string, AncestorEntry[]>
  ): Promise<string> {
    const signature = computeDirSignature(children);
    const candidates = signatureBuckets.get(signature);
    if (candidates) {
      for (const ancestor of candidates) {
        if (await isSameEntrySafe(ancestor.handle, handle)) {
          throw new MountIndexAbortError(
            `mount indexing aborted: self-referential mount cycle detected at ${basePath} (re-exposes ${ancestor.path})`,
            'cycle-detected'
          );
        }
      }
    }
    return signature;
  }

  /** Push this directory onto its signature bucket, creating the bucket if new. */
  private pushAncestor(
    signatureBuckets: Map<string, AncestorEntry[]>,
    signature: string,
    basePath: string,
    handle: FileSystemDirectoryHandle
  ): AncestorEntry[] {
    let bucket = signatureBuckets.get(signature);
    if (!bucket) {
      bucket = [];
      signatureBuckets.set(signature, bucket);
    }
    bucket.push({ path: basePath, handle, signature });
    return bucket;
  }

  /** Pop this directory off its signature bucket, dropping the bucket if empty. */
  private popAncestor(
    signatureBuckets: Map<string, AncestorEntry[]>,
    signature: string,
    bucket: AncestorEntry[]
  ): void {
    bucket.pop();
    if (bucket.length === 0) signatureBuckets.delete(signature);
  }

  /** Index each child entry, recursing into directories. */
  private async walkChildren(
    basePath: string,
    children: Array<[string, FileSystemHandle]>,
    data: MountData,
    signal: AbortSignal,
    depth: number,
    signatureBuckets: Map<string, AncestorEntry[]>
  ): Promise<void> {
    for (const [name, childHandle] of children) {
      if (signal.aborted) return;

      const childPath = basePath === '/' ? `/${name}` : `${basePath}/${name}`;

      if (childHandle.kind === 'file') {
        data.files.add(childPath);
        data.state.indexed++;
      } else if (childHandle.kind === 'directory') {
        await this.walkHandle(
          childPath,
          childHandle as FileSystemDirectoryHandle,
          data,
          signal,
          depth + 1,
          signatureBuckets
        );
      }

      // Yield to event loop periodically to keep UI responsive
      if (data.state.indexed % 500 === 0) {
        this.notifyListeners();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
  }
}
