import { EphemeralFdStore } from './ephemeral-fd-store.js';
import type { FsWatchCallback, FsWatchFilter } from './fs-watcher.js';
import type { MountBackend, ReadDirOptions, RefreshReport } from './mount/backend.js';
import type { MountIndexEnv } from './mount-index.js';
import { normalizePath, pathGlobToRegExp } from './path-utils.js';
import type {
  DirEntry,
  FileContent,
  MkdirOptions,
  ReadFileOptions,
  RmOptions,
  Stats,
} from './types.js';
import { FsError } from './types.js';
import { DEV_NULL } from './virtual-device-paths.js';
import type { MetadataUpdate, VirtualFS } from './virtual-fs.js';

export type RestrictedFsWriteEnforcement = 'hard' | 'sudo-delegated';

export type RestrictedReadAccess = 'inside' | 'parent' | 'outside';

export interface RestrictedFsOptions {
  includeMounts?: boolean;
}

interface VirtualDevice {
  stat(): Stats;
  read(options?: ReadFileOptions): FileContent;
  readText(): string;
  write(content: FileContent): void;
}

const VIRTUAL_DEVICES: Record<string, VirtualDevice> = {
  [DEV_NULL]: {
    stat: () => ({ type: 'file', size: 0, mtime: 0, ctime: 0 }),
    read: (options?) => ((options?.encoding ?? 'utf-8') === 'utf-8' ? '' : new Uint8Array(0)),
    readText: () => '',
    write: () => {},
  },
};

const ALWAYS_WRITABLE_PREFIXES = ['/tmp/'];

export class RestrictedFS {
  private readonly ephemeralFds = new EphemeralFdStore();
  private vfs: VirtualFS;
  private allowedPrefixes: string[];
  private readOnlyPrefixes: string[];
  private readGrantPatterns: Array<{ pattern: string; regex: RegExp; ancestorRegexes: RegExp[] }> =
    [];
  private writeEnforcement: RestrictedFsWriteEnforcement;
  private includeMounts: boolean;

  constructor(
    vfs: VirtualFS,
    allowedPaths: string[],
    readOnlyPaths: string[] = [],
    writeEnforcement: RestrictedFsWriteEnforcement = 'hard',
    options: RestrictedFsOptions = {}
  ) {
    this.vfs = vfs;
    const normalize = (p: string) => {
      const n = normalizePath(p);
      return n.endsWith('/') ? n : n + '/';
    };
    this.allowedPrefixes = allowedPaths.map(normalize);
    this.readOnlyPrefixes = readOnlyPaths.map(normalize);
    this.writeEnforcement = writeEnforcement;
    this.includeMounts = options.includeMounts !== false;
  }

  private getAllPrefixes(): string[] {
    const mountPrefixes = this.includeMounts
      ? this.vfs.listMounts().map((p) => (p.endsWith('/') ? p : p + '/'))
      : [];
    return [
      ...this.allowedPrefixes,
      ...this.readOnlyPrefixes,
      ...mountPrefixes,
      ...ALWAYS_WRITABLE_PREFIXES,
    ];
  }

  setReadGrants(patterns: readonly string[]): void {
    this.readGrantPatterns = [];
    for (const pattern of new Set(patterns)) {
      this.addReadGrant(pattern);
    }
  }

  private addReadGrant(pattern: string): void {
    const segments = pattern.split('/');
    const ancestorRegexes: RegExp[] = [];
    for (let i = 1; i < segments.length; i++) {
      ancestorRegexes.push(pathGlobToRegExp(segments.slice(0, i).join('/') || '/'));
    }
    this.readGrantPatterns.push({
      pattern,
      regex: pathGlobToRegExp(pattern),
      ancestorRegexes,
    });
  }

  private matchesReadGrant(path: string): boolean {
    return this.readGrantPatterns.some((grant) => grant.regex.test(path));
  }

  private leadsToReadGrant(path: string): boolean {
    return this.readGrantPatterns.some((grant) =>
      grant.ancestorRegexes.some((regex) => regex.test(path))
    );
  }

  private isAllowed(path: string): boolean {
    const normalized = normalizePath(path);
    const allPrefixes = this.getAllPrefixes();
    return (
      this.matchesReadGrant(normalized) ||
      this.leadsToReadGrant(normalized) ||
      allPrefixes.some(
        (prefix) =>
          normalized === prefix.slice(0, -1) ||
          normalized.startsWith(prefix) ||
          normalized === '/' ||
          prefix.startsWith(normalized + '/')
      )
    );
  }

  private isAllowedStrict(path: string): boolean {
    const normalized = normalizePath(path);
    const allPrefixes = this.getAllPrefixes();
    return (
      this.matchesReadGrant(normalized) ||
      allPrefixes.some(
        (prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix)
      )
    );
  }

  private isWritable(path: string): boolean {
    const normalized = normalizePath(path);
    return [...this.allowedPrefixes, ...ALWAYS_WRITABLE_PREFIXES].some(
      (prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix)
    );
  }

  readAccess(path: string): RestrictedReadAccess {
    if (VIRTUAL_DEVICES[normalizePath(path)] || EphemeralFdStore.handles(path)) return 'inside';
    if (this.isAllowedStrict(path)) return 'inside';
    return this.isAllowed(path) ? 'parent' : 'outside';
  }

  canWrite(path: string): boolean {
    return EphemeralFdStore.handles(path) || this.isWritable(path);
  }

  private checkWrite(path: string): void {
    if (this.writeEnforcement === 'sudo-delegated') return;
    if (!this.isWritable(path)) {
      throw new FsError('EACCES', 'permission denied', normalizePath(path));
    }
  }

  private async resolveAndCheckRead(path: string): Promise<string> {
    try {
      const resolved = await this.vfs.realpath(path);
      if (!this.isAllowedStrict(resolved)) {
        throw new FsError('ENOENT', 'no such file or directory', normalizePath(path));
      }
      return resolved;
    } catch (err) {
      if (err instanceof FsError) throw err;
      throw new FsError('ENOENT', 'no such file or directory', normalizePath(path));
    }
  }

  private async resolveAndCheckWrite(path: string): Promise<string> {
    try {
      const resolved = await this.vfs.realpath(path);
      if (!this.isWritable(resolved) && !this.isSymlinkEscapeAllowed(resolved)) {
        throw new FsError('EACCES', 'permission denied', normalizePath(path));
      }
      return resolved;
    } catch (err) {
      if (err instanceof FsError) throw err;
      throw new FsError('EACCES', 'permission denied', normalizePath(path));
    }
  }

  private isSymlinkEscapeAllowed(_resolved: string): boolean {
    return false;
  }

  private async checkParentRealpathEscape(path: string): Promise<void> {
    const dir = this.vfs.dirname(path);
    const base = this.vfs.basename(path);
    let resolvedDir: string;
    try {
      resolvedDir = await this.vfs.realpath(dir);
    } catch (err) {
      if (err instanceof FsError && err.code === 'EACCES') throw err;

      return;
    }
    const resolvedPath = resolvedDir + '/' + base;
    if (this.isWritable(resolvedPath)) return;
    const symlinkChanged = normalizePath(resolvedDir) !== normalizePath(dir);
    if (this.writeEnforcement === 'sudo-delegated' && !symlinkChanged) return;
    throw new FsError('EACCES', 'permission denied', normalizePath(path));
  }

  getUnderlyingFS(): VirtualFS {
    return this.vfs;
  }

  invalidatePaths(paths: string[]): void {
    this.vfs.invalidatePaths(paths);
  }

  async forgetSidecarConsistency(): Promise<void> {
    await this.vfs.forgetSidecarConsistency();
  }

  async flush(): Promise<void> {
    await this.vfs.flush();
  }

  isPathUnderMount(path: string): boolean {
    return this.vfs.isPathUnderMount(path);
  }

  async readFile(path: string, options?: ReadFileOptions): Promise<FileContent> {
    const devRead = VIRTUAL_DEVICES[normalizePath(path)];
    if (devRead) return devRead.read(options);
    if (EphemeralFdStore.handles(path)) return this.ephemeralFds.read(path, options);
    if (!this.isAllowedStrict(path)) {
      throw new FsError('ENOENT', 'no such file or directory', normalizePath(path));
    }
    const resolved = await this.resolveAndCheckRead(path);
    return this.vfs.readFile(resolved, options);
  }

  async readFileRange(path: string, start: number, end: number): Promise<Uint8Array> {
    if (!this.isAllowedStrict(path)) {
      throw new FsError('ENOENT', 'no such file or directory', normalizePath(path));
    }
    const resolved = await this.resolveAndCheckRead(path);
    return this.vfs.readFileRange(resolved, start, end);
  }

  async getNativeFile(path: string): Promise<File | null> {
    if (VIRTUAL_DEVICES[normalizePath(path)] || EphemeralFdStore.handles(path)) return null;
    if (!this.isAllowedStrict(path)) return null;
    try {
      const resolved = await this.resolveAndCheckRead(path);
      return await this.vfs.getNativeFile(resolved);
    } catch {
      return null;
    }
  }

  async readDir(path: string, opts?: ReadDirOptions): Promise<DirEntry[]> {
    if (!this.isAllowed(path)) return [];

    let resolvedPath = path;
    if (this.isAllowedStrict(path)) {
      try {
        resolvedPath = await this.resolveAndCheckRead(path);
      } catch {
        return [];
      }
    }
    const entries = await this.vfs.readDir(resolvedPath, opts);

    if (!this.isAllowedStrict(path)) {
      const normalized = normalizePath(path);
      return entries.filter((e) => {
        const childPath = normalized === '/' ? `/${e.name}` : `${normalized}/${e.name}`;
        return this.isAllowed(childPath);
      });
    }
    return entries;
  }

  async stat(path: string): Promise<Stats> {
    const dev = VIRTUAL_DEVICES[normalizePath(path)];
    if (dev) return dev.stat();
    if (EphemeralFdStore.handles(path)) return this.ephemeralFds.stat(path);
    if (!this.isAllowed(path)) {
      throw new FsError('ENOENT', 'no such file or directory', normalizePath(path));
    }
    if (this.isAllowedStrict(path)) {
      const resolved = await this.resolveAndCheckRead(path);
      return this.vfs.stat(resolved);
    }
    return this.vfs.stat(path);
  }

  private scanPathForSymlinks(path: string, includeLeaf: boolean): boolean | null {
    const normalized = normalizePath(path);
    if (normalized === '/') return false;
    const segs = normalized.slice(1).split('/');
    const limit = includeLeaf ? segs.length : segs.length - 1;
    let current = '';
    for (let i = 0; i < limit; i++) {
      current = current + '/' + segs[i];
      const s = this.vfs.lstatSync(current);
      if (s === null) {
        return null;
      }
      if (s.type === 'symlink') return true;
    }
    return false;
  }

  statSync(path: string): Stats | null {
    const dev = VIRTUAL_DEVICES[normalizePath(path)];
    if (dev) return dev.stat();

    if (EphemeralFdStore.handles(path)) {
      return this.ephemeralFds.has(path) ? this.ephemeralFds.stat(path) : null;
    }
    if (!this.isAllowedStrict(path)) return null;

    const scan = this.scanPathForSymlinks(path, true);
    if (scan !== false) return null;
    return this.vfs.statSync(path);
  }

  lstatSync(path: string): Stats | null {
    const dev = VIRTUAL_DEVICES[normalizePath(path)];
    if (dev) return dev.stat();
    if (EphemeralFdStore.handles(path)) {
      return this.ephemeralFds.has(path) ? this.ephemeralFds.stat(path) : null;
    }
    if (!this.isAllowed(path)) return null;
    const scan = this.scanPathForSymlinks(path, false);
    if (scan !== false) return null;
    return this.vfs.lstatSync(path);
  }

  readDirSync(path: string): DirEntry[] | null {
    if (!this.isAllowed(path)) return null;

    const scan = this.scanPathForSymlinks(path, true);
    if (scan !== false) return null;
    const fast = this.vfs.readDirSync(path);
    if (fast === null) return null;
    if (this.isAllowedStrict(path)) return fast;

    const base = normalizePath(path);
    return fast.filter((e) => {
      const child = base === '/' ? `/${e.name}` : `${base}/${e.name}`;
      return this.isAllowed(child);
    });
  }

  async realpath(path: string): Promise<string> {
    if (EphemeralFdStore.handles(path)) {
      const normalized = normalizePath(path);
      if (!this.ephemeralFds.has(normalized)) {
        throw new FsError('ENOENT', 'no such file or directory', normalized);
      }
      return normalized;
    }
    let resolved: string;
    try {
      resolved = await this.vfs.realpath(path);
    } catch (err) {
      if (err instanceof FsError) throw err;
      throw new FsError('ENOENT', 'no such file or directory', normalizePath(path));
    }
    if (!this.isAllowedStrict(resolved)) {
      throw new FsError('ENOENT', 'no such file or directory', normalizePath(path));
    }
    return resolved;
  }

  async exists(path: string): Promise<boolean> {
    if (VIRTUAL_DEVICES[normalizePath(path)]) return true;
    if (EphemeralFdStore.handles(path)) return this.ephemeralFds.has(path);
    if (!this.isAllowed(path)) return false;
    if (this.isAllowedStrict(path)) {
      try {
        await this.resolveAndCheckRead(path);
      } catch {
        return false;
      }
    }
    return this.vfs.exists(path);
  }

  async readTextFile(path: string): Promise<string> {
    const devText = VIRTUAL_DEVICES[normalizePath(path)];
    if (devText) return devText.readText();
    if (EphemeralFdStore.handles(path)) return this.ephemeralFds.readText(path);
    if (!this.isAllowedStrict(path)) {
      throw new FsError('ENOENT', 'no such file or directory', normalizePath(path));
    }
    const resolved = await this.resolveAndCheckRead(path);
    return this.vfs.readTextFile(resolved);
  }

  async *walk(path: string): AsyncGenerator<string> {
    if (!this.isAllowed(path)) return;
    let resolvedBase = path;
    if (this.isAllowedStrict(path)) {
      try {
        resolvedBase = await this.resolveAndCheckRead(path);
      } catch {
        return;
      }
    }
    for await (const filePath of this.vfs.walk(resolvedBase)) {
      if (this.isAllowed(filePath)) {
        yield filePath;
      }
    }
  }

  async writeFile(
    path: string,
    content: FileContent,
    options?: { recursive?: boolean }
  ): Promise<void> {
    const devWrite = VIRTUAL_DEVICES[normalizePath(path)];
    if (devWrite) {
      devWrite.write(content);
      return;
    }

    if (EphemeralFdStore.handles(path)) {
      this.ephemeralFds.write(path, content);
      return;
    }
    await this.checkContentWrite(path);
    return this.vfs.writeFile(path, content, options);
  }

  async appendFile(path: string, content: FileContent): Promise<void> {
    const devWrite = VIRTUAL_DEVICES[normalizePath(path)];
    if (devWrite) {
      devWrite.write(content);
      return;
    }
    if (EphemeralFdStore.handles(path)) {
      this.ephemeralFds.append(path, content);
      return;
    }
    await this.checkContentWrite(path);
    return this.vfs.appendFile(path, content);
  }

  async chmod(path: string, mode: number): Promise<void> {
    this.refuseDescriptorTreeOp(path);
    await this.checkContentWrite(path);
    return this.vfs.chmod(path, mode);
  }

  async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    this.refuseDescriptorTreeOp(path);
    await this.checkContentWrite(path);
    return this.vfs.utimes(path, atime, mtime);
  }

  async updateMetadataBatch(updates: readonly MetadataUpdate[]): Promise<void> {
    for (const update of updates) {
      this.refuseDescriptorTreeOp(update.path);
      await this.checkContentWrite(update.path);
    }
    return this.vfs.updateMetadataBatch(updates);
  }

  private async checkContentWrite(path: string): Promise<void> {
    this.checkWrite(path);
    await this.checkParentRealpathEscape(path);

    try {
      const destStat = await this.vfs.lstat(path);
      if (destStat.type === 'symlink') {
        await this.resolveAndCheckWrite(path);
      }
    } catch (err) {
      if (err instanceof FsError && err.code === 'EACCES') throw err;
    }
  }

  private refuseDescriptorTreeOp(path: string): void {
    if (EphemeralFdStore.handles(path)) {
      throw new FsError('EACCES', 'permission denied', normalizePath(path));
    }
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    this.refuseDescriptorTreeOp(path);
    this.checkWrite(path);
    await this.checkParentRealpathEscape(path);
    return this.vfs.mkdir(path, options);
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    if (EphemeralFdStore.handles(path)) {
      if (!this.ephemeralFds.remove(path)) {
        throw new FsError('ENOENT', 'no such file or directory', normalizePath(path));
      }
      return;
    }
    this.checkWrite(path);

    try {
      const st = await this.vfs.lstat(path);
      if (st.type === 'symlink') {
      } else {
        await this.resolveAndCheckWrite(path);
      }
    } catch (err) {
      if (err instanceof FsError && err.code === 'EACCES') throw err;
    }
    return this.vfs.rm(path, options);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    this.refuseDescriptorTreeOp(oldPath);
    this.refuseDescriptorTreeOp(newPath);
    this.checkWrite(oldPath);
    this.checkWrite(newPath);

    await this.resolveAndCheckWrite(oldPath);
    await this.checkParentRealpathEscape(newPath);
    return this.vfs.rename(oldPath, newPath);
  }

  async copyFile(src: string, dest: string): Promise<void> {
    if (EphemeralFdStore.handles(src)) {
      const content = this.ephemeralFds.read(src, { encoding: 'binary' });
      await this.writeFile(dest, content);
      return;
    }
    if (EphemeralFdStore.handles(dest)) {
      if (!this.isAllowed(src)) {
        throw new FsError('ENOENT', 'no such file or directory', normalizePath(src));
      }
      const resolvedSource = await this.resolveAndCheckRead(src);
      this.ephemeralFds.write(
        dest,
        await this.vfs.readFile(resolvedSource, { encoding: 'binary' })
      );
      return;
    }

    if (!this.isAllowed(src)) {
      throw new FsError('ENOENT', 'no such file or directory', normalizePath(src));
    }
    this.checkWrite(dest);

    const resolvedSrc = await this.resolveAndCheckRead(src);
    await this.checkParentRealpathEscape(dest);

    try {
      const destStat = await this.vfs.lstat(dest);
      if (destStat.type === 'symlink') {
        await this.resolveAndCheckWrite(dest);
      }
    } catch (err) {
      if (err instanceof FsError && err.code === 'EACCES') throw err;
    }
    return this.vfs.copyFile(resolvedSrc, dest);
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    this.refuseDescriptorTreeOp(linkPath);
    this.checkWrite(linkPath);
    await this.checkParentRealpathEscape(linkPath);
    return this.vfs.symlink(target, linkPath);
  }

  async readlink(path: string): Promise<string> {
    if (!this.isAllowedStrict(path)) {
      throw new FsError('ENOENT', 'no such file or directory', normalizePath(path));
    }
    const target = await this.vfs.readlink(path);

    let absoluteTarget: string;
    if (target.startsWith('/')) {
      absoluteTarget = normalizePath(target);
    } else {
      const linkDir = this.vfs.dirname(path);
      absoluteTarget = normalizePath(linkDir + '/' + target);
    }
    if (!this.isAllowedStrict(absoluteTarget)) {
      throw new FsError('ENOENT', 'no such file or directory', normalizePath(path));
    }
    return target;
  }

  async lstat(path: string): Promise<Stats> {
    const dev = VIRTUAL_DEVICES[normalizePath(path)];
    if (dev) return dev.stat();

    if (EphemeralFdStore.handles(path)) return this.ephemeralFds.stat(path);
    if (!this.isAllowed(path)) {
      throw new FsError('ENOENT', 'no such file or directory', normalizePath(path));
    }

    const normalized = normalizePath(path);
    const dir = this.vfs.dirname(normalized);
    const base = this.vfs.basename(normalized);
    let resolvedDir: string;
    if (dir === normalized) {
      resolvedDir = dir;
    } else {
      try {
        resolvedDir = await this.vfs.realpath(dir);
      } catch {
        throw new FsError('ENOENT', 'no such file or directory', normalized);
      }
    }
    const resolved = resolvedDir === '/' ? `/${base}` : `${resolvedDir}/${base}`;
    if (!this.isAllowed(resolved)) {
      throw new FsError('ENOENT', 'no such file or directory', normalized);
    }
    return this.vfs.lstat(resolved);
  }

  watch(basePath: string, filter: FsWatchFilter, callback: FsWatchCallback): () => void {
    if (!this.isAllowed(basePath)) {
      throw new FsError('EACCES', 'permission denied', normalizePath(basePath));
    }
    const watcher = this.vfs.getWatcher();
    if (!watcher) {
      throw new FsError('EINVAL', 'no watcher configured');
    }
    return watcher.watch(normalizePath(basePath), filter, callback);
  }

  dirname(path: string): string {
    return this.vfs.dirname(path);
  }

  basename(path: string): string {
    return this.vfs.basename(path);
  }

  async mount(
    absolutePath: string,
    backend: MountBackend,
    opts?: { env?: MountIndexEnv }
  ): Promise<void> {
    this.refuseDescriptorTreeOp(absolutePath);
    this.checkWrite(absolutePath);
    await this.checkParentRealpathEscape(absolutePath);
    return this.vfs.mount(absolutePath, backend, opts);
  }

  async unmount(absolutePath: string): Promise<void> {
    this.refuseDescriptorTreeOp(absolutePath);
    this.checkWrite(absolutePath);
    await this.checkParentRealpathEscape(absolutePath);
    return this.vfs.unmount(absolutePath);
  }

  listMounts(): string[] {
    const all = this.vfs.listMounts();
    if (this.includeMounts) return all;

    return all.filter((p) => this.isAllowedStrict(p));
  }

  listMountPoints(): ReturnType<VirtualFS['listMountPoints']> {
    const all = this.vfs.listMountPoints();
    if (this.includeMounts) return all;
    return all.filter((m) => this.isAllowed(m.path));
  }

  getMountIndex(): ReturnType<VirtualFS['getMountIndex']> {
    return this.vfs.getMountIndex();
  }

  async refreshMount(
    absolutePath: string,
    opts?: { bodies?: boolean; env?: MountIndexEnv }
  ): Promise<RefreshReport> {
    this.refuseDescriptorTreeOp(absolutePath);
    this.checkWrite(absolutePath);
    return this.vfs.refreshMount(absolutePath, opts);
  }

  async dispose(): Promise<void> {
    await this.vfs.dispose();
  }
}
