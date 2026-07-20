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
  /**
   * Real byte size, recorded even when `content` is empty because the file was
   * truncated (over-cap / beyond the content budget). Lets `statSync().size`
   * report the true size instead of the placeholder's 0. Undefined for entries
   * written in-realm, where `content.byteLength` is authoritative.
   */
  size?: number;
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
    /** Real byte size — set for truncated entries so `statSync().size` is correct. */
    size?: number;
  }>;
}

export interface SyncFsMutations {
  created: Array<{ path: string; content: Uint8Array; isDirectory: boolean }>;
  modified: Array<{ path: string; content: Uint8Array }>;
  deleted: string[];
}

/** Normalize a path: resolve ., .., collapse //, ensure leading /, no trailing /. */
export function normalizePath(path: string): string {
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
   * Paths deleted in-script (`unlink` / `rm` / `rename` source). The
   * `readFileSync` bridge fallback (`realm-fs-bridge`) consults {@link isTombstoned}
   * so a cache-miss on a DELETED path throws `ENOENT` instead of resurrecting
   * the still-live (delete-not-yet-flushed) file via the SW bridge — the
   * read-your-deletes coherence guarantee. Cleared on every host re-snapshot
   * ({@link loadSnapshot}): a fresh snapshot already reflects the flushed delete,
   * so the bridge then returns `ENOENT` on its own.
   */
  private tombstones = new Set<string>();
  /**
   * Roots of recursive directory removals. A fallback read of anything under one
   * is `ENOENT` — the script deleted the whole subtree from its view, even for a
   * bridge-only child never present in the cache (whose live delete is deferred).
   */
  private removedDirs = new Set<string>();

  /**
   * True once any sync-fs method has actually been invoked by user code.
   * Drives the exec-coherence perf gate: `realm-exec-bridge`'s exec bridge only
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
    // A fresh host snapshot reflects the post-flush live state, so in-run
    // delete tombstones no longer apply (the bridge now returns ENOENT itself).
    this.tombstones = new Set();
    this.removedDirs = new Set();
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
        size: entry.size,
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
   * Re-snapshot from the host WITHOUT discarding sync mutations made since the
   * last baseline reset. Used by the exec bridge's `start` (killable spawn)
   * path: unlike `run`/`spawn`, user code keeps running while the background
   * spawn is in flight, so a `writeFileSync` issued after `start()` but before
   * `await done` lives only in this cache and was never flushed. A plain
   * {@link applySnapshot} rebuilds the tree from the host snapshot and would
   * silently drop it. Here we capture those pending mutations first, load the
   * fresh host snapshot as the new baseline, then re-layer the mutations on top
   * so (a) files the exec never touched survive and (b) they remain mutations
   * relative to the new baseline, so the end-of-script flush still ships them.
   * Sync writes win for the paths they touched; exec writes appear elsewhere.
   */
  applySnapshotPreservingMutations(snapshot: SyncFsSnapshot): void {
    const pending = this.getMutations();
    this.loadSnapshot(snapshot);
    // Deletions first: a sync `rm`/`unlink` must not be resurrected by the
    // fresh host baseline.
    for (const path of pending.deleted) {
      const entry = this.tree.get(path);
      if (entry?.isDirectory) {
        const prefix = path === '/' ? '/' : path + '/';
        for (const p of Array.from(this.tree.keys())) {
          if (p !== path && p.startsWith(prefix)) this.tree.delete(p);
        }
      }
      this.tree.delete(path);
    }
    // Then re-layer creates + modifies so sync writes win for their paths.
    for (const c of pending.created) {
      this.ensureParentDirs(c.path);
      this.tree.set(c.path, { content: c.content, isDirectory: c.isDirectory });
    }
    for (const m of pending.modified) {
      this.ensureParentDirs(m.path);
      this.tree.set(m.path, { content: m.content, isDirectory: false });
    }
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

  /**
   * Commit a bridge write into the cache: set the entry (so `exists` / `stat` /
   * `readFile` / `readdir` are all immediately coherent with the write) AND
   * advance the mutation baseline for it, so {@link getMutations} does NOT
   * report it. Used by the shim's write-through path when the bridge is
   * enabled: the bridge already wrote the bytes to the live VFS, so recording a
   * cache mutation would double-flush. Reuses {@link writeFile} for the
   * tree + ancestor-dir bookkeeping, then rebases the baseline onto the result.
   */
  commitWrite(path: string, content: Uint8Array): void {
    this.writeFile(path, content);
    // Rebase the written file AND every ancestor dir `writeFile` may have
    // synthesized onto the baseline, so NONE are reported by getMutations
    // (the bridge already wrote the file live; the dirs already exist live).
    let cursor = normalizePath(path);
    this.initialContent.set(cursor, content);
    while (cursor !== '/') {
      const entry = this.tree.get(cursor);
      if (entry) {
        this.initialPaths.add(cursor);
        this.initialIsDirectory.set(cursor, entry.isDirectory);
      }
      cursor = dirname(cursor);
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
    this.tombstones.delete(normalized); // re-created — no longer a deletion
    this.removedDirs.delete(normalized);
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
      // Truncated entries carry `size` (real bytes) with an empty `content`;
      // in-realm writes carry no `size`, so `content.byteLength` is authoritative.
      size: entry.isDirectory ? 0 : (entry.size ?? entry.content.byteLength),
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
    this.tombstones.delete(normalized); // dir re-created
    this.removedDirs.delete(normalized);
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
        this.tombstones.add(child);
      }
      // Cover the whole subtree — a bridge-only descendant never in the cache is
      // still gone from the script's view, so a fallback read of it is ENOENT.
      if (recursive) this.removedDirs.add(normalized);
    }

    this.tree.delete(normalized);
    this.tombstones.add(normalized);
  }

  copyFile(src: string, dest: string): void {
    this.touched = true;
    const normalizedSrc = normalizePath(src);
    const entry = this.tree.get(normalizedSrc);
    if (!entry || entry.isDirectory) {
      throw enoent(normalizedSrc);
    }
    // An over-cap entry holds only an empty placeholder (real bytes live behind
    // the bridge). Copying it cache-only would silently produce a 0-byte dest —
    // fail loud like `readFile` does. In-shim callers route around this via
    // `readBytes`+`writeThrough`; this guards any other/direct caller.
    if (entry.truncated) {
      throw enosync(normalizedSrc);
    }
    const normalizedDest = normalizePath(dest);
    this.ensureParentDirs(normalizedDest);
    this.tree.set(normalizedDest, { content: entry.content.slice(), isDirectory: false });
    this.tombstones.delete(normalizedDest); // dest re-created
    this.removedDirs.delete(normalizedDest);
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
      this.tombstones.add(normalizedOld);
      this.removedDirs.add(normalizedOld); // source subtree gone from the view
      this.tombstones.delete(normalizedNew);
      this.removedDirs.delete(normalizedNew);
      return;
    }

    this.ensureParentDirs(normalizedNew);
    this.tree.set(normalizedNew, entry);
    this.tree.delete(normalizedOld);
    this.tombstones.add(normalizedOld);
    this.tombstones.delete(normalizedNew);
    this.removedDirs.delete(normalizedNew);
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
    this.tombstones.add(normalized);
  }

  /**
   * True if `path` was deleted in-script (exact tombstone) or lies under a
   * recursively-removed directory. The `readFileSync` bridge fallback consults
   * this so a cache-miss on a deleted path throws `ENOENT` rather than
   * resurrecting the still-live (delete-not-yet-flushed) file via the bridge.
   */
  isTombstoned(path: string): boolean {
    const normalized = normalizePath(path);
    if (this.tombstones.has(normalized)) return true;
    for (const dir of this.removedDirs) {
      if (normalized === dir || normalized.startsWith(`${dir}/`)) return true;
    }
    return false;
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
