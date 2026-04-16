/**
 * VirtualFS adapter for just-bash's IFileSystem interface.
 *
 * Wraps our VirtualFS (OPFS/IndexedDB backed) so that just-bash
 * can use it as its filesystem backend.
 */

import type { VirtualFS } from '../fs/index.js';
import { normalizePath, joinPath, FsError } from '../fs/index.js';
import { consumeCachedBinary } from './binary-cache.js';
import type {
  IFileSystem,
  FsStat,
  MkdirOptions,
  RmOptions,
  CpOptions,
  FileContent,
  BufferEncoding,
} from 'just-bash';

// These types are defined in just-bash's fs/interface.d.ts but not re-exported
// from the package root. Define locally to match IFileSystem's method signatures.
interface ReadFileOptions {
  encoding?: BufferEncoding | null;
}
interface WriteFileOptions {
  encoding?: BufferEncoding;
}
interface DirentEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

export class VfsAdapter implements IFileSystem {
  private registeredCommandsFn: (() => string[]) | null = null;

  constructor(private vfs: VirtualFS) {}

  /**
   * Set a function that returns the list of registered command names.
   * Used to populate the virtual /usr/bin directory.
   */
  setRegisteredCommandsFn(fn: () => string[]): void {
    this.registeredCommandsFn = fn;
  }

  private getVirtualBinCommands(): string[] {
    return this.registeredCommandsFn?.() ?? [];
  }

  async readFile(path: string, options?: ReadFileOptions | BufferEncoding): Promise<string> {
    const normalized = normalizePath(path);
    const raw = await this.vfs.readFile(normalized, { encoding: 'binary' });
    const bytes = raw instanceof Uint8Array ? raw : new TextEncoder().encode(raw as string);
    // Try UTF-8 first — valid text files decode cleanly.
    // Binary files (PNG, JPEG, etc.) contain invalid UTF-8 sequences;
    // fall back to latin1 which maps each byte to a char, preserving all values.
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      // Don't use TextDecoder('iso-8859-1') — browsers treat it as windows-1252
      // per WHATWG spec, remapping bytes 0x80-0x9F to different codepoints.
      // String.fromCharCode maps each byte directly to its Unicode codepoint.
      const chars = new Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) chars[i] = String.fromCharCode(bytes[i]);
      return chars.join('');
    }
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const normalized = normalizePath(path);
    const content = await this.vfs.readFile(normalized, { encoding: 'binary' });
    if (content instanceof Uint8Array) return content;
    return new TextEncoder().encode(content as string);
  }

  async writeFile(
    path: string,
    content: FileContent,
    _options?: WriteFileOptions | BufferEncoding
  ): Promise<void> {
    const normalized = normalizePath(path);
    if (typeof content === 'string') {
      // Check binary cache first — createProxiedFetch stores original bytes
      // here for binary responses so we can bypass string encoding entirely.
      const cachedBytes = consumeCachedBinary(content);
      if (cachedBytes) {
        await this.vfs.writeFile(normalized, cachedBytes);
        return;
      }
      // Detect whether the string contains characters above U+00FF.
      // If so, it's definitely Unicode text (from resp.text()) — use UTF-8 encoding.
      // If all chars are ≤ 0xFF, it may be latin1-encoded binary data (from curl
      // fetching images/archives) — use charCodeAt to preserve raw bytes.
      // ASCII text (all chars ≤ 0x7F) is identical in both encodings.
      let hasHighCodepoints = false;
      for (let i = 0; i < content.length; i++) {
        if (content.charCodeAt(i) > 0xff) {
          hasHighCodepoints = true;
          break;
        }
      }
      if (hasHighCodepoints) {
        // Unicode text — encode as proper UTF-8
        await this.vfs.writeFile(normalized, new TextEncoder().encode(content));
      } else {
        // ASCII or latin1-encoded binary — charCodeAt preserves byte values
        const bytes = new Uint8Array(content.length);
        for (let i = 0; i < content.length; i++) {
          bytes[i] = content.charCodeAt(i);
        }
        await this.vfs.writeFile(normalized, bytes);
      }
    } else {
      await this.vfs.writeFile(normalized, content);
    }
  }

  async appendFile(
    path: string,
    content: FileContent,
    _options?: WriteFileOptions | BufferEncoding
  ): Promise<void> {
    const normalized = normalizePath(path);
    // Read existing content as binary to avoid encoding corruption
    let existingBytes = new Uint8Array(0);
    try {
      const existing = await this.vfs.readFile(normalized, { encoding: 'binary' });
      existingBytes =
        existing instanceof Uint8Array
          ? new Uint8Array(existing)
          : new TextEncoder().encode(existing as string);
    } catch (err) {
      // Only treat ENOENT as "file doesn't exist yet" — re-throw other errors
      if (err instanceof FsError && err.code === 'ENOENT') {
        // File doesn't exist yet, start empty
      } else {
        throw err;
      }
    }
    // Convert new content to bytes
    let newBytes: Uint8Array;
    if (typeof content === 'string') {
      newBytes = new Uint8Array(content.length);
      for (let i = 0; i < content.length; i++) {
        newBytes[i] = content.charCodeAt(i) & 0xff;
      }
    } else {
      newBytes = content instanceof Uint8Array ? content : new Uint8Array(content);
    }
    // Concatenate and write
    const combined = new Uint8Array(existingBytes.length + newBytes.length);
    combined.set(existingBytes);
    combined.set(newBytes, existingBytes.length);
    await this.vfs.writeFile(normalized, combined);
  }

  async exists(path: string): Promise<boolean> {
    const normalized = normalizePath(path);
    if (normalized === '/usr' || normalized === '/usr/bin') return true;
    if (normalized.startsWith('/usr/bin/')) {
      const cmdName = normalized.slice('/usr/bin/'.length);
      return (
        cmdName.length > 0 &&
        !cmdName.includes('/') &&
        this.getVirtualBinCommands().includes(cmdName)
      );
    }
    return this.vfs.exists(normalized);
  }

  async stat(path: string): Promise<FsStat> {
    const normalized = normalizePath(path);
    // Virtual /usr and /usr/bin directories
    if (normalized === '/usr' || normalized === '/usr/bin') {
      return {
        isFile: false,
        isDirectory: true,
        isSymbolicLink: false,
        mode: 0o755,
        size: 0,
        mtime: new Date(0),
      };
    }
    // Virtual /usr/bin/<command> entries
    if (normalized.startsWith('/usr/bin/')) {
      const cmdName = normalized.slice('/usr/bin/'.length);
      if (
        cmdName.length > 0 &&
        !cmdName.includes('/') &&
        this.getVirtualBinCommands().includes(cmdName)
      ) {
        return {
          isFile: true,
          isDirectory: false,
          isSymbolicLink: false,
          mode: 0o755,
          size: 0,
          mtime: new Date(0),
        };
      }
    }
    // Fast path: synchronous CacheFS stat for non-mounted paths
    const fast = this.vfs.statSync(normalized);
    if (fast) {
      return {
        isFile: fast.type === 'file',
        isDirectory: fast.type === 'directory',
        isSymbolicLink: !!fast.isSymlink,
        mode: fast.type === 'directory' ? 0o755 : 0o644,
        size: fast.size,
        mtime: new Date(fast.mtime),
      };
    }
    const s = await this.vfs.stat(normalized);
    return {
      isFile: s.type === 'file',
      isDirectory: s.type === 'directory',
      isSymbolicLink: !!s.isSymlink,
      mode: s.type === 'directory' ? 0o755 : 0o644,
      size: s.size,
      mtime: new Date(s.mtime),
    };
  }

  async lstat(path: string): Promise<FsStat> {
    const normalized = normalizePath(path);
    // Fast path: synchronous CacheFS lstat for non-mounted paths
    const fast = this.vfs.lstatSync(normalized);
    if (fast) {
      return {
        isFile: fast.type === 'file',
        isDirectory: fast.type === 'directory',
        isSymbolicLink: fast.type === 'symlink',
        mode: fast.type === 'directory' ? 0o755 : fast.type === 'symlink' ? 0o777 : 0o644,
        size: fast.size,
        mtime: new Date(fast.mtime),
      };
    }
    const s = await this.vfs.lstat(normalized);
    return {
      isFile: s.type === 'file',
      isDirectory: s.type === 'directory',
      isSymbolicLink: s.type === 'symlink',
      mode: s.type === 'directory' ? 0o755 : s.type === 'symlink' ? 0o777 : 0o644,
      size: s.size,
      mtime: new Date(s.mtime),
    };
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    await this.vfs.mkdir(normalizePath(path), options);
  }

  async readdir(path: string): Promise<string[]> {
    const normalized = normalizePath(path);
    if (normalized === '/usr') return ['bin'];
    if (normalized === '/usr/bin') return this.getVirtualBinCommands().slice().sort();
    // Fast path: synchronous CacheFS read for non-mounted paths
    const fast = this.vfs.readDirSync(normalized);
    if (fast !== null) return fast.map((e) => e.name);
    const entries = await this.vfs.readDir(normalized);
    return entries.map((e) => e.name);
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    const normalized = normalizePath(path);
    if (normalized === '/usr') {
      return [{ name: 'bin', isFile: false, isDirectory: true, isSymbolicLink: false }];
    }
    if (normalized === '/usr/bin') {
      return this.getVirtualBinCommands()
        .slice()
        .sort()
        .map((name) => ({
          name,
          isFile: true,
          isDirectory: false,
          isSymbolicLink: false,
        }));
    }

    // Fast path: synchronous CacheFS read for non-mounted paths.
    // readDirSync returns null when the path is under a mount or
    // the CacheFS internal isn't available.
    const fastEntries = this.vfs.readDirSync(normalized);
    if (fastEntries !== null) {
      const result: DirentEntry[] = [];
      for (const e of fastEntries) {
        if (e.type === 'symlink') {
          const childPath = normalized === '/' ? `/${e.name}` : `${normalized}/${e.name}`;
          // Try synchronous stat first (follows symlinks via CacheFS)
          const targetStat = this.vfs.statSync(childPath);
          if (targetStat) {
            result.push({
              name: e.name,
              isFile: targetStat.type === 'file',
              isDirectory: targetStat.type === 'directory',
              isSymbolicLink: true,
            });
          } else {
            // Symlink target is in a mount or unresolvable — fall back to async
            let isFile = false;
            let isDir = false;
            try {
              const asyncStat = await this.vfs.stat(childPath);
              isFile = asyncStat.type === 'file';
              isDir = asyncStat.type === 'directory';
            } catch {
              // Dangling symlink
            }
            result.push({ name: e.name, isFile, isDirectory: isDir, isSymbolicLink: true });
          }
        } else {
          result.push({
            name: e.name,
            isFile: e.type === 'file',
            isDirectory: e.type === 'directory',
            isSymbolicLink: false,
          });
        }
      }
      return result;
    }

    // Slow path: async VirtualFS readDir for mounted paths.
    const entries = await this.vfs.readDir(normalized);
    const result: DirentEntry[] = [];
    for (const e of entries) {
      if (e.type === 'symlink') {
        // Try to determine if symlink target is file or directory
        let isFile = false;
        let isDir = false;
        try {
          const childPath = normalized === '/' ? `/${e.name}` : `${normalized}/${e.name}`;
          const targetStat = await this.vfs.stat(childPath);
          isFile = targetStat.type === 'file';
          isDir = targetStat.type === 'directory';
        } catch {
          // Dangling symlink — report as symlink only
        }
        result.push({
          name: e.name,
          isFile,
          isDirectory: isDir,
          isSymbolicLink: true,
        });
      } else {
        result.push({
          name: e.name,
          isFile: e.type === 'file',
          isDirectory: e.type === 'directory',
          isSymbolicLink: false,
        });
      }
    }
    return result;
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    await this.vfs.rm(normalizePath(path), options);
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    const normalizedSrc = normalizePath(src);
    const normalizedDest = normalizePath(dest);
    const stat = await this.vfs.stat(normalizedSrc);

    if (stat.type === 'directory') {
      if (!options?.recursive) {
        throw new FsError('EISDIR', 'is a directory', normalizedSrc);
      }
      await this.cpDir(normalizedSrc, normalizedDest);
    } else {
      await this.vfs.copyFile(normalizedSrc, normalizedDest);
    }
  }

  /** Recursively copy a directory tree. */
  private async cpDir(src: string, dest: string): Promise<void> {
    await this.vfs.mkdir(dest, { recursive: true });
    const entries = await this.vfs.readDir(src);
    for (const entry of entries) {
      const srcChild = joinPath(src, entry.name);
      const destChild = joinPath(dest, entry.name);
      if (entry.type === 'directory') {
        await this.cpDir(srcChild, destChild);
      } else {
        await this.vfs.copyFile(srcChild, destChild);
      }
    }
  }

  async mv(src: string, dest: string): Promise<void> {
    await this.vfs.rename(normalizePath(src), normalizePath(dest));
  }

  resolvePath(base: string, path: string): string {
    if (path.startsWith('/')) return normalizePath(path);
    return normalizePath(joinPath(base, path));
  }

  getAllPaths(): string[] {
    // Our VFS doesn't support synchronous listing; just-bash uses this
    // for glob matching but can fall back to readdir-based walking.
    return [];
  }

  async chmod(_path: string, _mode: number): Promise<void> {
    // Our VFS doesn't track permissions — no-op
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    await this.vfs.symlink(target, normalizePath(linkPath));
  }

  async link(_existingPath: string, _newPath: string): Promise<void> {
    throw new Error('Hard links not supported in VirtualFS');
  }

  async readlink(path: string): Promise<string> {
    return this.vfs.readlink(normalizePath(path));
  }

  async realpath(path: string): Promise<string> {
    return this.vfs.realpath(normalizePath(path));
  }

  async utimes(path: string, _atime: Date, _mtime: Date): Promise<void> {
    // Our VFS doesn't support setting times — no-op
  }
}
