import { acceptPathLikeArgs, type PathArgLayout } from './fs-path-arg.js';
import { createNoFdOps, createStdioFdOps, type StdioFdOps } from './realm-fs-stdio-fd.js';
import type { RealmRpcClient } from './realm-rpc.js';
import { normalizePath, type SyncFsCache } from './sync-fs-cache.js';
import type { SyncFsXhrBridge, SyncFsXhrMutatingBridge } from './sync-fs-xhr-bridge.js';

type GlobalWithBuffer = typeof globalThis & {
  Buffer?: { from: (data: Uint8Array) => unknown };
};

function realmBuffer(): GlobalWithBuffer['Buffer'] {
  return (globalThis as GlobalWithBuffer).Buffer;
}

export interface RealmStdioBridge {
  readStdinBytes(): Uint8Array;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
}

export function latin1ToBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function bytesToLatin1(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return out;
}

function ebadfErr(verb: string, target: unknown): Error & { code: string } {
  return Object.assign(new Error(`EBADF: bad file descriptor, ${verb} ${String(target)}`), {
    code: 'EBADF',
  });
}

function isDevStdioPath(path: unknown): path is '/dev/stdin' | '/dev/stdout' | '/dev/stderr' {
  return path === '/dev/stdin' || path === '/dev/stdout' || path === '/dev/stderr';
}

function stdioFdFor(pathOrFd: unknown): 0 | 1 | 2 | undefined {
  if (pathOrFd === 0 || pathOrFd === '/dev/stdin') return 0;
  if (pathOrFd === 1 || pathOrFd === '/dev/stdout') return 1;
  if (pathOrFd === 2 || pathOrFd === '/dev/stderr') return 2;
  return undefined;
}

function isStdioReadTarget(pathOrFd: unknown, verb: string): boolean {
  const fd = stdioFdFor(pathOrFd);
  if (fd === 0) return true;
  if (fd !== undefined || typeof pathOrFd === 'number') throw ebadfErr(verb, pathOrFd);
  return false;
}

function stdioWriteSink(
  stdio: RealmStdioBridge,
  pathOrFd: unknown,
  verb: string
): ((text: string) => void) | undefined {
  const fd = stdioFdFor(pathOrFd);
  if (fd === 1) return stdio.writeStdout;
  if (fd === 2) return stdio.writeStderr;
  if (fd !== undefined || typeof pathOrFd === 'number') throw ebadfErr(verb, pathOrFd);
  return undefined;
}

function stdioText(data: unknown): string {
  return typeof data === 'string' ? data : bytesToLatin1(toBytes(data));
}

function decodeFileBytes(bytes: Uint8Array, encoding: string | null | undefined): unknown {
  if (encoding === 'utf8' || encoding === 'utf-8') return new TextDecoder().decode(bytes);
  const B = realmBuffer();
  return B ? B.from(bytes) : bytes;
}

function encodingOf(
  opts: string | { encoding?: string | null } | null | undefined
): string | null | undefined {
  return typeof opts === 'string' ? opts : opts?.encoding;
}

function devStdioStat() {
  return {
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
    isCharacterDevice: () => true,
    size: 0,
  };
}

interface AsyncStdioTargets {
  readFile(path: string, opts?: string | { encoding?: string | null } | null): Promise<unknown>;
  readFileBinary(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: unknown): Promise<true>;
  writeFileBinary(path: string, bytes: Uint8Array): Promise<true>;
  appendFile(path: string, data: unknown): Promise<void>;
  access(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ isDirectory: boolean; isFile: boolean; size: number }>;
}

function overlayAsyncStdio(bridge: AsyncStdioTargets, stdio: RealmStdioBridge | undefined): void {
  if (!stdio) return;
  const base = {
    readFile: bridge.readFile,
    readFileBinary: bridge.readFileBinary,
    writeFile: bridge.writeFile,
    writeFileBinary: bridge.writeFileBinary,
    appendFile: bridge.appendFile,
    access: bridge.access,
    exists: bridge.exists,
    stat: bridge.stat,
  };
  bridge.readFile = async (path, opts) => {
    if (!isStdioReadTarget(path, 'read')) return base.readFile(path, opts);
    const encoding = encodingOf(opts);
    if (encoding === null || encoding === 'buffer') {
      const B = realmBuffer();
      const bytes = stdio.readStdinBytes();
      return B ? B.from(bytes) : bytes;
    }
    return new TextDecoder().decode(stdio.readStdinBytes());
  };
  bridge.readFileBinary = async (path) =>
    isStdioReadTarget(path, 'read') ? stdio.readStdinBytes() : base.readFileBinary(path);
  bridge.writeFile = async (path, data) => {
    const sink = stdioWriteSink(stdio, path, 'write');
    if (!sink) return base.writeFile(path, data);
    sink(stdioText(data));
    return true;
  };
  bridge.writeFileBinary = async (path, bytes) => {
    const sink = stdioWriteSink(stdio, path, 'write');
    if (!sink) return base.writeFileBinary(path, bytes);
    sink(bytesToLatin1(bytes));
    return true;
  };
  bridge.appendFile = async (path, data) => {
    const sink = stdioWriteSink(stdio, path, 'append');
    if (!sink) return base.appendFile(path, data);
    sink(stdioText(data));
  };
  bridge.access = async (path) => {
    if (!isDevStdioPath(path)) return base.access(path);
  };
  bridge.exists = async (path) => isDevStdioPath(path) || base.exists(path);
  bridge.stat = async (path) =>
    isDevStdioPath(path) ? { isFile: true, isDirectory: false, size: 0 } : base.stat(path);
}

export function createFsBridge(
  rpc: RealmRpcClient,
  realmFetch: (input: string | URL | Request, opts?: RequestInit) => Promise<Response>,
  stdio?: RealmStdioBridge
) {
  function toBytes(data: unknown): Uint8Array {
    if (data instanceof Uint8Array) return data;
    if (ArrayBuffer.isView(data)) {
      const v = data as ArrayBufferView;
      return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    }
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    return new TextEncoder().encode(typeof data === 'string' ? data : String(data));
  }

  async function readFile(
    path: string,
    opts?: string | { encoding?: string | null } | null
  ): Promise<unknown> {
    const encoding = typeof opts === 'string' ? opts : opts?.encoding;

    if (encoding === null || encoding === 'buffer') {
      const bytes = await rpc.call<Uint8Array>('vfs', 'readFileBinary', [path]);
      const B = realmBuffer();
      return B ? B.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)) : bytes;
    }
    return rpc.call('vfs', 'readFile', [path]);
  }

  async function writeFile(path: string, data: unknown): Promise<true> {
    if (typeof data === 'string') {
      return rpc.call('vfs', 'writeFile', [path, data]);
    }
    return rpc.call('vfs', 'writeFileBinary', [path, toBytes(data)]);
  }

  async function appendFile(path: string, data: unknown): Promise<void> {
    if (typeof data === 'string') {
      await rpc.call('vfs', 'appendFile', [path, data]);
      return;
    }
    await rpc.call('vfs', 'appendFile', [path, toBytes(data)]);
  }

  async function cp(src: string, dest: string, opts?: { recursive?: boolean }): Promise<void> {
    const srcStat = await rpc.call<{ isDirectory: boolean; isFile: boolean; size: number }>(
      'vfs',
      'stat',
      [src]
    );
    if (srcStat.isFile) {
      const bytes = await rpc.call<Uint8Array>('vfs', 'readFileBinary', [src]);
      await rpc.call('vfs', 'writeFileBinary', [dest, bytes]);
      return;
    }
    if (!srcStat.isDirectory || !opts?.recursive) {
      throw new Error(`cp: '${src}' is a directory (use {recursive: true})`);
    }
    await mkdirSafe(dest);
    const entries = await rpc.call<string[]>('vfs', 'readDir', [src]);
    for (const entry of entries) {
      await cp(`${src}/${entry}`, `${dest}/${entry}`, opts);
    }
  }

  async function rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<true> {
    if (opts?.force) {
      const exists = await rpc.call<boolean>('vfs', 'exists', [path]);
      if (!exists) return true;
    }
    const stat = await rpc.call<{ isDirectory: boolean; isFile: boolean; size: number }>(
      'vfs',
      'stat',
      [path]
    );
    if (stat.isFile) return rpc.call('vfs', 'rm', [path]);
    if (!opts?.recursive) throw new Error(`rm: '${path}' is a directory (use {recursive: true})`);
    const entries = await rpc.call<string[]>('vfs', 'readDir', [path]);
    for (const entry of entries) {
      await rm(`${path}/${entry}`, opts);
    }
    return rpc.call('vfs', 'rm', [path]);
  }

  async function mkdirSafe(path: string): Promise<void> {
    await rpc.call('vfs', 'mkdir', [path]);
  }

  async function mkdtemp(prefix: string): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const suffix =
        Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
      const path = `${prefix}${suffix}`;
      const exists = await rpc.call<boolean>('vfs', 'exists', [path]);
      if (!exists) {
        await rpc.call('vfs', 'mkdir', [path]);
        return path;
      }
    }
    throw new Error('mkdtemp: failed to create unique directory after 5 attempts');
  }

  async function rename(oldPath: string, newPath: string): Promise<void> {
    try {
      await rpc.call('vfs', 'rename', [oldPath, newPath]);
    } catch {
      const bytes = await rpc.call<Uint8Array>('vfs', 'readFileBinary', [oldPath]);
      await rpc.call('vfs', 'writeFileBinary', [newPath, bytes]);
      await rpc.call('vfs', 'rm', [oldPath]);
    }
  }

  async function access(path: string): Promise<void> {
    const exists = await rpc.call<boolean>('vfs', 'exists', [path]);
    if (!exists)
      throw Object.assign(new Error(`ENOENT: no such file or directory, access '${path}'`), {
        code: 'ENOENT',
      });
  }

  const bridge = {
    readFile,
    readFileBinary: (path: string): Promise<Uint8Array> =>
      rpc.call('vfs', 'readFileBinary', [path]),
    writeFile,
    writeFileBinary: (path: string, bytes: Uint8Array): Promise<true> =>
      rpc.call('vfs', 'writeFileBinary', [path, bytes]),
    appendFile,
    cp,
    rm,
    readDir: (path: string): Promise<string[]> => rpc.call('vfs', 'readDir', [path]),
    readdir: (path: string): Promise<string[]> => rpc.call('vfs', 'readDir', [path]),
    exists: (path: string): Promise<boolean> => rpc.call('vfs', 'exists', [path]),
    stat: (path: string): Promise<{ isDirectory: boolean; isFile: boolean; size: number }> =>
      rpc.call('vfs', 'stat', [path]),
    mkdir: (path: string, _opts?: { recursive?: boolean }): Promise<true> =>
      rpc.call('vfs', 'mkdir', [path]),
    mkdtemp,
    rename,
    access,
    unlink: (path: string): Promise<true> => rpc.call('vfs', 'rm', [path]),
    rmdir: (path: string): Promise<true> => rpc.call('vfs', 'rm', [path]),
    copyFile: async (src: string, dest: string): Promise<void> => {
      const bytes = await rpc.call<Uint8Array>('vfs', 'readFileBinary', [src]);
      await rpc.call('vfs', 'writeFileBinary', [dest, bytes]);
    },
    fetchToFile: async (url: string, path: string): Promise<number> => {
      const response = await realmFetch(url);
      if (!response.ok) throw new Error(`fetch ${response.status} ${response.statusText}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      await rpc.call('vfs', 'writeFileBinary', [path, bytes]);
      return bytes.byteLength;
    },
    promises: null as unknown,
  };
  overlayAsyncStdio(bridge, stdio);
  acceptPathLikeArgs(bridge, ASYNC_PATH_ARGS, { promises: true });
  bridge.promises = bridge;
  return bridge;
}

const ASYNC_PATH_ARGS: { [K in keyof ReturnType<typeof createFsBridge>]?: PathArgLayout } = {
  readFile: 'fd',
  readFileBinary: 'fd',
  writeFile: 'fd',
  writeFileBinary: 'fd',
  appendFile: 'fd',
  cp: 'pair',
  rm: 'path',
  readDir: 'path',
  readdir: 'path',
  exists: 'path',
  stat: 'path',
  mkdir: 'path',
  mkdtemp: 'path',
  rename: 'pair',
  access: 'path',
  unlink: 'path',
  rmdir: 'path',
  copyFile: 'pair',
  fetchToFile: 'second',
};

const SYNC_PATH_ARGS: { [K in keyof ReturnType<typeof createSyncFsBridge>]?: PathArgLayout } = {
  readFileSync: 'fd',
  writeFileSync: 'fd',
  appendFileSync: 'fd',
  truncateSync: 'path',
  existsSync: 'path',
  accessSync: 'path',
  mkdirSync: 'path',
  statSync: 'path',
  lstatSync: 'path',
  realpathSync: 'path',
  readdirSync: 'path',
  copyFileSync: 'pair',
  cpSync: 'pair',
  chmodSync: 'path',
  mkdtempSync: 'path',
  rmSync: 'path',
  rmdirSync: 'path',
  unlinkSync: 'path',
  renameSync: 'pair',
};

function syncFsErr(code: string, resolved: string, verb = ''): Error & { code: string } {
  return Object.assign(new Error(`${code}: sync-fs, ${verb ? `${verb} ` : ''}'${resolved}'`), {
    code,
  });
}

function removeWithBridgeFallback(
  syncFs: SyncFsCache,
  bridge: SyncFsXhrBridge | undefined,
  resolved: string,
  opts: { recursive?: boolean; requireFile?: boolean } = {},
  persistDelete?: (path: string) => void
): boolean {
  const recursive = opts.recursive === true;
  try {
    if (opts.requireFile) syncFs.unlink(resolved);
    else syncFs.rm(resolved, recursive);
    persistDelete?.(resolved);
    return true;
  } catch (err) {
    if ((err as { code?: string })?.code !== 'ENOENT') throw err;
  }
  const mutating = bridge as SyncFsXhrMutatingBridge | undefined;
  if (!mutating?.rm || syncFs.isTombstoned(resolved)) return false;
  try {
    if (!mutating.exists(resolved)) return false;
  } catch {
    return false;
  }
  mutating.rm(resolved);
  syncFs.markRemoved(resolved, recursive);
  return true;
}

interface RemovalDeps {
  syncFs: SyncFsCache;
  bridge: SyncFsXhrBridge | undefined;
  persistDelete?: (path: string) => void;
  resolve: (p: string) => string;
  existsResolved: (resolved: string) => boolean;
  statResolved: (resolved: string) => {
    isFile: boolean;
    isDirectory: boolean;
    isSymbolicLink?: boolean;
    size: number;
  };
  lstatResolved: (resolved: string) => {
    isFile: boolean;
    isDirectory: boolean;
    isSymbolicLink?: boolean;
    size: number;
  };
  readBytes: (resolved: string) => Uint8Array;
  writeThrough: (resolved: string, bytes: Uint8Array) => void;
}

function createRemovalOps(deps: RemovalDeps) {
  const {
    syncFs,
    bridge,
    resolve,
    existsResolved,
    lstatResolved,
    statResolved,
    readBytes,
    writeThrough,
    persistDelete,
  } = deps;
  const remove = (resolved: string, opts?: { recursive?: boolean; requireFile?: boolean }) =>
    removeWithBridgeFallback(syncFs, bridge, resolved, opts, persistDelete);
  return {
    rmSync(path: string, opts?: { recursive?: boolean; force?: boolean }): void {
      const resolved = resolve(path);

      if (opts?.force && !existsResolved(resolved)) return;
      if (!remove(resolved, { recursive: opts?.recursive === true }) && !opts?.force) {
        throw syncFsErr('ENOENT', resolved, 'rm');
      }
    },
    rmdirSync(path: string, opts?: { recursive?: boolean }): void {
      const resolved = resolve(path);

      if (existsResolved(resolved) && !lstatResolved(resolved).isDirectory) {
        throw syncFsErr('ENOTDIR', resolved, 'rmdir');
      }
      if (!remove(resolved, { recursive: opts?.recursive === true })) {
        throw syncFsErr('ENOENT', resolved, 'rmdir');
      }
    },
    unlinkSync(path: string): void {
      const resolved = resolve(path);
      if (!remove(resolved, { requireFile: true })) throw syncFsErr('ENOENT', resolved, 'unlink');
    },
    renameSync(oldPath: string, newPath: string): void {
      const src = resolve(oldPath);
      const dest = resolve(newPath);
      try {
        syncFs.rename(src, dest);
        return;
      } catch (err) {
        if ((err as { code?: string })?.code !== 'ENOENT') throw err;
      }

      if (!bridge || syncFs.isTombstoned(src)) throw syncFsErr('ENOENT', src, 'rename');
      if (statResolved(src).isDirectory) throw syncFsErr('EISDIR', src, 'rename');
      writeThrough(dest, readBytes(src));
      if (!remove(src, { requireFile: true })) throw syncFsErr('ENOENT', src, 'rename');
    },
  };
}

interface SyncStatLike {
  isFile: () => boolean;
  isDirectory: () => boolean;
  isSymbolicLink: () => boolean;
  size: number;
}

interface SyncStdioTargets extends StdioFdOps {
  readFileSync(path: string, opts?: string | { encoding?: string | null } | null): unknown;
  writeFileSync(path: string, data: unknown): void;
  appendFileSync(path: string, data: unknown): void;
  existsSync(path: string): boolean;
  accessSync(path: string): void;
  statSync(path: string): SyncStatLike;
  lstatSync(path: string): SyncStatLike;
}

function overlaySyncStdio(ops: SyncStdioTargets, stdio: RealmStdioBridge | undefined): void {
  if (!stdio) return;
  const base = {
    readFileSync: ops.readFileSync,
    writeFileSync: ops.writeFileSync,
    appendFileSync: ops.appendFileSync,
    existsSync: ops.existsSync,
    accessSync: ops.accessSync,
    statSync: ops.statSync,
    lstatSync: ops.lstatSync,
  };
  ops.readFileSync = (path, opts) =>
    isStdioReadTarget(path, 'read')
      ? decodeFileBytes(stdio.readStdinBytes(), encodingOf(opts))
      : base.readFileSync(path, opts);
  ops.writeFileSync = (path, data) => {
    const sink = stdioWriteSink(stdio, path, 'write');
    if (sink) sink(stdioText(data));
    else base.writeFileSync(path, data);
  };
  ops.appendFileSync = (path, data) => {
    const sink = stdioWriteSink(stdio, path, 'append');
    if (sink) sink(stdioText(data));
    else base.appendFileSync(path, data);
  };
  ops.existsSync = (path) => isDevStdioPath(path) || base.existsSync(path);
  ops.accessSync = (path) => {
    if (!isDevStdioPath(path)) base.accessSync(path);
  };
  ops.statSync = (path) => (isDevStdioPath(path) ? devStdioStat() : base.statSync(path));
  ops.lstatSync = (path) => (isDevStdioPath(path) ? devStdioStat() : base.lstatSync(path));
  Object.assign(ops, createStdioFdOps(stdio));
}

function overlayReaddir(
  dir: string,
  cached: string[],
  live: string[],
  isTombstoned: (path: string) => boolean
): string[] {
  const child = (name: string) => (dir === '/' ? `/${name}` : `${dir}/${name}`);
  const names = new Set(live);
  for (const name of cached) names.add(name);
  for (const name of names) if (isTombstoned(child(name))) names.delete(name);
  return [...names];
}

function readdirFromCacheOrBridge(
  syncFs: SyncFsCache,
  bridge: SyncFsXhrBridge | undefined,
  resolved: string
): string[] {
  const dead = (p: string) => syncFs.isTombstoned(p);
  try {
    const cached = syncFs.readdir(resolved);
    if (!bridge || !syncFs.isPartial(resolved) || dead(resolved)) return cached;
    try {
      return overlayReaddir(resolved, cached, bridge.readdir(resolved), dead);
    } catch (e) {
      if ((e as { code?: string })?.code === 'ENOENT') return cached;
      throw e;
    }
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (!bridge || dead(resolved) || code !== 'ENOENT') throw err;
    return overlayReaddir(resolved, [], bridge.readdir(resolved), dead);
  }
}

function toBytes(data: unknown): Uint8Array {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) {
    const v = data as ArrayBufferView;
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }
  return new TextEncoder().encode(String(data));
}

export type PersistSyncHooks = {
  write?: (path: string, bytes: Uint8Array) => void;
  delete?: (path: string) => void;
};

function writeThroughCacheOrBridge(
  syncFs: SyncFsCache,
  bridge: SyncFsXhrBridge | undefined,
  persist: PersistSyncHooks | undefined,
  resolved: string,
  bytes: Uint8Array
): void {
  if (bridge) {
    bridge.writeFile(resolved, bytes);
    syncFs.commitWrite(resolved, bytes);
  } else {
    syncFs.writeFile(resolved, bytes);
    persist?.write?.(resolved, bytes);
  }
}

export function createSyncFsBridge(
  syncFs: SyncFsCache,
  cwd: string,
  bridge?: SyncFsXhrBridge,
  stdio?: RealmStdioBridge,
  persist?: PersistSyncHooks
) {
  function resolve(p: string): string {
    return normalizePath(p.startsWith('/') ? p : cwd + (cwd.endsWith('/') ? '' : '/') + p);
  }

  function readBytes(resolved: string): Uint8Array {
    try {
      return syncFs.readFile(resolved);
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (bridge && !syncFs.isTombstoned(resolved) && (code === 'ENOENT' || code === 'ENOSYNC')) {
        return bridge.readFile(resolved);
      }
      throw err;
    }
  }
  const writeThrough = (resolved: string, bytes: Uint8Array): void =>
    writeThroughCacheOrBridge(syncFs, bridge, persist, resolved, bytes);
  function existsResolved(resolved: string): boolean {
    if (syncFs.exists(resolved)) return true;

    if (!bridge || syncFs.isTombstoned(resolved)) return false;
    try {
      return bridge.exists(resolved);
    } catch {
      return false;
    }
  }
  function statResolved(resolved: string): {
    isFile: boolean;
    isDirectory: boolean;
    isSymbolicLink?: boolean;
    size: number;
  } {
    try {
      return syncFs.stat(resolved);
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (!bridge || syncFs.isTombstoned(resolved) || code !== 'ENOENT') throw err;
      return bridge.stat(resolved);
    }
  }

  function lstatResolved(resolved: string) {
    try {
      return syncFs.lstat(resolved);
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (!bridge || syncFs.isTombstoned(resolved) || code !== 'ENOENT') throw err;
      return bridge.lstat(resolved);
    }
  }
  const wrapStat = (s: {
    isFile: boolean;
    isDirectory: boolean;
    isSymbolicLink?: boolean;
    size: number;
  }) => ({
    isFile: () => s.isFile,
    isDirectory: () => s.isDirectory,
    isSymbolicLink: () => s.isSymbolicLink === true,
    isCharacterDevice: () => false,
    size: s.size,
  });
  const join = (dir: string, name: string) => (dir === '/' ? `/${name}` : `${dir}/${name}`);

  function copyTree(srcR: string, destR: string): void {
    if (!statResolved(srcR).isDirectory) {
      writeThrough(destR, readBytes(srcR));
      return;
    }
    syncFs.mkdir(destR, true);
    for (const name of readdirFromCacheOrBridge(syncFs, bridge, srcR))
      copyTree(join(srcR, name), join(destR, name));
  }

  const ops = {
    ...createRemovalOps({
      syncFs,
      bridge,
      persistDelete: persist?.delete,
      resolve,
      existsResolved,
      statResolved,
      lstatResolved,
      readBytes,
      writeThrough,
    }),
    readFileSync(path: string, opts?: string | { encoding?: string | null } | null): unknown {
      return decodeFileBytes(readBytes(resolve(path)), encodingOf(opts));
    },
    writeFileSync(path: string, data: unknown): void {
      writeThrough(resolve(path), toBytes(data));
    },
    appendFileSync(path: string, data: unknown): void {
      const resolved = resolve(path);
      let existing: Uint8Array = new Uint8Array(0);
      try {
        existing = readBytes(resolved);
      } catch (err) {
        if ((err as { code?: string })?.code !== 'ENOENT') throw err;
      }
      const suffix = toBytes(data);
      const out = new Uint8Array(existing.byteLength + suffix.byteLength);
      out.set(existing);
      out.set(suffix, existing.byteLength);
      writeThrough(resolved, out);
    },
    truncateSync(path: string, len = 0): void {
      const resolved = resolve(path);
      const cur = readBytes(resolved);
      const out = new Uint8Array(len);
      out.set(cur.subarray(0, Math.min(len, cur.byteLength)));
      writeThrough(resolved, out);
    },
    existsSync(path: string): boolean {
      return existsResolved(resolve(path));
    },
    accessSync(path: string): void {
      const resolved = resolve(path);
      if (!existsResolved(resolved)) throw syncFsErr('ENOENT', resolved, 'access');
    },
    mkdirSync(path: string, opts?: { recursive?: boolean }): void {
      syncFs.mkdir(resolve(path), opts?.recursive);
    },
    statSync: (path: string) => wrapStat(statResolved(resolve(path))),
    lstatSync: (path: string) => wrapStat(lstatResolved(resolve(path))),
    realpathSync(path: string): string {
      const resolved = resolve(path);
      if (!existsResolved(resolved)) throw syncFsErr('ENOENT', resolved, 'realpath');
      return resolved;
    },
    readdirSync(path: string): string[] {
      return readdirFromCacheOrBridge(syncFs, bridge, resolve(path));
    },
    copyFileSync(src: string, dest: string): void {
      writeThrough(resolve(dest), readBytes(resolve(src)));
    },
    cpSync(src: string, dest: string): void {
      copyTree(resolve(src), resolve(dest));
    },
    chmodSync(path: string): void {
      const resolved = resolve(path);
      if (!existsResolved(resolved)) throw syncFsErr('ENOENT', resolved, 'chmod');
    },
    mkdtempSync(prefix: string): string {
      return syncFs.mkdtemp(resolve(prefix));
    },
  };
  const withFds = Object.assign(ops, createNoFdOps());
  overlaySyncStdio(withFds, stdio);
  acceptPathLikeArgs(withFds, SYNC_PATH_ARGS);
  const existsSync = withFds.existsSync;

  withFds.existsSync = (path) => {
    try {
      return existsSync(path);
    } catch {
      return false;
    }
  };
  return withFds;
}
