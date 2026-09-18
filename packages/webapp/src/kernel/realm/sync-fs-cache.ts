export interface SyncFsEntry {
  content: Uint8Array;
  isDirectory: boolean;

  isSymbolicLink?: boolean;

  symlinkTarget?: string;
  truncated?: boolean;

  size?: number;

  partial?: boolean;
}

export interface SyncFsSnapshot {
  entries: Array<{
    path: string;
    content: Uint8Array;
    isDirectory: boolean;

    isSymbolicLink?: boolean;

    symlinkTarget?: string;

    truncated?: boolean;

    size?: number;
  }>;
}

export interface SyncFsMutations {
  created: Array<{
    path: string;
    content: Uint8Array;
    isDirectory: boolean;
    isSymbolicLink?: boolean;
    symlinkTarget?: string;
  }>;
  modified: Array<{ path: string; content: Uint8Array }>;
  deleted: string[];
}

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
  private initialKind: Map<string, 'file' | 'directory' | 'symlink'> = new Map();
  private mkdtempCounter = 0;

  private tombstones = new Set<string>();

  private removedDirs = new Set<string>();

  private touched = false;

  constructor(snapshot: SyncFsSnapshot) {
    this.loadSnapshot(snapshot);
  }

  private loadSnapshot(snapshot: SyncFsSnapshot): void {
    this.tree = new Map();

    this.tombstones = new Set();
    this.removedDirs = new Set();
    this.initialPaths = new Set();
    this.initialContent = new Map();
    this.initialKind = new Map();

    this.tree.set('/', { content: new Uint8Array(0), isDirectory: true });
    this.initialPaths.add('/');
    this.initialKind.set('/', 'directory');

    for (const entry of snapshot.entries) {
      const normalized = normalizePath(entry.path);
      this.tree.set(normalized, {
        content: entry.content,
        isDirectory: entry.isDirectory,
        isSymbolicLink: entry.isSymbolicLink,
        symlinkTarget: entry.symlinkTarget,
        truncated: entry.truncated,
        size: entry.size,
      });
      this.initialPaths.add(normalized);
      this.initialKind.set(normalized, this.entryKind(entry));
      if (!entry.isDirectory && !entry.isSymbolicLink) {
        this.initialContent.set(normalized, entry.content);
      }
    }

    for (const entry of snapshot.entries) {
      let dir = dirname(normalizePath(entry.path));
      while (dir !== '/' && !this.tree.has(dir)) {
        this.tree.set(dir, { content: new Uint8Array(0), isDirectory: true });
        this.initialPaths.add(dir);
        this.initialKind.set(dir, 'directory');
        dir = dirname(dir);
      }
    }
  }

  wasUsed(): boolean {
    return this.touched;
  }

  applySnapshot(snapshot: SyncFsSnapshot): void {
    this.loadSnapshot(snapshot);
  }

  applySnapshotPreservingMutations(snapshot: SyncFsSnapshot): void {
    const pending = this.getMutations();
    this.loadSnapshot(snapshot);

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

    for (const c of pending.created) {
      this.ensureParentDirs(c.path);

      this.tree.set(c.path, {
        content: c.content,
        isDirectory: c.isDirectory,
        isSymbolicLink: c.isSymbolicLink,
        symlinkTarget: c.symlinkTarget,
      });
    }
    for (const m of pending.modified) {
      this.ensureParentDirs(m.path);
      this.tree.set(m.path, { content: m.content, isDirectory: false });
    }
  }

  invalidate(): void {
    this.loadSnapshot({ entries: [] });
  }

  resetBaseline(): void {
    this.initialPaths = new Set();
    this.initialContent = new Map();
    this.initialKind = new Map();
    for (const [path, entry] of this.tree.entries()) {
      this.initialPaths.add(path);
      this.initialKind.set(path, this.entryKind(entry));
      if (!entry.isDirectory && !entry.isSymbolicLink) {
        this.initialContent.set(path, entry.content);
      }
    }
  }

  private entryKind(entry: {
    isDirectory: boolean;
    isSymbolicLink?: boolean;
  }): 'file' | 'directory' | 'symlink' {
    if (entry.isSymbolicLink) return 'symlink';
    return entry.isDirectory ? 'directory' : 'file';
  }

  private resolveEntry(
    path: string,
    preserveFinalSymlink = false
  ): { path: string; entry: SyncFsEntry } | undefined {
    const original = normalizePath(path);
    let remaining = original.split('/').filter(Boolean);
    let resolved: string[] = [];
    const seen = new Set<string>();
    let hops = 0;

    if (remaining.length === 0) {
      const entry = this.tree.get('/');
      return entry ? { path: '/', entry } : undefined;
    }

    while (remaining.length > 0) {
      const segment = remaining.shift()!;
      const candidate = `/${[...resolved, segment].join('/')}`;
      const entry = this.tree.get(candidate);
      if (!entry) return undefined;
      const final = remaining.length === 0;
      if (entry.isSymbolicLink && !(preserveFinalSymlink && final)) {
        if (seen.has(candidate) || hops++ === 40) {
          throw Object.assign(new Error(`ELOOP: too many symbolic links, '${original}'`), {
            code: 'ELOOP',
          });
        }
        seen.add(candidate);
        const target = entry.symlinkTarget ?? '';
        const targetPath = target.startsWith('/') ? target : `${dirname(candidate)}/${target}`;
        remaining = [...normalizePath(targetPath).split('/').filter(Boolean), ...remaining];
        resolved = [];
        continue;
      }
      if (!final && !entry.isDirectory) return undefined;
      resolved.push(segment);
      if (final) return { path: candidate, entry };
    }
    return undefined;
  }

  private ensureParentDirs(path: string): void {
    const dir = dirname(path);
    if (dir === '/') return;
    if (!this.tree.has(dir)) this.mkdir(dir, true, true);
  }

  isPartial(path: string): boolean {
    return this.tree.get(normalizePath(path))?.partial === true;
  }

  commitWrite(path: string, content: Uint8Array): void {
    this.writeFile(path, content);

    let cursor = normalizePath(path);
    this.initialContent.set(cursor, content);
    while (cursor !== '/') {
      const entry = this.tree.get(cursor);
      if (entry) {
        this.initialPaths.add(cursor);
        this.initialKind.set(cursor, this.entryKind(entry));
      }
      cursor = dirname(cursor);
    }
  }

  readFile(path: string): Uint8Array {
    this.touched = true;
    const normalized = normalizePath(path);
    const resolved = this.resolveEntry(normalized);
    const entry = resolved?.entry;
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
    this.tombstones.delete(normalized);
    this.removedDirs.delete(normalized);
  }

  exists(path: string): boolean {
    this.touched = true;
    const normalized = normalizePath(path);
    return this.tree.has(normalized);
  }

  stat(path: string): {
    isFile: boolean;
    isDirectory: boolean;
    isSymbolicLink: boolean;
    size: number;
  } {
    this.touched = true;
    const normalized = normalizePath(path);
    const resolved = this.resolveEntry(normalized);
    if (!resolved) throw enoent(normalized);
    return this.toStat(resolved.entry);
  }

  lstat(path: string): {
    isFile: boolean;
    isDirectory: boolean;
    isSymbolicLink: boolean;
    size: number;
  } {
    this.touched = true;
    const normalized = normalizePath(path);

    const resolved = this.resolveEntry(normalized, true);
    if (!resolved) throw enoent(normalized);
    return this.toStat(resolved.entry);
  }

  private toStat(entry: SyncFsEntry) {
    return {
      isFile: !entry.isDirectory && !entry.isSymbolicLink,
      isDirectory: entry.isDirectory,
      isSymbolicLink: entry.isSymbolicLink === true,

      size: entry.isDirectory ? 0 : (entry.size ?? entry.content.byteLength),
    };
  }

  readdir(path: string): string[] {
    this.touched = true;
    const normalized = normalizePath(path);
    const resolved = this.resolveEntry(normalized);
    if (!resolved?.entry.isDirectory) {
      throw enoent(normalized);
    }
    const prefix = resolved.path === '/' ? '/' : resolved.path + '/';
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

  mkdir(path: string, recursive?: boolean, partial = false): void {
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
      this.mkdir(dir, true, partial);
    }

    this.tree.set(normalized, {
      content: new Uint8Array(0),
      isDirectory: true,
      ...(partial ? { partial: true } : {}),
    });
    this.tombstones.delete(normalized);
    this.removedDirs.delete(normalized);
  }

  rm(path: string, recursive?: boolean): void {
    this.touched = true;
    const normalized = normalizePath(path);
    const entry = this.tree.get(normalized);
    if (!entry) {
      throw enoent(normalized);
    }

    if (entry.isDirectory && !entry.isSymbolicLink) {
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

    if (entry.truncated) {
      throw enosync(normalizedSrc);
    }
    const normalizedDest = normalizePath(dest);
    this.ensureParentDirs(normalizedDest);
    this.tree.set(normalizedDest, { content: entry.content.slice(), isDirectory: false });
    this.tombstones.delete(normalizedDest);
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
      this.removedDirs.add(normalizedOld);
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
    if (entry.isDirectory && !entry.isSymbolicLink) {
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

  markRemoved(path: string, recursive = false): void {
    this.touched = true;
    const normalized = normalizePath(path);
    this.tombstones.add(normalized);
    if (recursive) this.removedDirs.add(normalized);
  }

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
        created.push({
          path,
          content: entry.content,
          isDirectory: entry.isDirectory,
          isSymbolicLink: entry.isSymbolicLink,
          symlinkTarget: entry.symlinkTarget,
        });
        continue;
      }
      const wasKind = this.initialKind.get(path);
      if (wasKind !== undefined && wasKind !== this.entryKind(entry)) {
        deleted.push(path);
        created.push({
          path,
          content: entry.content,
          isDirectory: entry.isDirectory,
          isSymbolicLink: entry.isSymbolicLink,
          symlinkTarget: entry.symlinkTarget,
        });
        continue;
      }
      if (!entry.isDirectory && !entry.isSymbolicLink) {
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
