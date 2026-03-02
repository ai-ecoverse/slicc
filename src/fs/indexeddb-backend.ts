/**
 * IndexedDB storage backend.
 *
 * Uses a single object store with normalized paths as keys.
 * Each entry stores type, content (for files), and timestamps.
 * This serves as a fallback for browsers without OPFS support.
 */

import type {
  DirEntry,
  Encoding,
  FileContent,
  MkdirOptions,
  RmOptions,
  Stats,
  StorageBackend,
} from './types.js';
import { FsError } from './types.js';
import { normalizePath, splitPath } from './path-utils.js';

const DB_NAME = 'virtual-fs';
const DB_VERSION = 1;
const STORE_NAME = 'entries';

interface StoredEntry {
  path: string;
  type: 'file' | 'directory';
  /** File content as ArrayBuffer, or null for directories. */
  content: ArrayBuffer | null;
  size: number;
  mtime: number;
  ctime: number;
}

export class IndexedDbBackend implements StorageBackend {
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(private dbName: string = DB_NAME) {}

  /** Open (or create) the IndexedDB database. */
  private openDb(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(this.dbName, DB_VERSION);

        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            const store = db.createObjectStore(STORE_NAME, { keyPath: 'path' });
            store.createIndex('parent', 'parent', { unique: false });
            // Seed the root directory
            store.put({
              path: '/',
              parent: '',
              type: 'directory',
              content: null,
              size: 0,
              mtime: Date.now(),
              ctime: Date.now(),
            });
          }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return this.dbPromise;
  }

  /** Run a transaction and return a promise for the result. */
  private async tx<T>(
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const store = transaction.objectStore(STORE_NAME);
      const request = fn(store);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /** Get a stored entry by path, or null if not found. */
  private async getEntry(path: string): Promise<(StoredEntry & { parent: string }) | null> {
    const result = await this.tx('readonly', (store) => store.get(path));
    return result ?? null;
  }

  /** Get the parent path for a given path (used as the "parent" index). */
  private parentPath(path: string): string {
    const { dir } = splitPath(path);
    return dir;
  }

  /** Ensure all parent directories exist for a given path. */
  private async ensureParents(path: string): Promise<void> {
    const { dir } = splitPath(path);
    if (dir === '/') {
      // Root always exists
      return;
    }
    const parent = await this.getEntry(dir);
    if (!parent) {
      // Recursively create parents
      await this.ensureParents(dir);
      await this.putEntry(dir, 'directory', null);
    } else if (parent.type !== 'directory') {
      throw new FsError('ENOTDIR', 'not a directory', dir);
    }
  }

  /** Put an entry into the store. */
  private async putEntry(
    path: string,
    type: 'file' | 'directory',
    content: ArrayBuffer | null,
  ): Promise<void> {
    const now = Date.now();
    const existing = await this.getEntry(path);
    const entry = {
      path,
      parent: this.parentPath(path),
      type,
      content,
      size: content ? content.byteLength : 0,
      mtime: now,
      ctime: existing?.ctime ?? now,
    };
    await this.tx('readwrite', (store) => store.put(entry));
  }

  async readFile(path: string, encoding: Encoding = 'utf-8'): Promise<FileContent> {
    const normalized = normalizePath(path);
    const entry = await this.getEntry(normalized);

    if (!entry) {
      throw new FsError('ENOENT', 'no such file or directory', normalized);
    }
    if (entry.type !== 'file') {
      throw new FsError('EISDIR', 'is a directory', normalized);
    }

    const buffer = entry.content!;
    if (encoding === 'utf-8') {
      return new TextDecoder().decode(buffer);
    }
    return new Uint8Array(buffer);
  }

  async writeFile(path: string, content: FileContent): Promise<void> {
    const normalized = normalizePath(path);
    if (normalized === '/') {
      throw new FsError('EISDIR', 'is a directory', '/');
    }

    // Ensure parent directories exist
    await this.ensureParents(normalized);

    // Check that path isn't an existing directory
    const existing = await this.getEntry(normalized);
    if (existing?.type === 'directory') {
      throw new FsError('EISDIR', 'is a directory', normalized);
    }

    let buffer: ArrayBuffer;
    if (typeof content === 'string') {
      buffer = new TextEncoder().encode(content).buffer as ArrayBuffer;
    } else {
      buffer = content.buffer.slice(
        content.byteOffset,
        content.byteOffset + content.byteLength,
      ) as ArrayBuffer;
    }

    await this.putEntry(normalized, 'file', buffer);
  }

  async readDir(path: string): Promise<DirEntry[]> {
    const normalized = normalizePath(path);
    const entry = await this.getEntry(normalized);

    if (!entry) {
      throw new FsError('ENOENT', 'no such file or directory', normalized);
    }
    if (entry.type !== 'directory') {
      throw new FsError('ENOTDIR', 'not a directory', normalized);
    }

    // Query all entries whose parent matches this path
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const index = store.index('parent');
      const request = index.getAll(normalized);

      request.onsuccess = () => {
        const results = request.result as Array<StoredEntry & { parent: string }>;
        const entries: DirEntry[] = results.map((r) => {
          const { base } = splitPath(r.path);
          return { name: base, type: r.type };
        });
        resolve(entries);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const normalized = normalizePath(path);
    if (normalized === '/') return;

    if (options?.recursive) {
      // Create each segment
      const segments = normalized.slice(1).split('/');
      let current = '';
      for (const segment of segments) {
        current += '/' + segment;
        const existing = await this.getEntry(current);
        if (!existing) {
          await this.putEntry(current, 'directory', null);
        } else if (existing.type !== 'directory') {
          throw new FsError('ENOTDIR', 'not a directory', current);
        }
      }
    } else {
      const existing = await this.getEntry(normalized);
      if (existing) {
        throw new FsError('EEXIST', 'file already exists', normalized);
      }
      // Verify parent exists
      const { dir } = splitPath(normalized);
      const parent = await this.getEntry(dir);
      if (!parent) {
        throw new FsError('ENOENT', 'no such file or directory', dir);
      }
      if (parent.type !== 'directory') {
        throw new FsError('ENOTDIR', 'not a directory', dir);
      }
      await this.putEntry(normalized, 'directory', null);
    }
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    const normalized = normalizePath(path);
    if (normalized === '/') {
      throw new FsError('EINVAL', 'cannot remove root directory', '/');
    }

    const entry = await this.getEntry(normalized);
    if (!entry) {
      throw new FsError('ENOENT', 'no such file or directory', normalized);
    }

    if (entry.type === 'directory') {
      const children = await this.readDir(normalized);
      if (children.length > 0 && !options?.recursive) {
        throw new FsError('ENOTEMPTY', 'directory not empty', normalized);
      }
      if (options?.recursive) {
        // Delete children first
        for (const child of children) {
          const childPath = normalized === '/' ? `/${child.name}` : `${normalized}/${child.name}`;
          await this.rm(childPath, { recursive: true });
        }
      }
    }

    await this.tx('readwrite', (store) => store.delete(normalized));
  }

  async stat(path: string): Promise<Stats> {
    const normalized = normalizePath(path);
    const entry = await this.getEntry(normalized);

    if (!entry) {
      throw new FsError('ENOENT', 'no such file or directory', normalized);
    }

    return {
      type: entry.type,
      size: entry.size,
      mtime: entry.mtime,
      ctime: entry.ctime,
    };
  }

  async exists(path: string): Promise<boolean> {
    const normalized = normalizePath(path);
    const entry = await this.getEntry(normalized);
    return entry !== null;
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const normalizedOld = normalizePath(oldPath);
    const normalizedNew = normalizePath(newPath);

    const entry = await this.getEntry(normalizedOld);
    if (!entry) {
      throw new FsError('ENOENT', 'no such file or directory', normalizedOld);
    }

    if (entry.type === 'file') {
      // Move file: read, write to new location, delete old
      const content = await this.readFile(normalizedOld, 'binary');
      await this.writeFile(normalizedNew, content);
      await this.rm(normalizedOld);
    } else {
      // Move directory: recursively copy, then delete
      await this.copyDirRecursive(normalizedOld, normalizedNew);
      await this.rm(normalizedOld, { recursive: true });
    }
  }

  /** Recursively copy a directory. */
  private async copyDirRecursive(src: string, dest: string): Promise<void> {
    await this.mkdir(dest, { recursive: true });
    const entries = await this.readDir(src);
    for (const entry of entries) {
      const srcChild = `${src}/${entry.name}`;
      const destChild = `${dest}/${entry.name}`;
      if (entry.type === 'file') {
        const content = await this.readFile(srcChild, 'binary');
        await this.writeFile(destChild, content);
      } else {
        await this.copyDirRecursive(srcChild, destChild);
      }
    }
  }
}
