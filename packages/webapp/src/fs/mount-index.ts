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
}

export class MountIndex {
  private mounts = new Map<string, MountData>();
  private listeners = new Set<() => void>();

  /**
   * Register a mount point and begin async indexing.
   * Returns immediately — indexing runs in the background.
   */
  registerMount(mountPath: string, handle: FileSystemDirectoryHandle): void {
    // Cancel any existing indexing for this path
    this.mounts.get(mountPath)?.abortController?.abort();

    const abortController = new AbortController();
    const data: MountData = {
      handle,
      state: { status: 'pending', indexed: 0 },
      files: new Set(),
      directories: new Set(),
      abortController,
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
   * Re-index a mount point. Use after external changes.
   */
  async refreshMount(mountPath: string): Promise<void> {
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
    if (!data || data.state.status !== 'ready') {
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
   * Check if a path exists in the index.
   * Returns undefined if the index is not ready.
   */
  hasPath(mountPath: string, absolutePath: string): boolean | undefined {
    const data = this.mounts.get(mountPath);
    if (!data || data.state.status !== 'ready') {
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
    if (!data || data.state.status !== 'ready') return;

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
    if (!data || data.state.status !== 'ready') return;

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
    if (!data || data.state.status !== 'ready') return;

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
      data.state = { status: 'error', indexed: 0, error: message };
      log.error('Mount indexing failed', { path: mountPath, error: message });
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
    signal: AbortSignal
  ): Promise<void> {
    if (signal.aborted) return;

    data.directories.add(basePath);

    // Type assertion for async iteration over directory entries
    const entries = handle as unknown as AsyncIterable<[string, FileSystemHandle]>;

    for await (const [name, childHandle] of entries) {
      if (signal.aborted) return;

      const childPath = basePath === '/' ? `/${name}` : `${basePath}/${name}`;

      if (childHandle.kind === 'file') {
        data.files.add(childPath);
        data.state.indexed++;
      } else if (childHandle.kind === 'directory') {
        await this.walkHandle(childPath, childHandle as FileSystemDirectoryHandle, data, signal);
      }

      // Yield to event loop periodically to keep UI responsive
      if (data.state.indexed % 500 === 0) {
        this.notifyListeners();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
  }
}
