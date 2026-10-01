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
import type { DirEntry, MetadataUpdate, Stats, VirtualFS } from '../fs/index.js';
import { FsError, joinPath, normalizePath, statsFromDirEntry } from '../fs/index.js';
import { consumeCachedBinary } from './binary-cache.js';
import {
  DEFAULT_IDENTITY,
  identityFile,
  identityFileNames,
  isMissing,
  type ShellIdentity,
} from './identity-files.js';
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

function binAlias(normalized: string): string {
  if (normalized === '/bin') return '/usr/bin';
  return normalized.startsWith('/bin/') ? `/usr${normalized}` : normalized;
}

function withIdentityNames(dir: string, names: string[]): string[] {
  const missing = identityFileNames(dir).filter((n) => !names.includes(n));
  return missing.length ? [...names, ...missing].sort() : names;
}

function withIdentityDirents(dir: string, entries: DirentEntry[]): DirentEntry[] {
  const missing = identityFileNames(dir).filter((n) => !entries.some((e) => e.name === n));
  if (!missing.length) return entries;
  const extra = missing.map((name) => ({
    name,
    isFile: true,
    isDirectory: false,
    isSymbolicLink: false,
  }));
  return [...entries, ...extra].sort((a, b) => a.name.localeCompare(b.name));
}

export class VfsAdapter implements IFileSystem {
  private registeredCommandsFn: (() => string[]) | null = null;
  private identityFn: (() => ShellIdentity) | null = null;

  private readonly listingStats = new Map<string, { stats: Stats; at: number }>();
  private readonly listingStatsMax: number;
  private readonly listingStatsTtlMs: number;

  constructor(
    private vfs: VirtualFS,
    opts?: VfsAdapterOptions
  ) {
    this.listingStatsMax = Math.max(1, opts?.listingStatsMax ?? MAX_LISTING_STATS);
    this.listingStatsTtlMs = opts?.listingStatsTtlMs ?? LISTING_STAT_TTL_MS;

    this.updateMetadataBatch = this.updateMetadataBatch.bind(this);
    this.symlinkBatch = this.symlinkBatch.bind(this);
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

  setIdentityFn(fn: () => ShellIdentity): void {
    this.identityFn = fn;
  }

  private identityFile(normalized: string): Uint8Array | undefined {
    return identityFile(normalized, this.identityFn?.() ?? DEFAULT_IDENTITY);
  }

  private getVirtualBinCommands(): string[] {
    return this.registeredCommandsFn?.() ?? [];
  }

  private virtualUsrStat(path: string): FsStat | null {
    const normalized = binAlias(path);
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
      const bytes = await this.readRaw(normalized);
      const encoding = fileEncoding(options);
      const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(encoding);

      if (encoding !== 'hex' && encoding !== 'base64') parkReadBytes(text, bytes);
      return text;
    });
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    return this.trusted(() => this.readRaw(normalizePath(path)));
  }

  private async readRaw(normalized: string): Promise<Uint8Array> {
    let content: string | Uint8Array;
    try {
      content = await this.vfs.readFile(normalized, { encoding: 'binary' });
    } catch (e) {
      const synthetic = this.identityFile(normalized);
      if (synthetic && isMissing(e)) return synthetic;
      throw e;
    }
    return content instanceof Uint8Array ? content : new TextEncoder().encode(content as string);
  }

  private identityStat(normalized: string, err: unknown): FsStat | undefined {
    const synthetic = this.identityFile(normalized);
    if (!synthetic || !isMissing(err)) return undefined;
    return {
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
      mode: 0o644,
      size: synthetic.length,
      mtime: new Date(0),
    };
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
      return (await this.vfs.exists(normalized)) || this.identityFile(normalized) !== undefined;
    });
  }

  async stat(path: string): Promise<FsStat> {
    return this.trusted(async () => {
      const normalized = normalizePath(path);
      try {
        return await this.statVfs(normalized);
      } catch (e) {
        const synthetic = this.identityStat(normalized, e);
        if (synthetic) return synthetic;
        throw e;
      }
    });
  }

  private async statVfs(normalized: string): Promise<FsStat> {
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
  }

  async lstat(path: string): Promise<FsStat> {
    return this.trusted(async () => {
      const normalized = normalizePath(path);
      try {
        return await this.lstatVfs(normalized);
      } catch (e) {
        const synthetic = this.identityStat(normalized, e);
        if (synthetic) return synthetic;
        throw e;
      }
    });
  }

  private async lstatVfs(normalized: string): Promise<FsStat> {
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
      if (binAlias(normalized) === '/usr/bin') return this.getVirtualBinCommands().slice().sort();

      const fast = this.vfs.readDirSync(normalized);
      if (fast !== null)
        return withIdentityNames(
          normalized,
          fast.map((e) => e.name)
        );

      const entries = await this.vfs.readDir(normalized, { includeStats: true });
      this.primeListingStats(normalized, entries);
      return withIdentityNames(
        normalized,
        entries.map((e) => e.name)
      );
    });
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    return this.trusted(async () => {
      const normalized = normalizePath(path);
      if (normalized === '/usr') {
        return [{ name: 'bin', isFile: false, isDirectory: true, isSymbolicLink: false }];
      }
      if (binAlias(normalized) === '/usr/bin') {
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
        return withIdentityDirents(normalized, this.mapFastEntriesToDirents(fastEntries));
      }

      const entries = await this.vfs.readDir(normalized, { includeStats: true });
      this.primeListingStats(normalized, entries);
      return withIdentityDirents(normalized, this.mapAsyncEntriesToDirents(entries));
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
      let stat: Stats;
      try {
        stat = await this.vfs.stat(normalizedSrc);
      } catch (e) {
        const synthetic = this.identityFile(normalizedSrc);
        if (!synthetic || !isMissing(e)) throw e;
        await this.vfs.writeFile(normalizedDest, synthetic);
        return;
      }

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

    const names = new Set(entries.map((e) => e.name));
    for (const name of identityFileNames(src)) {
      const synthetic = names.has(name) ? undefined : this.identityFile(joinPath(src, name));
      if (synthetic) await this.vfs.writeFile(joinPath(dest, name), synthetic);
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

  async updateMetadataBatch(updates: readonly MetadataUpdate[]): Promise<void> {
    this.dropListingStats();
    return this.trusted(() =>
      this.vfs.updateMetadataBatch(
        updates.map((update) => ({ ...update, path: normalizePath(update.path) }))
      )
    );
  }

  async symlinkBatch(links: ReadonlyArray<{ target: string; path: string }>): Promise<void> {
    this.dropListingStats();
    return this.trusted(() =>
      this.vfs.symlinkBatch(
        links.map((link) => ({ target: link.target, path: normalizePath(link.path) }))
      )
    );
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

  async forgetSidecarConsistency(): Promise<void> {
    const vfs = this.vfs as { forgetSidecarConsistency?: () => Promise<void> };
    await vfs.forgetSidecarConsistency?.();
  }
}
