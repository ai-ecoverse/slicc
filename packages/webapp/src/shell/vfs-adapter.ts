import { Buffer } from 'buffer';
import type {
  BufferEncoding,
  ByteString,
  CpOptions,
  FileContent,
  FsStat,
  IFileSystem,
  MkdirOptions,
  RmOptions,
} from 'just-bash';
import * as justBash from 'just-bash';
import type { DirEntry, Stats, VirtualFS } from '../fs/index.js';
import { FsError, joinPath, normalizePath, statsFromDirEntry } from '../fs/index.js';
import { consumeCachedBinary } from './binary-cache.js';
import { parkReadBytes } from './request-body-provenance.js';

type RunTrustedAsync = <T>(fn: () => Promise<T> | T) => Promise<T>;
const DefenseInDepthBox = Reflect.get(justBash, 'DefenseInDepthBox') as
  | { runTrustedAsync?: RunTrustedAsync }
  | undefined;

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

function fileEncoding(options?: ReadFileOptions | BufferEncoding): BufferEncoding {
  return (typeof options === 'string' ? options : options?.encoding) ?? 'utf8';
}

function encodeWriteContent(
  content: FileContent,
  options?: WriteFileOptions | BufferEncoding
): Uint8Array {
  if (typeof content !== 'string') return content;
  const encoding = fileEncoding(options);

  if (encoding === 'binary' || encoding === 'latin1') {
    const cached = consumeCachedBinary(content);
    if (cached) return cached;
  }
  return Buffer.from(content, encoding);
}

const LISTING_STAT_TTL_MS = 1000;

const MAX_LISTING_STATS = 20_000;

export interface VfsAdapterOptions {
  listingStatsMax?: number;

  listingStatsTtlMs?: number;
}

export class VfsAdapter implements IFileSystem {
  private registeredCommandsFn: (() => string[]) | null = null;

  private readonly listingStats = new Map<string, { stats: Stats; at: number }>();
  private readonly listingStatsMax: number;
  private readonly listingStatsTtlMs: number;

  constructor(
    private vfs: VirtualFS,
    opts?: VfsAdapterOptions
  ) {
    this.listingStatsMax = Math.max(1, opts?.listingStatsMax ?? MAX_LISTING_STATS);
    this.listingStatsTtlMs = opts?.listingStatsTtlMs ?? LISTING_STAT_TTL_MS;
  }

  get listingStatsSize(): number {
    return this.listingStats.size;
  }

  private primeListingStats(dir: string, entries: DirEntry[]): void {
    const at = Date.now();

    if (entries.length > this.listingStatsMax) {
      this.listingStats.clear();
      return;
    }
    this.sweepExpiredListingStats(at);
    if (this.listingStats.size + entries.length > this.listingStatsMax) {
      this.listingStats.clear();
    }
    const prefix = dir === '/' ? '/' : `${dir}/`;
    for (const entry of entries) {
      const stats = statsFromDirEntry(entry);
      const path = `${prefix}${entry.name}`;

      this.listingStats.delete(path);
      if (stats) this.listingStats.set(path, { stats, at });
    }
  }

  private sweepExpiredListingStats(now: number): void {
    for (const [path, hit] of this.listingStats) {
      if (now - hit.at <= this.listingStatsTtlMs) break;
      this.listingStats.delete(path);
    }
  }

  private primedStats(path: string): Stats | undefined {
    const hit = this.listingStats.get(path);
    if (!hit) return undefined;
    if (Date.now() - hit.at > this.listingStatsTtlMs) {
      this.listingStats.delete(path);
      return undefined;
    }
    return hit.stats;
  }

  private dropListingStats(): void {
    this.listingStats.clear();
  }

  setRegisteredCommandsFn(fn: () => string[]): void {
    this.registeredCommandsFn = fn;
  }

  private getVirtualBinCommands(): string[] {
    return this.registeredCommandsFn?.() ?? [];
  }

  private virtualUsrStat(normalized: string): FsStat | null {
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
    return null;
  }

  canWrite(path: string): boolean {
    const wrapped = this.vfs as unknown as { canWrite?: (p: string) => boolean };
    return typeof wrapped.canWrite === 'function' ? wrapped.canWrite(path) : true;
  }

  listMountPoints(): { path: string; kind: 'local' | 'hostfs' | 's3' | 'da' | 'aem' | 'proc' }[] {
    const wrapped = this.vfs as unknown as {
      listMountPoints?: () => {
        path: string;
        kind: 'local' | 'hostfs' | 's3' | 'da' | 'aem' | 'proc';
      }[];
    };
    return typeof wrapped.listMountPoints === 'function' ? wrapped.listMountPoints() : [];
  }

  private trusted<T>(fn: () => Promise<T>): Promise<T> {
    const runTrustedAsync = DefenseInDepthBox?.runTrustedAsync;
    return runTrustedAsync ? runTrustedAsync(fn) : Promise.resolve().then(fn);
  }

  async readFile(path: string, options?: ReadFileOptions | BufferEncoding): Promise<string> {
    return this.trusted(async () => {
      const normalized = normalizePath(path);
      const raw = await this.vfs.readFile(normalized, { encoding: 'binary' });
      const bytes = raw instanceof Uint8Array ? raw : new TextEncoder().encode(raw as string);
      const encoding = fileEncoding(options);
      const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(encoding);

      if (encoding !== 'hex' && encoding !== 'base64') parkReadBytes(text, bytes);
      return text;
    });
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    return this.trusted(async () => {
      const normalized = normalizePath(path);
      const content = await this.vfs.readFile(normalized, { encoding: 'binary' });
      if (content instanceof Uint8Array) return content;
      return new TextEncoder().encode(content as string);
    });
  }

  async readFileBytes(path: string): Promise<ByteString> {
    const bytes = await this.readFileBuffer(path);
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
      'latin1'
    ) as unknown as ByteString;
  }

  async getNativeFile(path: string): Promise<File | null> {
    return this.trusted(() => this.vfs.getNativeFile(normalizePath(path)));
  }

  async readFileRange(path: string, start: number, end: number): Promise<Uint8Array> {
    return this.trusted(() => this.vfs.readFileRange(normalizePath(path), start, end));
  }

  async writeFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding
  ): Promise<void> {
    this.dropListingStats();
    return this.trusted(async () => {
      const normalized = normalizePath(path);
      await this.vfs.writeFile(normalized, encodeWriteContent(content, options));
    });
  }

  async appendFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding
  ): Promise<void> {
    this.dropListingStats();
    return this.trusted(() =>
      this.vfs.appendFile(normalizePath(path), encodeWriteContent(content, options))
    );
  }

  async exists(path: string): Promise<boolean> {
    return this.trusted(async () => {
      const normalized = normalizePath(path);
      if (this.virtualUsrStat(normalized)) return true;
      return this.vfs.exists(normalized);
    });
  }

  async stat(path: string): Promise<FsStat> {
    return this.trusted(async () => {
      const normalized = normalizePath(path);

      const virtual = this.virtualUsrStat(normalized);
      if (virtual) return virtual;

      const fast = this.vfs.statSync(normalized);
      if (fast) {
        return {
          isFile: fast.type === 'file',
          isDirectory: fast.type === 'directory',
          isSymbolicLink: !!fast.isSymlink,
          mode: fast.mode ?? (fast.type === 'directory' ? 0o755 : 0o644),
          size: fast.size,
          mtime: new Date(fast.mtime),
          identity: fast.identity,
          dev: fast.dev,
          ino: fast.identity === undefined ? undefined : fast.ino,
        };
      }

      const s = this.primedStats(normalized) ?? (await this.vfs.stat(normalized));
      return {
        isFile: s.type === 'file',
        isDirectory: s.type === 'directory',
        isSymbolicLink: !!s.isSymlink,
        mode: s.mode ?? (s.type === 'directory' ? 0o755 : 0o644),
        size: s.size,
        mtime: new Date(s.mtime),
        identity: s.identity,
        dev: s.dev,
        ino: s.identity === undefined ? undefined : s.ino,
      };
    });
  }

  async lstat(path: string): Promise<FsStat> {
    return this.trusted(async () => {
      const normalized = normalizePath(path);

      const virtual = this.virtualUsrStat(normalized);
      if (virtual) return virtual;

      const fast = this.vfs.lstatSync(normalized);
      if (fast) {
        return {
          isFile: fast.type === 'file',
          isDirectory: fast.type === 'directory',
          isSymbolicLink: fast.type === 'symlink',
          mode:
            fast.mode ??
            (fast.type === 'directory' ? 0o755 : fast.type === 'symlink' ? 0o777 : 0o644),
          size: fast.size,
          mtime: new Date(fast.mtime),
          identity: fast.identity,
          dev: fast.dev,
          ino: fast.identity === undefined ? undefined : fast.ino,
        };
      }
      const s = this.primedStats(normalized) ?? (await this.vfs.lstat(normalized));
      return {
        isFile: s.type === 'file',
        isDirectory: s.type === 'directory',
        isSymbolicLink: s.type === 'symlink',
        mode: s.mode ?? (s.type === 'directory' ? 0o755 : s.type === 'symlink' ? 0o777 : 0o644),
        size: s.size,
        mtime: new Date(s.mtime),
        identity: s.identity,
        dev: s.dev,
        ino: s.identity === undefined ? undefined : s.ino,
      };
    });
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    this.dropListingStats();
    return this.trusted(async () => {
      await this.vfs.mkdir(normalizePath(path), options);
    });
  }

  async readdir(path: string): Promise<string[]> {
    return this.trusted(async () => {
      const normalized = normalizePath(path);
      if (normalized === '/usr') return ['bin'];
      if (normalized === '/usr/bin') return this.getVirtualBinCommands().slice().sort();

      const fast = this.vfs.readDirSync(normalized);
      if (fast !== null) return fast.map((e) => e.name);

      const entries = await this.vfs.readDir(normalized, { includeStats: true });
      this.primeListingStats(normalized, entries);
      return entries.map((e) => e.name);
    });
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    return this.trusted(async () => {
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

      const fastEntries = this.vfs.readDirSync(normalized);
      if (fastEntries !== null) {
        return this.mapFastEntriesToDirents(fastEntries);
      }

      const entries = await this.vfs.readDir(normalized, { includeStats: true });
      this.primeListingStats(normalized, entries);
      return this.mapAsyncEntriesToDirents(entries);
    });
  }

  private mapFastEntriesToDirents(fastEntries: { name: string; type: string }[]): DirentEntry[] {
    return fastEntries.map((e) => this.entryToDirent(e));
  }

  private mapAsyncEntriesToDirents(entries: { name: string; type: string }[]): DirentEntry[] {
    return entries.map((e) => this.entryToDirent(e));
  }

  private entryToDirent(e: { name: string; type: string }): DirentEntry {
    if (e.type === 'symlink') {
      return { name: e.name, isFile: false, isDirectory: false, isSymbolicLink: true };
    }
    return {
      name: e.name,
      isFile: e.type === 'file',
      isDirectory: e.type === 'directory',
      isSymbolicLink: false,
    };
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    this.dropListingStats();
    return this.trusted(async () => {
      await this.vfs.rm(normalizePath(path), options);
    });
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    this.dropListingStats();
    return this.trusted(async () => {
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
    });
  }

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
    this.dropListingStats();
    return this.trusted(async () => {
      await this.vfs.rename(normalizePath(src), normalizePath(dest));
    });
  }

  async rename(src: string, dest: string): Promise<void> {
    return this.mv(src, dest);
  }

  resolvePath(base: string, path: string): string {
    if (path.startsWith('/')) return normalizePath(path);
    return normalizePath(joinPath(base, path));
  }

  getAllPaths(): string[] {
    return [];
  }

  async chmod(path: string, mode: number): Promise<void> {
    this.dropListingStats();
    return this.trusted(() => this.vfs.chmod(normalizePath(path), mode));
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    this.dropListingStats();
    return this.trusted(async () => {
      await this.vfs.symlink(target, normalizePath(linkPath));
    });
  }

  async link(_existingPath: string, _newPath: string): Promise<void> {
    throw new Error('Hard links not supported in VirtualFS');
  }

  async readlink(path: string): Promise<string> {
    return this.trusted(async () => {
      return this.vfs.readlink(normalizePath(path));
    });
  }

  async realpath(path: string): Promise<string> {
    return this.trusted(async () => {
      return this.vfs.realpath(normalizePath(path));
    });
  }

  async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    this.dropListingStats();
    return this.trusted(() => this.vfs.utimes(normalizePath(path), atime, mtime));
  }

  invalidatePaths(paths: string[]): void {
    this.dropListingStats();
    const vfs = this.vfs as { invalidatePaths?: (paths: string[]) => void };
    if (vfs.invalidatePaths) {
      vfs.invalidatePaths(paths);
    }
  }
}
