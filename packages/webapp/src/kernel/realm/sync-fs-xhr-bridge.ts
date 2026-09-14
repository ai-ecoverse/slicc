import { SYNC_FS_ROUTE_BASE } from './sync-fs-wire.js';
import { type SyncXhrRequest, synchronify, synchronifyJson, syncXhrError } from './sync-xhr.js';

const DEFAULT_TIMEOUT_MS = 30000;

export interface SyncFsBridgeStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink?: boolean;
  size: number;
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

type SyncFsRouteOp = 'stat' | 'lstat' | 'readdir' | 'exists' | 'mkdir' | 'rm';

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
): SyncFsXhrMutatingBridge {
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
      const json = synchronifyJson(
        request('GET', path, undefined, 'stat')
      ) as Partial<SyncFsBridgeStat> | null;
      if (
        !json ||
        typeof json.isFile !== 'boolean' ||
        typeof json.isDirectory !== 'boolean' ||
        typeof json.size !== 'number'
      ) {
        throw errnoError('EIO', path);
      }
      return {
        isFile: json.isFile,
        isDirectory: json.isDirectory,
        isSymbolicLink: json.isSymbolicLink,
        size: json.size,
      };
    },
    lstat(path: string): SyncFsBridgeStat {
      const json = synchronifyJson(
        request('GET', path, undefined, 'lstat')
      ) as Partial<SyncFsBridgeStat> | null;
      if (
        !json ||
        typeof json.isFile !== 'boolean' ||
        typeof json.isDirectory !== 'boolean' ||
        typeof json.size !== 'number'
      ) {
        throw errnoError('EIO', path);
      }
      return {
        isFile: json.isFile,
        isDirectory: json.isDirectory,
        isSymbolicLink: json.isSymbolicLink,
        size: json.size,
      };
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
  };
}
