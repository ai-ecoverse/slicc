import { SYNC_FS_ROUTE_BASE } from './sync-fs-wire.js';
import { type SyncXhrRequest, synchronify, synchronifyJson, syncXhrError } from './sync-xhr.js';

const DEFAULT_TIMEOUT_MS = 30000;

export interface SyncFsBridgeStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink?: boolean;
  size: number;

  mode?: number;

  mtimeMs?: number;
}

export interface SyncFsXhrBridge {
  readFile(path: string): Uint8Array;
  writeFile(path: string, bytes: Uint8Array): void;
  stat(path: string): SyncFsBridgeStat;
  lstat(path: string): SyncFsBridgeStat;
  readdir(path: string): string[];
  exists(path: string): boolean;
}

export interface SyncFsXhrMutatingBridge extends SyncFsXhrBridge {
  mkdir(path: string): void;

  rm(path: string): void;
}

export interface SyncFsPosixBridge extends SyncFsXhrMutatingBridge {
  rename(from: string, to: string): void;
  unlink(path: string): void;
  rmdir(path: string): void;

  symlink(target: string, linkPath: string): void;
  readlink(path: string): string;
  chmod(path: string, mode: number): void;
  utimes(path: string, atimeMs: number, mtimeMs: number): void;
}

export interface SyncFsPosixArgs {
  arg2?: string;
  mode?: number;
  atimeMs?: number;
  mtimeMs?: number;
}

export function parseSyncFsStat(json: unknown): SyncFsBridgeStat | null {
  const s = json as Partial<SyncFsBridgeStat> | null;
  if (
    !s ||
    typeof s.isFile !== 'boolean' ||
    typeof s.isDirectory !== 'boolean' ||
    typeof s.size !== 'number'
  ) {
    return null;
  }
  return {
    isFile: s.isFile,
    isDirectory: s.isDirectory,
    isSymbolicLink: s.isSymbolicLink,
    size: s.size,
    ...(typeof s.mode === 'number' ? { mode: s.mode } : {}),
    ...(typeof s.mtimeMs === 'number' ? { mtimeMs: s.mtimeMs } : {}),
  };
}

type SyncFsRouteOp =
  | 'stat'
  | 'lstat'
  | 'readdir'
  | 'exists'
  | 'readlink'
  | 'mkdir'
  | 'rm'
  | 'rename'
  | 'unlink'
  | 'rmdir'
  | 'symlink'
  | 'chmod'
  | 'utimes';

function errnoError(code: string, path: string): Error & { code: string } {
  return syncXhrError(code, `sync-fs bridge, '${path}'`);
}

function routeUrl(path: string, op?: SyncFsRouteOp): string {
  const abs = path.startsWith('/') ? path : `/${path}`;

  const base = SYNC_FS_ROUTE_BASE + abs.split('/').map(encodeURIComponent).join('/');
  return op ? `${base}?op=${op}` : base;
}

export function createSyncFsXhrBridge(
  token: string,
  opts: { timeoutMs?: number } = {}
): SyncFsPosixBridge {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  function request(
    method: 'GET' | 'POST',
    path: string,
    body?: Uint8Array,
    op?: SyncFsRouteOp
  ): SyncXhrRequest {
    return {
      method,
      url: routeUrl(path, op),
      token,
      ...(body ? { body } : {}),
      timeoutMs,
      label: `sync-fs bridge, '${path}'`,
    };
  }

  return {
    readFile(path: string): Uint8Array {
      return synchronify(request('GET', path));
    },
    writeFile(path: string, bytes: Uint8Array): void {
      synchronify(request('POST', path, bytes));
    },
    stat(path: string): SyncFsBridgeStat {
      const st = parseSyncFsStat(synchronifyJson(request('GET', path, undefined, 'stat')));
      if (!st) throw errnoError('EIO', path);
      return st;
    },
    lstat(path: string): SyncFsBridgeStat {
      const st = parseSyncFsStat(synchronifyJson(request('GET', path, undefined, 'lstat')));
      if (!st) throw errnoError('EIO', path);
      return st;
    },
    readdir(path: string): string[] {
      const json = synchronifyJson(request('GET', path, undefined, 'readdir'));
      if (!Array.isArray(json) || !json.every((s) => typeof s === 'string')) {
        throw errnoError('EIO', path);
      }
      return json as string[];
    },
    exists(path: string): boolean {
      const json = synchronifyJson(request('GET', path, undefined, 'exists'));
      if (typeof json !== 'boolean') throw errnoError('EIO', path);
      return json;
    },
    mkdir(path: string): void {
      synchronify(request('POST', path, undefined, 'mkdir'));
    },
    rm(path: string): void {
      synchronify(request('POST', path, undefined, 'rm'));
    },
    rename(from: string, to: string): void {
      synchronify(request('POST', from, posixBody({ arg2: to }), 'rename'));
    },
    unlink(path: string): void {
      synchronify(request('POST', path, posixBody({}), 'unlink'));
    },
    rmdir(path: string): void {
      synchronify(request('POST', path, posixBody({}), 'rmdir'));
    },
    symlink(target: string, linkPath: string): void {
      synchronify(request('POST', linkPath, posixBody({ arg2: target }), 'symlink'));
    },
    readlink(path: string): string {
      const json = synchronifyJson(request('GET', path, undefined, 'readlink'));
      if (typeof json !== 'string') throw errnoError('EIO', path);
      return json;
    },
    chmod(path: string, mode: number): void {
      synchronify(request('POST', path, posixBody({ mode }), 'chmod'));
    },
    utimes(path: string, atimeMs: number, mtimeMs: number): void {
      synchronify(request('POST', path, posixBody({ atimeMs, mtimeMs }), 'utimes'));
    },
  };
}

function posixBody(args: SyncFsPosixArgs): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(args));
}
