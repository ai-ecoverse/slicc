import { FsError } from '../types.js';
import type {
  MountBackend,
  MountDescription,
  MountDirEntry,
  MountStat,
  ReadDirOptions,
  RefreshReport,
} from './backend.js';

export interface LocalMountBackendOptions {
  mountId: string;

  dirCacheMax?: number;
}

const DEFAULT_DIR_CACHE_MAX = 512;

export class LocalMountBackend implements MountBackend {
  readonly kind = 'local' as const;

  readonly listingStatsMatchStat = true;
  readonly source = undefined;
  readonly profile = undefined;
  readonly mountId: string;

  private readonly handle: FileSystemDirectoryHandle;
  private readonly dirCacheMax: number;

  private readonly dirCache = new Map<string, FileSystemDirectoryHandle>();
  private closed = false;

  private constructor(handle: FileSystemDirectoryHandle, opts: LocalMountBackendOptions) {
    this.handle = handle;
    this.mountId = opts.mountId;
    this.dirCacheMax = opts.dirCacheMax ?? DEFAULT_DIR_CACHE_MAX;
  }

  static fromHandle(
    handle: FileSystemDirectoryHandle,
    opts: LocalMountBackendOptions
  ): LocalMountBackend {
    return new LocalMountBackend(handle, opts);
  }

  getHandle(): FileSystemDirectoryHandle {
    return this.handle;
  }

  private assertOpen(path: string): void {
    if (this.closed) {
      throw new FsError('EBADF', 'mount closed', path);
    }
  }

  private splitPath(path: string): string[] {
    return path
      .replace(/^\/+/, '')
      .replace(/\/+$/, '')
      .split('/')
      .filter((s) => s.length > 0);
  }

  private cacheGet(key: string): FileSystemDirectoryHandle | undefined {
    const hit = this.dirCache.get(key);
    if (hit === undefined) return undefined;

    this.dirCache.delete(key);
    this.dirCache.set(key, hit);
    return hit;
  }

  private cacheSet(key: string, handle: FileSystemDirectoryHandle): void {
    if (this.dirCache.has(key)) this.dirCache.delete(key);
    this.dirCache.set(key, handle);
    while (this.dirCache.size > this.dirCacheMax) {
      const oldest = this.dirCache.keys().next();
      if (oldest.done) break;
      this.dirCache.delete(oldest.value);
    }
  }

  private invalidate(key: string): void {
    if (key === '') {
      this.dirCache.clear();
      return;
    }
    const prefix = `${key}/`;
    for (const cached of [...this.dirCache.keys()]) {
      if (cached === key || cached.startsWith(prefix)) this.dirCache.delete(cached);
    }
  }

  getDirCacheSize(): number {
    return this.dirCache.size;
  }

  private async resolveDirFrom(
    segments: string[],
    path: string,
    create: boolean,
    useCache = true
  ): Promise<FileSystemDirectoryHandle> {
    let dir = this.handle;
    let key = '';
    let index = 0;

    if (useCache) {
      for (let i = segments.length; i > 0; i--) {
        const candidate = segments.slice(0, i).join('/');
        const hit = this.cacheGet(candidate);
        if (hit) {
          dir = hit;
          key = candidate;
          index = i;
          break;
        }
      }
    }
    const startedFrom = key;
    for (; index < segments.length; index++) {
      const seg = segments[index];
      try {
        dir = await dir.getDirectoryHandle(seg, { create });
      } catch (err) {
        if (create && startedFrom !== '') {
          this.invalidate(startedFrom);
          return this.resolveDirFrom(segments, path, create, false);
        }
        throw this.toFsError(err, path);
      }
      key = key === '' ? seg : `${key}/${seg}`;
      this.cacheSet(key, dir);
    }
    return dir;
  }

  private async resolveDir(path: string, create = false): Promise<FileSystemDirectoryHandle> {
    return this.resolveDirFrom(this.splitPath(path), path, create);
  }

  private async resolveParent(
    path: string,
    create: boolean
  ): Promise<{ parent: FileSystemDirectoryHandle; name: string }> {
    const segments = this.splitPath(path);
    if (segments.length === 0) {
      throw new FsError('EISDIR', 'is a directory', path);
    }
    const name = segments.pop()!;
    return { parent: await this.resolveDirFrom(segments, path, create), name };
  }

  private async resolveFile(path: string, create = false): Promise<FileSystemFileHandle> {
    const { parent, name } = await this.resolveParent(path, create);
    try {
      return await parent.getFileHandle(name, { create });
    } catch (err) {
      throw this.toFsError(err, path);
    }
  }

  private toFsError(err: unknown, path: string): FsError {
    if (err instanceof FsError) return err;
    if (err instanceof DOMException) {
      if (err.name === 'NotFoundError')
        return new FsError('ENOENT', 'no such file or directory', path);
      if (err.name === 'TypeMismatchError') return new FsError('ENOTDIR', 'not a directory', path);
      if (err.name === 'NotAllowedError') return new FsError('EACCES', 'permission denied', path);

      if (err.name === 'InvalidModificationError')
        return new FsError('ENOTEMPTY', 'directory not empty', path);
    }

    if (err instanceof Error) {
      if (err.name === 'NotFound' || err.name === 'NotFoundError')
        return new FsError('ENOENT', 'no such file or directory', path);
      if (err.name === 'TypeMismatch' || err.name === 'TypeMismatchError')
        return new FsError('ENOTDIR', 'not a directory', path);
      if (err.name === 'InvalidModification' || err.name === 'InvalidModificationError')
        return new FsError('ENOTEMPTY', 'directory not empty', path);
    }
    return new FsError('EINVAL', err instanceof Error ? err.message : String(err), path);
  }

  async readDir(path: string, opts?: ReadDirOptions): Promise<MountDirEntry[]> {
    this.assertOpen(path);
    const dir = await this.resolveDir(path);
    const out: MountDirEntry[] = [];
    for await (const [name, child] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
      if (child.kind !== 'file') {
        out.push({ name, kind: 'directory' });
        continue;
      }
      if (!opts?.includeStats) {
        out.push({ name, kind: 'file' });
        continue;
      }
      const file = await (child as FileSystemFileHandle).getFile();
      out.push({ name, kind: 'file', size: file.size, lastModified: file.lastModified });
    }
    return out;
  }

  async readFile(path: string): Promise<Uint8Array> {
    this.assertOpen(path);
    const fh = await this.resolveFile(path);
    const file = await fh.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  async getNativeFile(path: string): Promise<File | null> {
    this.assertOpen(path);
    try {
      const fh = await this.resolveFile(path);
      return await fh.getFile();
    } catch {
      return null;
    }
  }

  async writeFile(path: string, body: Uint8Array): Promise<void> {
    this.assertOpen(path);
    const fh = await this.resolveFile(path, true);
    const writable = await fh.createWritable();

    await writable.write(body as unknown as BufferSource);
    await writable.close();
  }

  async stat(path: string): Promise<MountStat> {
    this.assertOpen(path);
    const segments = this.splitPath(path);
    if (segments.length === 0) {
      return { kind: 'directory', size: 0, mtime: 0 };
    }
    const name = segments.pop()!;
    const parent = await this.resolveDirFrom(segments, path, false);

    try {
      const fh = await parent.getFileHandle(name);
      const file = await fh.getFile();
      return { kind: 'file', size: file.size, mtime: file.lastModified };
    } catch (err) {
      const mapped = this.toFsError(err, path);
      if (mapped.code !== 'ENOENT' && mapped.code !== 'ENOTDIR') throw mapped;
    }
    try {
      const dir = await parent.getDirectoryHandle(name);
      this.cacheSet(segments.length === 0 ? name : `${segments.join('/')}/${name}`, dir);
    } catch (err) {
      throw this.toFsError(err, path);
    }
    return { kind: 'directory', size: 0, mtime: 0 };
  }

  async mkdir(path: string): Promise<void> {
    this.assertOpen(path);
    await this.resolveDir(path, true);
  }

  async remove(path: string, opts?: { recursive?: boolean }): Promise<void> {
    this.assertOpen(path);
    const segments = this.splitPath(path);
    if (segments.length === 0) {
      throw new FsError('EINVAL', 'cannot remove mount root', path);
    }
    const name = segments.pop()!;
    const parent = await this.resolveDirFrom(segments, path, false);
    try {
      await (
        parent as unknown as {
          removeEntry: (n: string, o?: { recursive?: boolean }) => Promise<void>;
        }
      ).removeEntry(name, { recursive: opts?.recursive ?? false });
    } catch (err) {
      throw this.toFsError(err, path);
    }
    this.invalidate(segments.length === 0 ? name : `${segments.join('/')}/${name}`);
  }

  async refresh(): Promise<RefreshReport> {
    this.assertOpen('/');

    this.dirCache.clear();
    return { added: [], removed: [], changed: [], unchanged: 0, errors: [] };
  }

  describe(): MountDescription {
    return { displayName: this.handle.name };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.dirCache.clear();
  }
}
