/**
 * SyncFsCache: a pure in-memory filesystem tree used to back synchronous
 * fs APIs (readFileSync, writeFileSync, etc.) inside the realm. The realm
 * executes user code in an AsyncFunction wrapper, so sync APIs cannot
 * `await` an RPC round-trip — instead they read from / write to this
 * pre-loaded cache, and mutations are diffed and flushed back after
 * execution completes.
 *
 * No RPC, no async — this is a plain synchronous data structure.
 */

export interface SyncFsEntry {
  content: Uint8Array;
  isDirectory: boolean;
  truncated?: boolean;
}

export interface SyncFsSnapshot {
  entries: Array<{
    path: string;
    content: Uint8Array;
    isDirectory: boolean;
    /**
     * True when the host skipped reading this file's real content because it
     * exceeded the sync-snapshot size budget (see `realm-host.ts`'s
     * `visitSnapshotFile`). The entry still exists in the cache — `exists()` /
     * `stat()` behave correctly — but `readFile()` throws a descriptive
     * `ENOSYNC` error instead of silently returning empty/wrong content.
     */
    truncated?: boolean;
  }>;
}

export interface SyncFsMutations {
  created: Array<{ path: string; content: Uint8Array; isDirectory: boolean }>;
  modified: Array<{ path: string; content: Uint8Array }>;
  deleted: string[];
}

/** Normalize a path: resolve ., .., collapse //, ensure leading /, no trailing /. */
function normalizePath(path: string): string {
  if (!path || path === '/') return '/';

  if (!path.startsWith('/')) {
    path = '/' + path;
  }

  const parts = path.split('/');
  const resolved: string[] = [];

  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }

  return '/' + resolved.join('/');
}

function dirname(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === '/') return '/';
  const lastSlash = normalized.lastIndexOf('/');
  return lastSlash === 0 ? '/' : normalized.slice(0, lastSlash);
}

function enoent(path: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, '${path}'`), {
    code: 'ENOENT',
  });
}

function enosync(path: string): Error {
  return Object.assign(
    new Error(`ENOSYNC: file too large for sync access, '${path}' — use async readFile() instead`),
    { code: 'ENOSYNC' }
  );
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export class SyncFsCache {
  private tree: Map<string, SyncFsEntry> = new Map();
  private initialPaths: Set<string> = new Set();
  private initialContent: Map<string, Uint8Array> = new Map();
  private initialIsDirectory: Map<string, boolean> = new Map();
  private mkdtempCounter = 0;

  /**
   * True once any sync-fs method has actually been invoked by user code.
   * Drives the exec-coherence perf gate: `js-realm-shared`'s exec bridge only
   * pays the flush-before / re-snapshot-after cost around an exec when the
   * sync-fs API has been used, so exec-only / async-only scripts (the common
   * case) keep the current fast path with no extra RPCs. Never cleared once
   * set — a script that touched sync-fs stays on the coherent path for the
   * rest of the run (see `applySnapshot`).
   */
  private touched = false;

  constructor(snapshot: SyncFsSnapshot) {
    this.loadSnapshot(snapshot);
  }

  /**
   * (Re)build the in-memory tree and the mutation baseline from a host
   * snapshot. Used by the constructor at boot AND by {@link applySnapshot}
   * after an exec re-snapshot. Rebuilding the baseline here is what makes the
   * post-exec host state the new "initial" state, so {@link getMutations}
   * afterwards reports only mutations made AFTER this point.
   */
  private loadSnapshot(snapshot: SyncFsSnapshot): void {
    this.tree = new Map();
    this.initialPaths = new Set();
    this.initialContent = new Map();
    this.initialIsDirectory = new Map();

    this.tree.set('/', { content: new Uint8Array(0), isDirectory: true });
    this.initialPaths.add('/');
    this.initialIsDirectory.set('/', true);

    for (const entry of snapshot.entries) {
      const normalized = normalizePath(entry.path);
      this.tree.set(normalized, {
        content: entry.content,
        isDirectory: entry.isDirectory,
        truncated: entry.truncated,
      });
      this.initialPaths.add(normalized);
      this.initialIsDirectory.set(normalized, entry.isDirectory);
      if (!entry.isDirectory) {
        this.initialContent.set(normalized, entry.content);
      }
    }

    // Synthesize any implied ancestor directories that weren't explicitly
    // listed in the snapshot (e.g. a snapshot containing only
    // '/workspace/a.txt' implies '/workspace' already exists as a dir on
    // the real FS). Without this, the first sync mkdir -p triggered by a
    // write under that path would incorrectly show up as "created".
    for (const entry of snapshot.entries) {
      let dir = dirname(normalizePath(entry.path));
      while (dir !== '/' && !this.tree.has(dir)) {
        this.tree.set(dir, { content: new Uint8Array(0), isDirectory: true });
        this.initialPaths.add(dir);
        this.initialIsDirectory.set(dir, true);
        dir = dirname(dir);
      }
    }
  }

  /**
   * Whether any sync-fs method has been invoked. See {@link touched}. The exec
   * bridge consults this to decide whether an exec needs the flush-before /
   * re-snapshot-after coherence round-trips.
   */
  wasUsed(): boolean {
    return this.touched;
  }

  /**
   * Replace the tree with a fresh host snapshot and reset the mutation
   * baseline to it. Called by the exec bridge AFTER an exec resolves so a
   * subsequent `readFileSync` sees files the exec created/modified. The
   * {@link touched} flag is intentionally preserved: the script has used
   * sync-fs, so it stays on the coherent path for later execs.
   */
  applySnapshot(snapshot: SyncFsSnapshot): void {
    this.loadSnapshot(snapshot);
  }

  /**
   * Snapshot the CURRENT tree as the new mutation baseline. Called by the exec
   * bridge right AFTER a mid-script flush so those already-flushed mutations
   * are not re-applied by a later flush (the next exec, or the end-of-script
   * `flushSyncFsCache`). {@link applySnapshot} supersedes this when the
   * post-exec re-snapshot succeeds; `resetBaseline` is the fallback that still
   * prevents a double-apply if that re-snapshot RPC fails.
   */
  resetBaseline(): void {
    this.initialPaths = new Set();
    this.initialContent = new Map();
    this.initialIsDirectory = new Map();
    for (const [path, entry] of this.tree.entries()) {
      this.initialPaths.add(path);
      this.initialIsDirectory.set(path, entry.isDirectory);
      if (!entry.isDirectory) {
        this.initialContent.set(path, entry.content);
      }
    }
  }

  private ensureParentDirs(path: string): void {
    const dir = dirname(path);
    if (dir === '/') return;
    if (!this.tree.has(dir)) {
      this.mkdir(dir, true);
    }
  }

  readFile(path: string): Uint8Array {
    this.touched = true;
    const normalized = normalizePath(path);
    const entry = this.tree.get(normalized);
    if (!entry || entry.isDirectory) {
      throw enoent(normalized);
    }
    if (entry.truncated) {
      throw enosync(normalized);
    }
    return entry.content;
  }

  writeFile(path: string, content: Uint8Array): void {
    this.touched = true;
    const normalized = normalizePath(path);
    this.ensureParentDirs(normalized);
    this.tree.set(normalized, { content, isDirectory: false });
  }

  exists(path: string): boolean {
    this.touched = true;
    const normalized = normalizePath(path);
    return this.tree.has(normalized);
  }

  stat(path: string): { isFile: boolean; isDirectory: boolean; size: number } {
    this.touched = true;
    const normalized = normalizePath(path);
    const entry = this.tree.get(normalized);
    if (!entry) {
      throw enoent(normalized);
    }
    return {
      isFile: !entry.isDirectory,
      isDirectory: entry.isDirectory,
      size: entry.isDirectory ? 0 : entry.content.byteLength,
    };
  }

  readdir(path: string): string[] {
    this.touched = true;
    const normalized = normalizePath(path);
    const entry = this.tree.get(normalized);
    if (!entry?.isDirectory) {
      throw enoent(normalized);
    }
    const prefix = normalized === '/' ? '/' : normalized + '/';
    const names = new Set<string>();
    for (const p of this.tree.keys()) {
      if (p === normalized || p === '/') continue;
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const firstSegment = rest.split('/')[0];
      if (firstSegment) names.add(firstSegment);
    }
    return Array.from(names);
  }

  mkdir(path: string, recursive?: boolean): void {
    this.touched = true;
    const normalized = normalizePath(path);
    if (this.tree.has(normalized)) {
      const entry = this.tree.get(normalized)!;
      if (entry.isDirectory) return;
      throw Object.assign(new Error(`EEXIST: file already exists, '${normalized}'`), {
        code: 'EEXIST',
      });
    }

    const dir = dirname(normalized);
    if (dir !== '/' && !this.tree.has(dir)) {
      if (!recursive) {
        throw enoent(normalized);
      }
      this.mkdir(dir, true);
    }

    this.tree.set(normalized, { content: new Uint8Array(0), isDirectory: true });
  }

  rm(path: string, recursive?: boolean): void {
    this.touched = true;
    const normalized = normalizePath(path);
    const entry = this.tree.get(normalized);
    if (!entry) {
      throw enoent(normalized);
    }

    if (entry.isDirectory) {
      const prefix = normalized === '/' ? '/' : normalized + '/';
      const children = Array.from(this.tree.keys()).filter(
        (p) => p !== normalized && p.startsWith(prefix)
      );
      if (children.length > 0 && !recursive) {
        throw Object.assign(new Error(`ENOTEMPTY: directory not empty, '${normalized}'`), {
          code: 'ENOTEMPTY',
        });
      }
      for (const child of children) {
        this.tree.delete(child);
      }
    }

    this.tree.delete(normalized);
  }

  copyFile(src: string, dest: string): void {
    this.touched = true;
    const normalizedSrc = normalizePath(src);
    const entry = this.tree.get(normalizedSrc);
    if (!entry || entry.isDirectory) {
      throw enoent(normalizedSrc);
    }
    const normalizedDest = normalizePath(dest);
    this.ensureParentDirs(normalizedDest);
    this.tree.set(normalizedDest, { content: entry.content.slice(), isDirectory: false });
  }

  rename(oldPath: string, newPath: string): void {
    this.touched = true;
    const normalizedOld = normalizePath(oldPath);
    const entry = this.tree.get(normalizedOld);
    if (!entry) {
      throw enoent(normalizedOld);
    }
    const normalizedNew = normalizePath(newPath);

    if (entry.isDirectory) {
      const prefix = normalizedOld === '/' ? '/' : normalizedOld + '/';
      const children = Array.from(this.tree.keys()).filter(
        (p) => p !== normalizedOld && p.startsWith(prefix)
      );
      this.ensureParentDirs(normalizedNew);
      this.tree.set(normalizedNew, entry);
      this.tree.delete(normalizedOld);
      for (const child of children) {
        const childEntry = this.tree.get(child)!;
        const newChildPath = normalizedNew + child.slice(normalizedOld.length);
        this.tree.set(newChildPath, childEntry);
        this.tree.delete(child);
      }
      return;
    }

    this.ensureParentDirs(normalizedNew);
    this.tree.set(normalizedNew, entry);
    this.tree.delete(normalizedOld);
  }

  unlink(path: string): void {
    this.touched = true;
    const normalized = normalizePath(path);
    const entry = this.tree.get(normalized);
    if (!entry) {
      throw enoent(normalized);
    }
    if (entry.isDirectory) {
      throw Object.assign(
        new Error(`EISDIR: illegal operation on a directory, unlink '${normalized}'`),
        {
          code: 'EISDIR',
        }
      );
    }
    this.tree.delete(normalized);
  }

  mkdtemp(prefix: string): string {
    this.touched = true;
    for (let attempts = 0; attempts < 100; attempts++) {
      const suffix = `_${String(this.mkdtempCounter).padStart(6, '0')}`;
      this.mkdtempCounter++;
      const path = normalizePath(prefix + suffix);
      if (!this.tree.has(path)) {
        this.mkdir(path, true);
        return path;
      }
    }
    throw new Error(`mkdtemp: failed to create unique directory after 100 attempts`);
  }

  getMutations(): SyncFsMutations {
    const created: SyncFsMutations['created'] = [];
    const modified: SyncFsMutations['modified'] = [];
    const deleted: string[] = [];

    for (const [path, entry] of this.tree.entries()) {
      if (path === '/') continue;
      if (!this.initialPaths.has(path)) {
        created.push({ path, content: entry.content, isDirectory: entry.isDirectory });
        continue;
      }
      const wasDir = this.initialIsDirectory.get(path);
      if (wasDir !== undefined && wasDir !== entry.isDirectory) {
        // Type changed (dir -> file or file -> dir): emit as delete + create
        // so the host tears down the old node before writing the new one.
        deleted.push(path);
        created.push({ path, content: entry.content, isDirectory: entry.isDirectory });
        continue;
      }
      if (!entry.isDirectory) {
        const initial = this.initialContent.get(path);
        if (initial && !bytesEqual(initial, entry.content)) {
          modified.push({ path, content: entry.content });
        }
      }
    }

    for (const path of this.initialPaths) {
      if (path === '/') continue;
      if (!this.tree.has(path)) {
        deleted.push(path);
      }
    }

    return { created, modified, deleted };
  }
}
