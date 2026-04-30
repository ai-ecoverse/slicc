/**
 * `LocalMountBackend` wraps a `FileSystemDirectoryHandle` and implements
 * `MountBackend` on top of the File System Access API. Lifts the read/write
 * paths that previously lived directly in `virtual-fs.ts`; the picker dance
 * (cone approval, extension popup, standalone direct picker) lifts in a
 * follow-up task as the `create()` factory.
 */

import { FsError } from '../types.js';
import type {
  MountBackend,
  MountDirEntry,
  MountStat,
  MountDescription,
  MountApprovalCopy,
  RefreshReport,
} from './backend.js';

export interface LocalMountBackendOptions {
  mountId: string;
}

export class LocalMountBackend implements MountBackend {
  readonly kind = 'local' as const;
  readonly source = undefined;
  readonly profile = undefined;
  readonly mountId: string;

  private readonly handle: FileSystemDirectoryHandle;
  private closed = false;

  private constructor(handle: FileSystemDirectoryHandle, opts: LocalMountBackendOptions) {
    this.handle = handle;
    this.mountId = opts.mountId;
  }

  static fromHandle(
    handle: FileSystemDirectoryHandle,
    opts: LocalMountBackendOptions
  ): LocalMountBackend {
    return new LocalMountBackend(handle, opts);
  }

  /** Test/internal access to the underlying handle. */
  getHandle(): FileSystemDirectoryHandle {
    return this.handle;
  }

  // --- internal helpers ---

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

  private async resolveDir(path: string, create = false): Promise<FileSystemDirectoryHandle> {
    const segments = this.splitPath(path);
    let dir = this.handle;
    for (const seg of segments) {
      try {
        dir = await dir.getDirectoryHandle(seg, { create });
      } catch (err) {
        throw this.toFsError(err, path);
      }
    }
    return dir;
  }

  private async resolveFile(path: string, create = false): Promise<FileSystemFileHandle> {
    const segments = this.splitPath(path);
    if (segments.length === 0) {
      throw new FsError('EISDIR', 'is a directory', path);
    }
    const fileName = segments.pop()!;
    let dir = this.handle;
    for (const seg of segments) {
      try {
        dir = await dir.getDirectoryHandle(seg, { create });
      } catch (err) {
        throw this.toFsError(err, path);
      }
    }
    try {
      return await dir.getFileHandle(fileName, { create });
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
      // FSA throws InvalidModificationError from removeEntry() when the
      // target is a non-empty directory and `recursive` was not requested.
      // Surface that as ENOTEMPTY so callers (notably isomorphic-git's
      // checkout/reset cleanup path) can tolerate untracked files.
      if (err.name === 'InvalidModificationError')
        return new FsError('ENOTEMPTY', 'directory not empty', path);
    }
    // Mock helpers may throw a plain Error with name='NotFound' (no -Error suffix).
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

  // --- MountBackend implementation ---

  async readDir(path: string): Promise<MountDirEntry[]> {
    this.assertOpen(path);
    const dir = await this.resolveDir(path);
    const out: MountDirEntry[] = [];
    for await (const [name, child] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
      if (child.kind === 'file') {
        const file = await (child as FileSystemFileHandle).getFile();
        out.push({ name, kind: 'file', size: file.size, lastModified: file.lastModified });
      } else {
        out.push({ name, kind: 'directory' });
      }
    }
    return out;
  }

  async readFile(path: string): Promise<Uint8Array> {
    this.assertOpen(path);
    const fh = await this.resolveFile(path);
    const file = await fh.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  async writeFile(path: string, body: Uint8Array): Promise<void> {
    this.assertOpen(path);
    const fh = await this.resolveFile(path, true);
    const writable = await fh.createWritable();
    // TS 5.7 narrowed BufferSource's ArrayBufferLike to ArrayBuffer; our
    // Uint8Array may carry a SharedArrayBuffer in the type, so cast.
    await writable.write(body as unknown as BufferSource);
    await writable.close();
  }

  async stat(path: string): Promise<MountStat> {
    this.assertOpen(path);
    const segments = this.splitPath(path);
    if (segments.length === 0) {
      return { kind: 'directory', size: 0, mtime: 0 };
    }
    // Try as a file first. Any failure (ENOENT, ENOTDIR, EISDIR, etc.) is
    // fine — fall through to the directory check, which will succeed if
    // the path is a directory and produce the correct ENOENT otherwise.
    try {
      const fh = await this.resolveFile(path);
      const file = await fh.getFile();
      return { kind: 'file', size: file.size, mtime: file.lastModified };
    } catch {
      // fall through
    }
    await this.resolveDir(path); // throws ENOENT if missing
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
    const parentPath = segments.join('/');
    const parent = await this.resolveDir(parentPath || '/');
    try {
      await (
        parent as unknown as {
          removeEntry: (n: string, o?: { recursive?: boolean }) => Promise<void>;
        }
      ).removeEntry(name, { recursive: opts?.recursive ?? false });
    } catch (err) {
      throw this.toFsError(err, path);
    }
  }

  async refresh(): Promise<RefreshReport> {
    // Local mounts have no body cache to revalidate; refresh is a no-op
    // beyond what `MountIndex` does (re-walk for fast-discovery cache).
    // `MountIndex` re-walking lives in mount-index.ts and is triggered by
    // virtual-fs.ts; not the backend's job to drive it.
    this.assertOpen('/');
    return { added: [], removed: [], changed: [], unchanged: 0, errors: [] };
  }

  describe(): MountDescription {
    return { displayName: this.handle.name };
  }

  describeForApproval(): MountApprovalCopy {
    return {
      summary: `Mount local directory '${this.handle.name}'`,
      // `create()` factory owns the picker; reactivation after recovery
      // needs a separate user gesture flow not driven from here.
      needsPicker: false,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
